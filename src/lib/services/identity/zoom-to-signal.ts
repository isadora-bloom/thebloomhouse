/**
 * Phase 1 Batch 2 — Pbatch2-1: Zoom meeting → NormalizedSignal adapter.
 *
 * Anchor: PHASE-1-BATCH-2.md §2 Pbatch2-1 + §2 Pbatch2-5 + §3 phase C Z5.
 *
 * Used by:
 *  - Zoom cron (ingestion/zoom.ts:~673) at the Z5 flip.
 *
 * Channel taxonomy (Pbatch2-5 rename)
 * -----------------------------------
 * channel = 'zoom'  — NOT 'meeting'. Per Pbatch2-5:
 *  - `identity/sources/calendly.ts:128-178` scans
 *    `interactions WHERE type='meeting'` for tour signals — a
 *    Zoom-as-'meeting' channel value collides with that adapter.
 *  - touchpoints.channel docstring (mig 346:191) doesn't yet enumerate
 *    'zoom' but the column is free-text.
 *  - The existing `interactions.type='meeting'` write at
 *    `ingestion/zoom.ts:678` is left as-is by this builder; the Z5
 *    flip phase will address that legacy column value separately.
 *
 * action_type
 * -----------
 * 'meeting_completed' — Zoom transcripts only land after the meeting
 * ends (the cron polls completed-meetings endpoint).
 *
 * signal_tier
 * -----------
 *   matchedWeddingId present → 'high'    (couple-anchored meeting, full
 *                                          forensic value)
 *   no match                 → 'medium'  (orphan transcript — Tracer-
 *                                          rebindable per OQ-Z3)
 *
 * Body-extracted identifiers (closes Q5 from Batch 1)
 * ---------------------------------------------------
 * The Zoom cron already runs `extractIdentityFromEmail` over the
 * transcript (zoom.ts:~669). Its emails[] + phones[] arrive on this
 * builder's input and populate the structured signal slots so the
 * cascade's stages 6/7/8 fire on first contact — pre-Batch-2 those
 * bodies hit a separate dispatch loop and the spine never saw them.
 *
 * author_class
 * ------------
 * 'couple' default. A future per-channel `hasSufficientIdentity` rule
 * may want to override for vendor / coordinator-internal meetings
 * (Pbatch2-1 spec note); out of this builder's scope.
 */

import type { NormalizedSignal } from './sources/types'
import { deriveIdentityHint } from './signal-helpers/identity-hint'
import { mergeRawPayload } from './signal-helpers/raw-payload'

export interface ZoomToSignalInput {
  /** Provider meeting id — Zoom meeting UUID. */
  meetingId: string
  topic?: string | null
  /** ISO timestamp the meeting started. */
  startTime?: string | null
  /** Duration in seconds. */
  duration?: number | null
  /** Transcript text (sliced into raw_payload). */
  transcript?: string | null
  /** Names of meeting participants pulled off the Zoom roster. */
  participantNames?: string[] | null
  /** body-extract emails from the transcript (closes Q5). First is
   *  treated as primary, second as partner. */
  extractedEmails?: string[] | null
  /** body-extract phones from the transcript. First is treated as
   *  primary phone. */
  extractedPhones?: string[] | null
  /** Legacy weddings.id when matchWeddingByName / OAuth-side matcher
   *  already resolved one. */
  matchedWeddingId?: string | null
}

export function zoomToNormalizedSignal(input: ZoomToSignalInput): NormalizedSignal {
  const {
    meetingId,
    topic = null,
    startTime = null,
    duration = null,
    transcript = null,
    participantNames = null,
    extractedEmails = null,
    extractedPhones = null,
    matchedWeddingId = null,
  } = input

  const primaryEmail = extractedEmails?.[0] ?? null
  const partnerEmail = extractedEmails?.[1] ?? null
  const primaryPhone = extractedPhones?.[0] ?? null

  // primary_name: prefer first participant name (Zoom rosters often
  // carry "Sarah Ross" / "Sarah R."), else null.
  const primaryName =
    participantNames && participantNames.length > 0
      ? participantNames[0]
      : null

  const signalTier: NormalizedSignal['signal_tier'] = matchedWeddingId
    ? 'high'
    : 'medium'

  const transcriptSliced = transcript ? transcript.slice(0, 50000) : null
  const bodyPreview = transcriptSliced ? transcriptSliced.slice(0, 500) : null
  const subject = topic
    ? `Zoom: ${topic}`
    : `Zoom meeting${startTime ? ` (${startTime.split('T')[0]})` : ''}`

  return {
    external_id: meetingId,
    channel: 'zoom',
    action_type: 'meeting_completed',
    occurred_at: startTime ?? new Date().toISOString(),
    signal_tier: signalTier,
    identity_hint: deriveIdentityHint({
      name: primaryName,
      email: primaryEmail,
      phone: primaryPhone,
    }),
    primary_name: primaryName,
    primary_email: primaryEmail,
    primary_phone: primaryPhone,
    partner_name: null,
    partner_email: partnerEmail,
    partner_phone: null,
    wedding_date: null,
    session_ip: null,
    session_fingerprint: null,
    raw_payload: mergeRawPayload(
      {
        subject,
        body_preview: bodyPreview,
      },
      {
        zoom_meeting_id: meetingId,
        topic,
        participant_names: participantNames,
        transcript: transcriptSliced,
        duration,
      },
    ),
    legacy_wedding_id: matchedWeddingId,
    author_class: 'couple',
  }
}
