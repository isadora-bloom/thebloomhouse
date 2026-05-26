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
}

export function smsToNormalizedSignal(input: SmsToSignalInput): NormalizedSignal {
  const {
    direction,
    externalPhone,
    venuePhone,
    messageSid,
    body,
    mediaCount,
    occurredAt,
    weddingId = null,
  } = input

  const phones = derivePhoneFields({
    direction,
    externalPhone,
    venuePhone,
  })

  const isInbound = direction === 'inbound'
  const actionType = isInbound ? 'sms_inbound' : 'sms_outbound'
  const signalTier: NormalizedSignal['signal_tier'] = isInbound
    ? 'high'
    : 'medium'

  return {
    external_id: messageSid,
    channel: 'sms',
    action_type: actionType,
    occurred_at: occurredAt ?? new Date().toISOString(),
    signal_tier: signalTier,
    identity_hint: deriveIdentityHint({ phone: externalPhone }),
    primary_name: null,
    primary_email: null,
    primary_phone: phones.primary_phone,
    partner_name: null,
    partner_email: null,
    partner_phone: phones.partner_phone,
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
      },
    ),
    legacy_wedding_id: weddingId,
    author_class: isInbound ? 'couple' : 'operator',
  }
}
