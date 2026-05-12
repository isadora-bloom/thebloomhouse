/**
 * Bloom House — Inbound intent classifier.
 *
 * Why this exists (Anja Putman / RM-1152, 2026-05-12):
 * Bloom currently assumes every inbound is a potentially-new inquiry
 * until proven otherwise. Anja's post-booking logistics chatter on
 * behalf of her daughter Kajlie minted a fresh wedding, scored heat=99,
 * and queued sequence drafts inviting her on a tour.
 *
 * The fix is one classifier that runs on every inbound (email, SMS,
 * call transcript, voicemail, Zoom transcript, brain-dump note) and
 * writes structured intent + an optional referenced couple name onto
 * interactions. Downstream consumers (heat scoring, Sage drafts,
 * sequence triggers, family-member-proxy resolver) read this instead
 * of re-inferring per-call.
 *
 * Mirror of inbound-haiku-classifier.ts (P5). Same fire-and-forget
 * post-insert + cron-drain pattern, just a different classifier.
 */

import { callAIJson, type ContentTier } from '@/lib/ai/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'

export const INBOUND_INTENT_PROMPT_VERSION = 'inbound-intent.v1'

export type IntentClass =
  | 'new_inquiry'
  | 'inquiry_followup'
  | 'client_logistics'
  | 'client_emotional'
  | 'family_member_proxy'
  | 'vendor_communication'
  | 'vendor_outreach'
  | 'spam_outreach'
  | 'auto_reply'
  | 'coordinator_internal'
  | 'unknown'

/**
 * Intents that should NEVER fire heat for a wedding. The Anja class
 * (logistics / vendor / spam / auto-reply / internal) accidentally
 * generated heat=99 on RM-1152 because every inbound got the default
 * +8 sms_received treatment. When the classifier verdicts one of these,
 * we retroactively zero the engagement_events points on this
 * interaction so the heat-view recompute reflects reality.
 *
 * client_emotional + family_member_proxy DO fire heat — they're real
 * post-booking signals that belong on the wedding's heat trajectory.
 * (Family-member-proxy gets resolved to the booked couple's wedding
 * via checkpoint 6, so the heat lands on the right row.)
 */
const NON_COUPLE_INTENTS: ReadonlySet<IntentClass> = new Set<IntentClass>([
  'client_logistics',
  'vendor_communication',
  'vendor_outreach',
  'spam_outreach',
  'auto_reply',
  'coordinator_internal',
])

const VALID_INTENT_CLASSES: ReadonlySet<IntentClass> = new Set([
  'new_inquiry',
  'inquiry_followup',
  'client_logistics',
  'client_emotional',
  'family_member_proxy',
  'vendor_communication',
  'vendor_outreach',
  'spam_outreach',
  'auto_reply',
  'coordinator_internal',
  'unknown',
])

export interface IntentVerdict {
  intent_class: IntentClass
  referenced_couple_name: string | null
  note: string | null
}

export interface ClassifyIntentInput {
  interactionId: string
  body: string | null | undefined
  subject: string | null | undefined
  venueId: string
  /** Channel hint helps the classifier interpret the body shape (e.g. SMS
   *  bodies are casual / fragmented; email bodies have signatures). */
  channel: 'email' | 'sms' | 'call' | 'voicemail' | 'meeting' | 'brain_dump' | 'web_form' | 'other'
  supabase?: SupabaseClient
  correlationId?: string | null
}

const FALLBACK: IntentVerdict = {
  intent_class: 'unknown',
  referenced_couple_name: null,
  note: null,
}

const SYSTEM_PROMPT = `You are a forensic classifier reading one inbound communication to a wedding venue. Your job is to identify WHAT the inbound is — not who it's from or how to respond.

Return ONLY a JSON object with exactly these three keys:

{
  "intent_class": one of the 11 classes below,
  "referenced_couple_name": string | null,
  "note": string | null
}

== Intent classes ==

new_inquiry
  A prospective couple making FIRST contact. They're shopping for a venue.
  Signals: "is your venue available", "we're getting married in [date]",
  generic discovery questions, no prior context, first-name introductions
  ("Hi I'm Sarah and my fiance and I are looking..."). Calendly tour
  bookings from new email addresses also count.

inquiry_followup
  An existing inquiry-stage couple replying or following up. Same shape
  as new_inquiry but the language assumes prior conversation ("just
  checking in", "any update on the date").

client_logistics
  A BOOKED couple (or family member acting on their behalf) handling
  post-booking operations. Vocabulary is the giveaway:
    - garland, tablecloths, table sizes (132 vs 142), drop-off, delivery,
      rentals, "the rehearsal", "this weekend's wedding", set-up,
      vendor names (Sammy's, the florist), package deliveries,
      "did X come by", "we left X at the venue", floor plans, ribbon
      ties, chandeliers.
    - References to next weekend / this weekend / past weekend with
      possessive ("our wedding", "the wedding") imply the booking is
      already real.

client_emotional
  A booked couple sharing personal context, stress, planning concerns,
  family dynamics. Distinguished from logistics by emotional content
  (worried, grateful, asking for reassurance) rather than ops details.

family_member_proxy
  Someone OTHER than the booked couple, contacting on their behalf.
  Strong signals:
    - "This is [Name], [couple-name]'s mom / dad / planner / coordinator"
    - "Hi I'm [Name], I'm helping with [couple-name]'s wedding"
    - Different name in body than in From / phone. Helper role explicit.
  When this fires, extract the REFERENCED couple's first name into
  referenced_couple_name. Example: "This is Anja, Kajlie's mom" →
  referenced_couple_name = "Kajlie".

vendor_communication
  A vendor (florist, photographer, DJ, planner, baker, rental company,
  caterer, officiant) coordinating with the venue about a SPECIFIC
  couple's wedding. Their email signature or phrasing identifies them
  as a vendor: "this is [Name] from [Company]", "we'll be delivering",
  "we're shooting [couple's] wedding".
  When the referenced couple is named, extract into referenced_couple_name.

vendor_outreach
  A vendor or service pitching themselves to the venue. NOT about a
  specific couple. "We're a new florist in the area", "would love to
  introduce ourselves", "we offer professional photography for venues".

spam_outreach
  Generic business pitches not related to the venue's wedding operations.
  "Marketing services", "SEO outreach", cold solicitations,
  unsolicited investment / partnership pitches, lead-generation tools.

auto_reply
  Out-of-office, vacation responder, "do not reply", bounce-back
  messages, no-reply transactional confirmations from couples'
  third-party accounts.

coordinator_internal
  Venue staff (Isadora, assistants) communicating with the venue's own
  email / AI / forwarding to themselves. Includes test messages and
  any inbound that's actually outbound-from-venue routed back.

unknown
  Use sparingly. Only when the body genuinely doesn't fit ANY of the
  above — extremely short messages, garbled text, or ambiguous shapes
  the model genuinely cannot disambiguate. Default to most-likely class
  when reasonable; reserve unknown for true uncertainty.

== referenced_couple_name ==

Extract ONLY when the body explicitly names an existing couple the
sender is contacting on behalf of (family_member_proxy or
vendor_communication classes). Use the first name in possessive form:
  "Kajlie's mom" → "Kajlie"
  "Sarah and Tom's wedding" → "Sarah and Tom"
  "the Henderson wedding" → "Henderson"
For all other classes, return null.

== note ==

One short sentence (<=200 chars) explaining the call. Audit only;
coordinator may read this to understand why a row was classified the
way it was. Don't quote PII verbatim; describe the signal.

Output ONLY the JSON object. No markdown, no commentary.`

interface RawVerdict {
  intent_class?: unknown
  referenced_couple_name?: unknown
  note?: unknown
}

function normalize(raw: RawVerdict): IntentVerdict | null {
  const cls = typeof raw?.intent_class === 'string' ? raw.intent_class.toLowerCase() : ''
  if (!VALID_INTENT_CLASSES.has(cls as IntentClass)) return null
  const referenced =
    typeof raw?.referenced_couple_name === 'string' && raw.referenced_couple_name.trim()
      ? raw.referenced_couple_name.trim().slice(0, 120)
      : null
  const note =
    typeof raw?.note === 'string' && raw.note.trim()
      ? raw.note.trim().slice(0, 500)
      : null
  return {
    intent_class: cls as IntentClass,
    referenced_couple_name: referenced,
    note,
  }
}

/**
 * Run the intent classifier on one inbound interaction. Idempotent:
 * skipped when intent_classified_at IS NOT NULL. NEVER throws.
 */
export async function classifyInboundIntent(
  input: ClassifyIntentInput,
): Promise<IntentVerdict> {
  const { interactionId, venueId, channel, correlationId } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!interactionId || !venueId) return FALLBACK

  // Idempotency gate.
  try {
    const { data: existing } = await supabase
      .from('interactions')
      .select('intent_classified_at, intent_class, intent_referenced_couple_name, intent_classifier_note')
      .eq('id', interactionId)
      .single()
    if (existing?.intent_classified_at) {
      return {
        intent_class: (existing.intent_class as IntentClass) ?? FALLBACK.intent_class,
        referenced_couple_name:
          (existing.intent_referenced_couple_name as string | null) ?? null,
        note: (existing.intent_classifier_note as string | null) ?? null,
      }
    }
  } catch {
    // Soft-fail the precheck.
  }

  const subject = (input.subject ?? '').slice(0, 500)
  const body = (input.body ?? '').slice(0, 6000)
  if (!body.trim() && !subject.trim()) return FALLBACK

  const userPrompt = `CHANNEL: ${channel}\nSUBJECT: ${subject || '(none)'}\n\nBODY:\n${body || '(empty)'}`

  let raw: RawVerdict
  try {
    raw = await callAIJson<RawVerdict>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 300,
      temperature: 0.2,
      venueId,
      taskType: 'inbound_intent_classify',
      tier: 'haiku',
      contentTier: 2 as ContentTier,
      promptVersion: INBOUND_INTENT_PROMPT_VERSION,
      correlationId: correlationId ?? undefined,
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'inbound_intent ai call failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.classify',
      outcome: 'fail',
      data: {
        interactionId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return FALLBACK
  }

  const verdict = normalize(raw)
  if (!verdict) {
    logEvent({
      level: 'warn',
      msg: 'inbound_intent invalid verdict',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.classify',
      outcome: 'fail',
      data: {
        interactionId,
        sample: JSON.stringify(raw).slice(0, 300),
      },
    })
    return FALLBACK
  }

  try {
    await supabase
      .from('interactions')
      .update({
        intent_class: verdict.intent_class,
        intent_referenced_couple_name: verdict.referenced_couple_name,
        intent_classifier_note: verdict.note,
        intent_classified_at: new Date().toISOString(),
      })
      .eq('id', interactionId)
      .is('intent_classified_at', null)
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'inbound_intent persist failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.classify',
      outcome: 'fail',
      data: {
        interactionId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return verdict
  }

  // Heat suppression: when intent is in the non-couple set, zero the
  // points on this interaction's engagement_events. The heat-as-view
  // (mig 316) sums points * decay; setting points=0 makes the row
  // invisible to the trajectory without losing the audit history.
  //
  // Fire-and-forget — failure here doesn't unwind the classification.
  // The cron drain (when it lands) can re-attempt suppression on rows
  // that missed.
  if (NON_COUPLE_INTENTS.has(verdict.intent_class)) {
    void (async () => {
      try {
        const { error: suppErr } = await supabase
          .from('engagement_events')
          .update({ points: 0 })
          .filter('metadata->>interaction_id', 'eq', interactionId)
          .neq('points', 0)
        if (suppErr) {
          logEvent({
            level: 'warn',
            msg: 'inbound_intent suppress failed',
            venueId,
            correlationId: correlationId ?? null,
            actor: 'system',
            event_type: 'inbound_intent.suppress',
            outcome: 'fail',
            data: { interactionId, error: suppErr.message },
          })
        } else {
          logEvent({
            level: 'info',
            msg: 'inbound_intent suppressed heat',
            venueId,
            correlationId: correlationId ?? null,
            actor: 'system',
            event_type: 'inbound_intent.suppress',
            outcome: 'ok',
            data: { interactionId, intent_class: verdict.intent_class },
          })
        }
      } catch (err) {
        logEvent({
          level: 'warn',
          msg: 'inbound_intent suppress threw',
          venueId,
          correlationId: correlationId ?? null,
          actor: 'system',
          event_type: 'inbound_intent.suppress',
          outcome: 'fail',
          data: {
            interactionId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    })()
  }

  logEvent({
    level: 'info',
    msg: 'inbound_intent classified',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'inbound_intent.classify',
    outcome: 'ok',
    data: {
      interactionId,
      channel,
      intent_class: verdict.intent_class,
      referenced_couple_name: verdict.referenced_couple_name,
    },
  })

  return verdict
}
