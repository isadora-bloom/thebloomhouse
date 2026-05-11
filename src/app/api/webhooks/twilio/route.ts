/**
 * /api/webhooks/twilio  — Wave 29 (multi-channel inbox: SMS ingestion)
 *
 * Twilio Messaging POSTs every inbound SMS as
 * `application/x-www-form-urlencoded`. Fields we care about:
 *   - MessageSid     unique message id (idempotency key)
 *   - From           E.164 sender phone
 *   - To             E.164 receiver phone (looked up in
 *                    multi_channel_inbox_settings.twilio_phone_numbers)
 *   - Body           message body
 *   - NumMedia       count of MMS attachments
 *
 * The route is env-var-guarded — if TWILIO_AUTH_TOKEN isn't set we return
 * 503 with `{ error: 'sms_not_configured' }`. Real signature verification
 * happens via verifyTwilioSignature; no "trust the from-header" shortcut.
 *
 * Idempotency: twilio_webhook_log has a UNIQUE on MessageSid (mig 295);
 * a retried delivery returns 200 with no second interaction insert.
 *
 * Identity resolution: phone-based match through the canonical resolver
 * (resolveIdentity from src/lib/services/identity/resolver.ts). On a fresh
 * SMS from an unknown number the resolver mints a new person + wedding.
 * The author_class defaults to 'couple' for real-looking inbound texts;
 * outbound texts (from a venue-own phone) flip direction='outbound'
 * + author_class='operator' (Sage's auto-SMS doesn't ship in Wave 29).
 *
 * Surface = 'voice_capture' so the row lands in /agent/audio-inbox
 * alongside Omi + Zoom transcripts — that's the unified "non-email
 * conversation" triage surface per Wave 28+29.
 *
 * Always responds with empty TwiML <Response></Response> on success
 * (Twilio expects XML when handler returns 200; anything non-2xx
 * triggers Twilio's retry storm).
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyTwilioSignature } from '@/lib/services/sms/twilio-signature'
import { resolveIdentity } from '@/lib/services/identity/resolver'
import { enqueueIdentityReconstruction } from '@/lib/services/identity/enqueue-reconstruction'

const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

function twimlResponse(status = 200): NextResponse {
  return new NextResponse(TWIML_OK, {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

interface VenueLookup {
  venueId: string
  direction: 'inbound' | 'outbound'
}

/**
 * Find which venue owns the To phone number AND decide direction.
 *
 * Inbound (couple → venue): To matches a row in twilio_phone_numbers, From does not.
 * Outbound (venue → couple): From matches a row in twilio_phone_numbers (couple replied to a venue-own
 *   number that was forwarded back, or the venue used a different Twilio
 *   number that's still registered). Rare but legal — we treat as outbound.
 *
 * Returns null when neither side matches a known venue phone.
 */
async function locateVenueAndDirection(
  supabase: ReturnType<typeof createServiceClient>,
  fromPhone: string,
  toPhone: string,
): Promise<VenueLookup | null> {
  // Look up any venue that has either phone in its registered list.
  // Twilio normalises to E.164; we still compare verbatim because the
  // operator types their numbers in E.164 in the settings page too.
  const { data, error } = await supabase
    .from('multi_channel_inbox_settings')
    .select('venue_id, twilio_phone_numbers, sms_enabled')
    .eq('sms_enabled', true)
    .or(`twilio_phone_numbers.cs.{${toPhone}},twilio_phone_numbers.cs.{${fromPhone}}`)
    .limit(2)

  if (error) {
    console.error('[webhook/twilio] venue lookup failed:', error.message)
    return null
  }
  if (!data || data.length === 0) return null

  // If To matches → inbound. Else if From matches → outbound.
  for (const row of data) {
    const nums = (row.twilio_phone_numbers as string[] | null) ?? []
    if (nums.includes(toPhone)) {
      return { venueId: row.venue_id as string, direction: 'inbound' }
    }
  }
  for (const row of data) {
    const nums = (row.twilio_phone_numbers as string[] | null) ?? []
    if (nums.includes(fromPhone)) {
      return { venueId: row.venue_id as string, direction: 'outbound' }
    }
  }
  return null
}

export async function POST(request: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    return jsonError('sms_not_configured', 503)
  }

  const correlationId = randomUUID()

  // Twilio POSTs form-urlencoded. Parse via formData() and rebuild a
  // plain Record for signature verification + downstream use.
  let formParams: Record<string, string>
  try {
    const form = await request.formData()
    formParams = {}
    for (const [k, v] of form.entries()) {
      formParams[k] = typeof v === 'string' ? v : ''
    }
  } catch (err) {
    console.error('[webhook/twilio] body parse failed:', err)
    return jsonError('bad_payload', 400)
  }

  // ---- Signature verification ----
  // Twilio's signature is computed against the EXACT URL Twilio called,
  // including protocol + host + path + query string. NextRequest.url is
  // the canonical full URL.
  const signatureHeader = request.headers.get('x-twilio-signature')
  const fullUrl = request.url
  const ok = verifyTwilioSignature(fullUrl, formParams, signatureHeader, authToken)
  if (!ok) {
    console.warn('[webhook/twilio] signature verification failed', {
      correlationId,
      hasHeader: Boolean(signatureHeader),
      messageSid: formParams.MessageSid,
    })
    return jsonError('invalid_signature', 401)
  }

  const messageSid = formParams.MessageSid
  const fromPhone = formParams.From
  const toPhone = formParams.To
  const body = formParams.Body ?? ''
  const numMedia = parseInt(formParams.NumMedia ?? '0', 10)

  if (!messageSid || !fromPhone || !toPhone) {
    return jsonError('missing_required_fields', 400)
  }

  const supabase = createServiceClient()

  // ---- Idempotency: have we seen this MessageSid before? ----
  // twilio_webhook_log has UNIQUE(message_sid). We try to insert first;
  // duplicate-key error tells us this is a retry.
  const { data: existingLog } = await supabase
    .from('twilio_webhook_log')
    .select('id, interaction_id')
    .eq('message_sid', messageSid)
    .maybeSingle()
  if (existingLog) {
    console.log('[webhook/twilio] duplicate MessageSid, idempotent ack', {
      messageSid,
      existingInteractionId: existingLog.interaction_id,
    })
    return twimlResponse(200)
  }

  // ---- Locate the owning venue ----
  const lookup = await locateVenueAndDirection(supabase, fromPhone, toPhone)
  if (!lookup) {
    // No venue claims either phone. We still log the webhook for audit so
    // an operator who forgot to add their number can see it landed; no
    // interaction is created.
    await supabase.from('twilio_webhook_log').insert({
      venue_id: null,
      message_sid: messageSid,
      from_phone: fromPhone,
      to_phone: toPhone,
      body,
      num_media: Number.isFinite(numMedia) ? numMedia : 0,
      raw_payload: formParams,
      interaction_id: null,
    })
    console.warn('[webhook/twilio] no venue matches To/From; logged without interaction', {
      messageSid,
      toPhone,
      fromPhone,
    })
    return twimlResponse(200)
  }

  const { venueId, direction } = lookup

  // ---- Identity resolution ----
  // For inbound, the couple is From; for outbound, the couple is To.
  const couplePhone = direction === 'inbound' ? fromPhone : toPhone
  let personId: string | null = null
  let weddingId: string | null = null
  try {
    const resolved = await resolveIdentity(
      venueId,
      {
        email: null,
        phone: couplePhone,
        fullName: null,
        weddingDate: null,
        partner1Name: null,
        partner2Name: null,
      },
      {
        sourceLabel: 'twilio_sms',
        correlationId,
        supabase,
        inquirySignalAt: new Date().toISOString(),
      },
    )
    personId = resolved.personId
    weddingId = resolved.weddingId
  } catch (err) {
    // Identity resolution should never crash the route — record the
    // webhook anyway so coordinator audit can backfill manually.
    console.error('[webhook/twilio] identity resolve failed; continuing without person/wedding:', err)
  }

  // ---- Insert interaction ----
  // author_class heuristic: a real-looking text from the couple is 'couple';
  // outbound (venue-own → couple) is 'operator'. We don't run Haiku here
  // — the Wave 27 author-classifier is email-only at the moment.
  const authorClass = direction === 'outbound' ? 'operator' : 'couple'

  const timestampIso = new Date().toISOString()
  const { data: interaction, error: interactionErr } = await supabase
    .from('interactions')
    .insert({
      venue_id: venueId,
      wedding_id: weddingId,
      person_id: personId,
      type: 'sms',
      direction,
      subject: null,
      body_preview: body.slice(0, 300),
      full_body: body,
      from_email: null,
      from_name: null,
      timestamp: timestampIso,
      correlation_id: correlationId,
      author_class: authorClass,
      surface: 'voice_capture',
      signal_class: 'touchpoint',
    })
    .select('id')
    .single()

  if (interactionErr || !interaction) {
    console.error('[webhook/twilio] interaction insert failed:', interactionErr?.message)
    // Still log the webhook so a retry / manual replay can pick it up.
    await supabase.from('twilio_webhook_log').insert({
      venue_id: venueId,
      message_sid: messageSid,
      from_phone: fromPhone,
      to_phone: toPhone,
      body,
      num_media: Number.isFinite(numMedia) ? numMedia : 0,
      raw_payload: formParams,
      interaction_id: null,
    })
    return twimlResponse(200)
  }

  // ---- Persist the webhook log row (now with interaction_id) ----
  const { error: logErr } = await supabase.from('twilio_webhook_log').insert({
    venue_id: venueId,
    message_sid: messageSid,
    from_phone: fromPhone,
    to_phone: toPhone,
    body,
    num_media: Number.isFinite(numMedia) ? numMedia : 0,
    raw_payload: formParams,
    interaction_id: interaction.id,
  })
  if (logErr) {
    // Race on the UNIQUE(message_sid) — another concurrent delivery wrote
    // first. Not fatal; the interaction is already in place.
    console.warn('[webhook/twilio] webhook_log insert failed (likely race):', logErr.message)
  }

  // ---- Lifecycle signal + identity reconstruction ----
  // Fire-and-forget. Inbound SMS from a couple is signal for the lifecycle
  // engine + Wave 4 reconstruction loop.
  if (weddingId && direction === 'inbound') {
    void (async () => {
      try {
        const { recordSmsLifecycleSignal } = await import(
          '@/lib/services/lifecycle/state-machine'
        )
        await recordSmsLifecycleSignal({
          supabase,
          venueId,
          weddingId: weddingId!,
          direction: 'inbound',
          body,
        })
      } catch (err) {
        console.warn('[webhook/twilio] lifecycle signal hook failed (non-fatal):', err)
      }
    })()
    void enqueueIdentityReconstruction({
      weddingId,
      venueId,
      triggerSignal: 'sms_received',
    }).catch((err) =>
      console.warn('[webhook/twilio] reconstruction enqueue failed (non-fatal):', err),
    )
  }

  console.log('[webhook/twilio] processed', {
    correlationId,
    venueId,
    interactionId: interaction.id,
    direction,
    messageSid,
  })

  return twimlResponse(200)
}

/**
 * GET responds 405 so a misconfigured Twilio console (HTTP method set to
 * GET) surfaces clearly instead of silently 404ing.
 */
export async function GET() {
  return jsonError('method_not_allowed', 405)
}
