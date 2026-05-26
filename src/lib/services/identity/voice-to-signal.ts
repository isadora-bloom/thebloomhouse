/**
 * Phase 1 Batch 2 — Pbatch2-1: voice (call + voicemail) → NormalizedSignal.
 *
 * Anchor: PHASE-1-BATCH-2.md §2 Pbatch2-1 + §3 phase C O4.
 *
 * Used by:
 *  - OpenPhone cron (ingestion/openphone.ts:~994) when row.channel
 *    is 'call' or 'voicemail'. SMS-channel rows use sms-to-signal.ts.
 *
 * Channel taxonomy (Pbatch2-4 subtype)
 * ------------------------------------
 * REVIEW Pbatch2-4: this builder picks the THREE-channel side of
 * the operator decision:
 *   kind='voicemail' → channel='voicemail'
 *   kind='call'      → channel='phone'      (matches touchpoints.channel
 *                                            docstring at mig 346:191)
 *
 * If Pbatch2-4 lands on Option B (single 'sms' channel for all
 * OpenPhone signals), revisit by collapsing this file's channel
 * picker — the action_type vocabulary already distinguishes the kinds.
 *
 * action_type
 * -----------
 *   kind='voicemail'                           → 'voicemail_received'
 *   kind='call' AND direction='inbound'        → 'inbound_call'
 *   kind='call' AND direction='outbound'       → 'outbound_call'
 *
 * signal_tier
 * -----------
 *   inbound call WITH transcript → 'high'    (substantive forensics)
 *   everything else              → 'medium'  (voicemail is medium —
 *                                            transcripts are short,
 *                                            often noisy)
 *
 * Doctrine note: outbound voice is NOT progression (per §3 Don't-skip-
 * #1, mirrored from gmail.ts). signal_tier 'medium' instead of 'high'
 * keeps the cascade from promoting venue-initiated calls into couple-
 * level progression.
 */

import type { NormalizedSignal } from './sources/types'
import { deriveIdentityHint } from './signal-helpers/identity-hint'
import { derivePhoneFields } from './signal-helpers/phone-fields'
import { mergeRawPayload } from './signal-helpers/raw-payload'

export type VoiceKind = 'voicemail' | 'call'

export interface VoiceToSignalInput {
  kind: VoiceKind
  direction: 'inbound' | 'outbound'
  /** Couple-side phone (sender on inbound, recipient on outbound). */
  externalPhone: string | null
  venuePhone: string | null
  /** Channel-native id — OpenPhone call_/vm_ prefixed id. */
  externalId: string
  /** Transcript text. Sliced into raw_payload. */
  transcript?: string | null
  /** Provider-side summary (OpenPhone AI summary). */
  summary?: string | null
  /** Duration in seconds. */
  duration?: number | null
  /** ISO timestamp the call/voicemail occurred. */
  occurredAt?: string
  venueId: string
  weddingId?: string | null
  /** body-extract emails from the transcript / summary (closes Q5).
   *  First is treated as primary, second as partner. Mirrors the
   *  Zoom builder slot convention. The OpenPhone O4 flip pipes
   *  `extractIdentityFromEmail(...).emails` here so cascade stages
   *  6/7/8 fire on first contact instead of waiting for a separate
   *  follow-up extractor pass. */
  extractedEmails?: string[] | null
  /** body-extract phones. First is treated as partner phone (the
   *  externalPhone is already primary). */
  extractedPhones?: string[] | null
  /** body-extract names. First → primary, second → partner. */
  extractedNames?: string[] | null
}

export function voiceToNormalizedSignal(input: VoiceToSignalInput): NormalizedSignal {
  const {
    kind,
    direction,
    externalPhone,
    venuePhone,
    externalId,
    transcript = null,
    summary = null,
    duration = null,
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

  // REVIEW Pbatch2-4 — three-channel split.
  const channel = kind === 'voicemail' ? 'voicemail' : 'phone'

  let actionType: string
  if (kind === 'voicemail') {
    actionType = 'voicemail_received'
  } else if (direction === 'inbound') {
    actionType = 'inbound_call'
  } else {
    actionType = 'outbound_call'
  }

  const hasTranscript = !!(transcript && transcript.trim())
  const signalTier: NormalizedSignal['signal_tier'] =
    direction === 'inbound' && kind === 'call' && hasTranscript
      ? 'high'
      : 'medium'

  const bodyPreview =
    (transcript && transcript.slice(0, 300)) ||
    (summary && summary.slice(0, 300)) ||
    null

  const subject =
    kind === 'voicemail'
      ? `Voicemail from ${externalPhone ?? 'unknown'}`
      : direction === 'inbound'
        ? `Call from ${externalPhone ?? 'unknown'}`
        : `Call to ${externalPhone ?? 'unknown'}`

  // Body-extracted identity → structured slots (closes Q5). Same
  // slot convention as zoom-to-signal.ts + sms-to-signal.ts.
  const primaryBodyEmail = extractedEmails?.[0] ?? null
  const partnerBodyEmail = extractedEmails?.[1] ?? null
  const partnerBodyPhone = extractedPhones?.[0] ?? null
  const primaryBodyName = extractedNames?.[0] ?? null
  const partnerBodyName = extractedNames?.[1] ?? null

  return {
    external_id: externalId,
    channel,
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
        subject,
        body_preview: bodyPreview,
      },
      {
        kind,
        direction,
        from_phone: direction === 'inbound' ? externalPhone : venuePhone,
        to_phone: direction === 'inbound' ? venuePhone : externalPhone,
        transcript: transcript ? transcript.slice(0, 50000) : null,
        summary,
        duration,
        extracted_emails: extractedEmails ?? null,
        extracted_phones: extractedPhones ?? null,
        extracted_names: extractedNames ?? null,
      },
    ),
    legacy_wedding_id: weddingId,
    author_class: direction === 'inbound' ? 'couple' : 'operator',
  }
}
