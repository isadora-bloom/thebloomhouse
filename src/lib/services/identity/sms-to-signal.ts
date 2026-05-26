/**
 * Phase 1 Batch 2 — Pbatch2-1: SMS → NormalizedSignal adapter.
 *
 * Anchor: PHASE-1-BATCH-2.md §2 Pbatch2-1 + §3 phase C T2 + O4.
 *
 * Shared by:
 *  - Twilio webhook (webhooks/twilio/route.ts:~275 — T2 flip)
 *  - OpenPhone cron (ingestion/openphone.ts:~994 — O4 flip when
 *    channel === 'sms')
 *
 * Channel taxonomy
 * ----------------
 * channel = 'sms' — verified used by both call sites (twilio
 * inbound-intent-classifier call passes channel:'sms' at
 * webhooks/twilio/route.ts:347).
 *
 * REVIEW Pbatch2-4 (operator decision):
 *   Pbatch2-4 is the one-channel ('sms') vs three-channel
 *   ('sms'/'phone'/'voicemail') decision for the OpenPhone path. This
 *   builder takes the 'sms'-channel side of that split — Pbatch2-4
 *   covers the OpenPhone non-SMS branch via `voice-to-signal.ts`. If
 *   Pbatch2-4 lands on Option B (special-case 'sms' + new_inquiry
 *   classifier verdict mints couple), it touches `mint-couple.ts`'s
 *   `hasSufficientIdentity`, not this file.
 *
 * action_type / signal_tier
 * -------------------------
 *   direction='inbound'  → action_type='sms_inbound',  tier='high'
 *   direction='outbound' → action_type='sms_outbound', tier='medium'
 *
 * The inbound/outbound tier split mirrors the doctrine baked into
 * `identity/sources/gmail.ts:143-145`:
 *   isInbound ? 'reply' / 'high' : 'venue_sent' / 'medium'
 * (per §3 Don't-skip-#1: "venue sent them a marketing email is not
 * progression").
 *
 * author_class follows the same direction split that
 * `webhooks/twilio/route.ts:~271` already writes to interactions.
 */

import type { NormalizedSignal } from './sources/types'
import { deriveIdentityHint } from './signal-helpers/identity-hint'
import { derivePhoneFields } from './signal-helpers/phone-fields'
import { mergeRawPayload } from './signal-helpers/raw-payload'

export interface SmsToSignalInput {
  /** Signal shape selector. Three modes:
   *   - 'inbound'  → action_type='sms_inbound',  tier='high'
   *   - 'outbound' → action_type='sms_outbound', tier='medium'
   *   - 'body_extracted_email' → action_type='body_extracted_email',
   *     tier='high'. Built by the sms-name-match Tier-0 body-email
   *     resolver (O7 flip) as a follow-on enrichment signal so the
   *     spine sees the body-extracted email even when the primary
   *     inbound has already been routed. The body-extracted email is
   *     strong identity evidence (per resolver.ts match-chain ordering).
   *
   * Defaults to direction-mapped values when omitted — back-compat
   * with the T2 + O4 call sites that pass `direction` only. */
  mode?: 'inbound' | 'outbound' | 'body_extracted_email'
  direction: 'inbound' | 'outbound'
  /** Couple-side phone (sender on inbound, recipient on outbound).
   *  Twilio: From on inbound, To on outbound.
   *  OpenPhone: from_number on inbound, to_number on outbound — see
   *  ingestion/openphone.ts:~852-853. */
  externalPhone: string | null
  /** Venue line. Accepted for symmetry / future multi-line routing. */
  venuePhone: string | null
  /** Channel-native message id. Twilio MessageSid / OpenPhone
   *  openphone_message_id. Used as external_id. */
  messageSid: string
  /** Body text. Sliced into raw_payload. */
  body: string
  /** Twilio NumMedia or OpenPhone-equivalent. */
  mediaCount?: number
  /** ISO timestamp the SMS occurred (NOT ingest time). Defaults to now. */
  occurredAt?: string
  /** Multi-venue safety: this signal's venue. Not written to the
   *  signal itself (the cascade pulls venue from call args) but kept
   *  on the input shape so callers can never accidentally cross venues. */
  venueId: string
  /** Legacy weddings.id when the caller already resolved one. */
  weddingId?: string | null
  /** body-extract emails from the SMS body (closes Q5). First is
   *  treated as primary, second as partner. Mirrors the Zoom builder
   *  slot convention (zoom-to-signal.ts). The OpenPhone O4 flip pipes
   *  `extractIdentityFromEmail(...).emails` here so cascade stages
   *  6/7/8 fire on first contact instead of waiting for a separate
   *  follow-up extractor pass. */
  extractedEmails?: string[] | null
  /** body-extract phones from the SMS body. First is treated as
   *  partner phone (the externalPhone is already primary). */
  extractedPhones?: string[] | null
  /** body-extract names from the SMS body. First is treated as
   *  primary, second as partner. */
  extractedNames?: string[] | null
}

export function smsToNormalizedSignal(input: SmsToSignalInput): NormalizedSignal {
  const {
    mode,
    direction,
    externalPhone,
    venuePhone,
    messageSid,
    body,
    mediaCount,
    occurredAt,
    weddingId = null,
    extractedEmails = null,
    extractedPhones = null,
    extractedNames = null,
  } = input

  const phones = derivePhoneFields({
    direction,
    externalPhone,
    venuePhone,
  })

  const effectiveMode = mode ?? direction
  const isInbound = direction === 'inbound'
  let actionType: string
  let signalTier: NormalizedSignal['signal_tier']
  if (effectiveMode === 'body_extracted_email') {
    actionType = 'body_extracted_email'
    // Body-extracted email is the strongest cross-channel identifier
    // (per resolver.ts match-chain ordering). Tier 'high' is the
    // same level the direct inbound carries.
    signalTier = 'high'
  } else if (effectiveMode === 'outbound' || direction === 'outbound') {
    actionType = 'sms_outbound'
    signalTier = 'medium'
  } else {
    actionType = 'sms_inbound'
    signalTier = 'high'
  }

  // Body-extracted identity → structured slots (closes Q5). Same
  // slot convention as zoom-to-signal.ts. The externalPhone already
  // populates primary_phone via derivePhoneFields; an
  // extracted-body phone is treated as the PARTNER phone (second
  // person's number written in the message — "you can also reach
  // Sandy at 540-..."). Names: first → primary, second → partner.
  const primaryBodyEmail = extractedEmails?.[0] ?? null
  const partnerBodyEmail = extractedEmails?.[1] ?? null
  const partnerBodyPhone = extractedPhones?.[0] ?? null
  const primaryBodyName = extractedNames?.[0] ?? null
  const partnerBodyName = extractedNames?.[1] ?? null

  return {
    external_id: messageSid,
    channel: 'sms',
    action_type: actionType,
    occurred_at: occurredAt ?? new Date().toISOString(),
    signal_tier: signalTier,
    identity_hint: deriveIdentityHint({
      name: primaryBodyName,
      email: primaryBodyEmail,
      phone: externalPhone,
    }),
    primary_name: primaryBodyName,
    primary_email: primaryBodyEmail,
    primary_phone: phones.primary_phone,
    partner_name: partnerBodyName,
    partner_email: partnerBodyEmail,
    partner_phone: phones.partner_phone ?? partnerBodyPhone,
    wedding_date: null,
    session_ip: null,
    session_fingerprint: null,
    raw_payload: mergeRawPayload(
      {
        body_preview: body ? body.slice(0, 300) : null,
      },
      {
        full_body: body,
        direction,
        from_phone: isInbound ? externalPhone : venuePhone,
        to_phone: isInbound ? venuePhone : externalPhone,
        media_count: typeof mediaCount === 'number' ? mediaCount : null,
        extracted_emails: extractedEmails ?? null,
        extracted_phones: extractedPhones ?? null,
        extracted_names: extractedNames ?? null,
      },
    ),
    legacy_wedding_id: weddingId,
    author_class: isInbound ? 'couple' : 'operator',
  }
}
