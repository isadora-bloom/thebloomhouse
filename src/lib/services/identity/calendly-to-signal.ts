/**
 * Phase 1 Batch 2 — Pbatch2-1: Calendly → NormalizedSignal adapter.
 *
 * Anchor: PHASE-1-BATCH-2.md §2 Pbatch2-1 + §3 phase B (C3/C11/C12).
 *
 * Three modes, one chokepoint construction site:
 *
 *  - 'invitee_created'   → tour_booked     (live webhook, today inline
 *                                            at webhooks/calendly/route.ts:436-457)
 *  - 'invitee_canceled'  → tour_cancelled  (today direct touchpoints.upsert
 *                                            at calendly-outcomes.ts:~137 —
 *                                            CHOKEPOINT VIOLATION, C11)
 *  - 'attended_derived'  → tour_attended   (today direct batch upsert at
 *                                            calendly-outcomes.ts:~344 — C12)
 *
 * REVIEW Qcal-1 (live vs Tracer tier disagreement):
 *   - Live webhook literal hard-codes signal_tier='high' (verified
 *     webhooks/calendly/route.ts:441).
 *   - Batch Tracer adapter uses 'highest' (sources/calendly.ts:109).
 *   - This builder picks 'high' to be byte-identical with the live
 *     literal at flip time (C3 promotion). The Tracer's 'highest'
 *     needs a separate normalization PR; flagged here so the followup
 *     does not get lost.
 *
 * Pbatch2-10 fallback (cancellation only):
 *   When linkSignal returns no coupleId for a tour_cancelled signal
 *   AND a legacy weddingId anchor exists, C11 callers must call
 *   `tourCancellationFallback` to land a direct touchpoints.upsert
 *   against the wedding's couple (resolved via couples.source_wedding_id).
 *   D9 cohort funnel reads tour_cancelled touchpoints not fragments,
 *   so a phone-only Calendly cancellation losing identity at link
 *   time must NOT silently drop to a fragment.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedSignal } from './sources/types'
import { deriveIdentityHint } from './signal-helpers/identity-hint'
import { mergeRawPayload } from './signal-helpers/raw-payload'
import {
  extractCalendlyQuestions,
  type CalendlyCanonicalSource,
} from '@/lib/services/ingestion/calendly-questions-parser'

export type CalendlyEventMode =
  | 'invitee_created'
  | 'invitee_canceled'
  | 'attended_derived'

export interface CalendlyToSignalInput {
  /** Which Calendly event/mode this signal represents. */
  event: CalendlyEventMode
  /** Calendly webhook payload (invitee_created / invitee_canceled) OR
   *  attendance-sweep row payload (attended_derived). Free-shape; the
   *  builder probes the fields it needs. */
  payload: Record<string, unknown>
  /** Legacy weddings.id this booking is tied to, if the caller already
   *  resolved one. Passed to the matcher as anchor hint. */
  weddingId?: string | null
  /** For attended_derived: the booking row's external_id (the
   *  tour_booked touchpoint's external_id). Required to build the
   *  ':attended' dedup key off the same booking. */
  bookingExternalId?: string | null
}

interface CalendlyPayloadProbe {
  inviteeEmail: string | null
  inviteeName: string | null
  inviteeUri: string | null
  scheduledEventUri: string | null
  scheduledStart: string | null
  cancelReason: string | null
  partnerEmail: string | null
  partnerName: string | null
  /** 2026-05-27 — canonical source extracted from the Calendly Questions
   *  block ("Where did you first hear about us? → Google" → 'google').
   *  Populated when payload.html_body is present OR when the webhook
   *  Q&A contains a source question. null when no source-shaped
   *  question/answer present. */
  sourceCanonical: CalendlyCanonicalSource | null
  /** Literal source answer for forensic audit. */
  sourceLiteral: string | null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function probePayload(payload: Record<string, unknown>): CalendlyPayloadProbe {
  const inviteeEmail = asString(payload.email)
  const inviteeName = asString(payload.name)
  const inviteeUri = asString(payload.uri)

  const scheduledEvent = (payload.scheduled_event ?? null) as
    | Record<string, unknown>
    | null
  const scheduledEventUri = scheduledEvent
    ? asString(scheduledEvent.uri)
    : null
  const scheduledStart = scheduledEvent
    ? asString(scheduledEvent.start_time)
    : null

  const cancellation = (payload.cancellation ?? null) as
    | Record<string, unknown>
    | null
  const cancelReason = cancellation ? asString(cancellation.reason) : null

  // Q&A partner-email enrichment. Calendly's questions_and_answers can
  // live directly on the invitee payload OR nested inside
  // scheduled_event.questions_and_answers depending on webhook version;
  // we probe both, matching the pattern in
  // discovery-source/capture.ts:extractDiscoveryAnswerFromCalendly.
  // We extract a partner email + partner name when the questions tag
  // either ("partner email" / "partner name" substring match — keep
  // permissive; per-venue label variations are common).
  let partnerEmail: string | null = null
  let partnerName: string | null = null
  let sourceCanonical: CalendlyCanonicalSource | null = null
  let sourceLiteral: string | null = null
  const qaCandidates: unknown[] = []
  const directQa = payload.questions_and_answers
  if (Array.isArray(directQa)) qaCandidates.push(...directQa)
  if (scheduledEvent) {
    const seQa = scheduledEvent.questions_and_answers
    if (Array.isArray(seQa)) qaCandidates.push(...seQa)
  }
  for (const item of qaCandidates) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const q = asString(r.question)?.toLowerCase() ?? ''
    const a = asString(r.answer)
    if (!q || !a) continue
    if (!partnerEmail && q.includes('partner') && q.includes('email')) {
      // Naive validation — a real email contains an '@'. Skip when not.
      if (a.includes('@')) partnerEmail = a
    }
    if (!partnerName && q.includes('partner') && q.includes('name')) {
      if (!a.includes('@')) partnerName = a
    }
    // 2026-05-27 — source extraction from Q&A.
    if (
      !sourceLiteral &&
      ((q.includes('where') && q.includes('hear')) ||
        (q.includes('how') && q.includes('hear')) ||
        (q.includes('how') && q.includes('find')) ||
        (q.includes('where') && q.includes('find')))
    ) {
      sourceLiteral = a
    }
  }

  // 2026-05-27 — HTML-body fallback. When the webhook didn't pass
  // structured Q&A but the payload carries a Calendly HTML body
  // (`html_body` / `body` / `notification_html`), run the parser to
  // extract the source answer. Most webhook adapters today don't carry
  // HTML, but the email-driven path (re-processed Calendly notifications)
  // does — and this keeps the Tracer-side signal honest.
  const htmlBody =
    asString(payload.html_body) ??
    asString(payload.body) ??
    asString(payload.notification_html) ??
    null
  if (htmlBody && !sourceLiteral) {
    const bundle = extractCalendlyQuestions(htmlBody)
    if (bundle) {
      if (!sourceLiteral) sourceLiteral = bundle.sourceLiteral
      if (!sourceCanonical) sourceCanonical = bundle.source
      if (!partnerEmail && bundle.partnerEmail) partnerEmail = bundle.partnerEmail
      if (!partnerName && bundle.partnerName) partnerName = bundle.partnerName
    }
  }

  // Canonicalize source from the literal answer when not already set
  // (Q&A path landed only the literal; HTML path landed both).
  if (sourceLiteral && !sourceCanonical) {
    const bundle = extractCalendlyQuestions(
      `<strong>where did you first hear about us</strong><p>${sourceLiteral}</p>`,
    )
    if (bundle?.source) sourceCanonical = bundle.source
  }

  return {
    inviteeEmail,
    inviteeName,
    inviteeUri,
    scheduledEventUri,
    scheduledStart,
    cancelReason,
    partnerEmail,
    partnerName,
    sourceCanonical,
    sourceLiteral,
  }
}

/**
 * Build the cascade `NormalizedSignal` for a Calendly event.
 *
 * For mode='invitee_created' the output is byte-identical (field-by-
 * field) to the inline literal at webhooks/calendly/route.ts:436-457
 * when called with the same payload + weddingId — the only additions
 * are partner_email / partner_name when Q&A populates them (a strict
 * superset of the live literal; the live literal hard-codes both null).
 */
export function calendlyToNormalizedSignal(
  input: CalendlyToSignalInput,
): NormalizedSignal {
  const { event, payload, weddingId = null, bookingExternalId = null } = input
  const probe = probePayload(payload)
  const occurredAt =
    probe.scheduledStart ?? new Date().toISOString()

  if (event === 'invitee_created') {
    // Byte-identical to webhooks/calendly/route.ts:436-457:
    //   external_id = payload.uri ?? `calendly:${weddingId}:${startTime ?? Date.now()}`
    const external_id =
      probe.inviteeUri ??
      `calendly:${weddingId ?? 'unknown'}:${probe.scheduledStart ?? Date.now()}`
    return {
      external_id,
      channel: 'calendly',
      action_type: 'tour_booked',
      occurred_at: occurredAt,
      signal_tier: 'high',
      identity_hint: deriveIdentityHint({
        name: probe.inviteeName,
        email: probe.inviteeEmail,
      }),
      primary_name: probe.inviteeName,
      primary_email: probe.inviteeEmail,
      primary_phone: null,
      partner_name: probe.partnerName,
      partner_email: probe.partnerEmail,
      partner_phone: null,
      wedding_date: null,
      session_ip: null,
      session_fingerprint: null,
      raw_payload: mergeRawPayload(
        { external_url: probe.inviteeUri },
        {
          calendly_uri: probe.inviteeUri,
          scheduled_at: probe.scheduledStart,
          // 2026-05-27 — Calendly custom-questions source attribution.
          // Carried in raw_payload so downstream readers (touchpoint
          // analysis, source-attribution rollups) can credit the right
          // origin instead of stamping every Calendly-direct booking as
          // direct/unknown.
          source_canonical: probe.sourceCanonical,
          source_literal: probe.sourceLiteral,
        },
      ),
      legacy_wedding_id: weddingId,
    }
  }

  if (event === 'invitee_canceled') {
    // Mirrors calendly-outcomes.ts:~131-153 external_id rule.
    const baseExternalId =
      probe.scheduledEventUri ??
      `${probe.inviteeEmail ?? 'unknown'}:${probe.scheduledStart ?? 'unknown'}`
    return {
      external_id: `${baseExternalId}:cancelled`,
      channel: 'calendly',
      action_type: 'tour_cancelled',
      occurred_at: new Date().toISOString(),
      signal_tier: 'high',
      identity_hint: deriveIdentityHint({
        name: probe.inviteeName,
        email: probe.inviteeEmail,
      }),
      primary_name: probe.inviteeName,
      primary_email: probe.inviteeEmail,
      primary_phone: null,
      partner_name: probe.partnerName,
      partner_email: probe.partnerEmail,
      partner_phone: null,
      wedding_date: null,
      session_ip: null,
      session_fingerprint: null,
      raw_payload: mergeRawPayload(
        { external_url: probe.scheduledEventUri },
        {
          direction: 'inbound',
          scheduled_event_uri: probe.scheduledEventUri,
          scheduled_start: probe.scheduledStart,
          cancel_reason: probe.cancelReason,
        },
      ),
      legacy_wedding_id: weddingId,
    }
  }

  // attended_derived — daily sweep
  const baseExternalId =
    bookingExternalId ?? probe.inviteeUri ?? `unknown:${occurredAt}`
  return {
    external_id: `${baseExternalId}:attended`,
    channel: 'calendly',
    action_type: 'tour_attended',
    occurred_at: occurredAt,
    signal_tier: 'high',
    identity_hint: deriveIdentityHint({
      name: probe.inviteeName,
      email: probe.inviteeEmail,
    }),
    primary_name: probe.inviteeName,
    primary_email: probe.inviteeEmail,
    primary_phone: null,
    partner_name: probe.partnerName,
    partner_email: probe.partnerEmail,
    partner_phone: null,
    wedding_date: null,
    session_ip: null,
    session_fingerprint: null,
    raw_payload: mergeRawPayload(
      { external_url: probe.scheduledEventUri },
      {
        derived: 'attendance_sweep',
        booking_external_id: bookingExternalId,
        scheduled_event_uri: probe.scheduledEventUri,
        scheduled_start: probe.scheduledStart,
      },
    ),
    legacy_wedding_id: weddingId,
  }
}

// ---------------------------------------------------------------------------
// Pbatch2-10 cancellation-to-touchpoint fallback (C11 narrow exception)
// ---------------------------------------------------------------------------

export interface TourCancellationFallbackArgs {
  supabase: SupabaseClient
  venueId: string
  /** The legacy wedding anchor — required for fallback to fire. */
  weddingId: string
  /** The cancellation signal that linkSignal couldn't resolve a couple
   *  for. The fallback reuses its external_id, occurred_at, and
   *  raw_payload verbatim against the spine touchpoints table. */
  signal: NormalizedSignal
}

export interface TourCancellationFallbackResult {
  ok: boolean
  fired: boolean
  /** When fired=true, the couple_id the touchpoint landed against. */
  coupleId?: string
  reason?: string
}

/**
 * NARROW EXCEPTION — Pbatch2-10 (PHASE-1-BATCH-2.md §4 + §7).
 *
 * `linkSignal` is the canonical cascade chokepoint and returns
 * `{action:'fragment', coupleId:null}` when identity is insufficient.
 * For most channels that's the right outcome. For Calendly cancellation
 * it isn't: D9 cohort funnel reads tour_cancelled touchpoints, not
 * fragments — a phone-only Calendly cancellation losing identity at
 * link time would silently disappear from the funnel.
 *
 * This fallback re-resolves the couple via `couples.source_wedding_id`
 * (the canonical legacy join) and lands a direct touchpoints.upsert.
 * It is the analog of the legacy direct write at
 * `calendly-outcomes.ts:~137` and MUST stay scoped to the cancellation-
 * only path. Document any new use site as a chokepoint violation.
 *
 * Idempotent on `UNIQUE(venue_id, channel, external_id)`.
 */
export async function tourCancellationFallback(
  args: TourCancellationFallbackArgs,
): Promise<TourCancellationFallbackResult> {
  const { supabase, venueId, weddingId, signal } = args

  // Resolve the spine couple from the legacy wedding anchor.
  const { data: couple, error: coupleErr } = await supabase
    .from('couples')
    .select('id, venue_id')
    .eq('source_wedding_id', weddingId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (coupleErr) {
    return {
      ok: false,
      fired: false,
      reason: `couples_lookup: ${coupleErr.message}`,
    }
  }
  if (!couple) {
    return { ok: true, fired: false, reason: 'no_couple_for_wedding' }
  }

  const { error: upsertErr } = await supabase
    .from('touchpoints')
    .upsert(
      {
        venue_id: venueId,
        couple_id: couple.id as string,
        channel: signal.channel,
        action_type: signal.action_type,
        occurred_at: signal.occurred_at,
        signal_tier: signal.signal_tier,
        external_id: signal.external_id,
        raw_payload: signal.raw_payload,
      },
      // onConflict-skip-check: matches table-level UNIQUE (venue_id, channel, external_id) on touchpoints in migration 346 (line 209); guard's CREATE TABLE parser misses it because inline -- comments precede the UNIQUE clause in the table body.
      { onConflict: 'venue_id,channel,external_id', ignoreDuplicates: true },
    )
  if (upsertErr) {
    return {
      ok: false,
      fired: false,
      coupleId: couple.id as string,
      reason: `touchpoint_upsert: ${upsertErr.message}`,
    }
  }
  return { ok: true, fired: true, coupleId: couple.id as string }
}
