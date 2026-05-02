/**
 * Bloom House: Tour Cancellation Reason
 *
 * Helpers for the auto-detection path in email-pipeline. When the
 * scheduling-event handler classifies an inbound email as a tour
 * cancellation, we want to:
 *   1. Find the matching tours row (same venue, wedding, ~event datetime).
 *   2. Flip its outcome → 'cancelled'.
 *   3. Best-effort extract a structured cancellation_reason from the
 *      email body (LLM bucketed against migration 166's enum).
 *
 * Migration 166 is the source of truth for the reason enum. The default
 * bucket when extraction can't yield a clean signal is 'other' (per the
 * task spec: don't go overboard).
 *
 * Per OPS-21.3.5 the email body is Tier-1 PII (free-form couple text),
 * so the extractor passes contentTier: 1 to callAIJson.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson } from '@/lib/ai/client'
import { redactError } from '@/lib/observability/redact'

/**
 * Mirror migration 166's CHECK enum. Keep in sync.
 */
export const TOUR_CANCELLATION_REASONS = [
  'weather',
  'date_conflict',
  'family_emergency',
  'venue_concern',
  'travel_blocker',
  'rescheduled',
  'no_show_followup',
  'other',
] as const

export type TourCancellationReason = (typeof TOUR_CANCELLATION_REASONS)[number]

const REASON_SET = new Set<string>(TOUR_CANCELLATION_REASONS)

/**
 * Best-effort LLM extraction of a cancellation reason from an inbound
 * cancel email. Returns 'other' on any failure (parse, network, unknown
 * bucket) — auto-detection should never block on this.
 */
export async function extractCancellationReason(args: {
  venueId: string
  subject: string | null
  body: string | null
}): Promise<TourCancellationReason> {
  const { venueId, subject, body } = args

  const trimmedBody = (body ?? '').trim()
  // No body to reason over — fall back to 'other'.
  if (trimmedBody.length === 0) return 'other'

  const systemPrompt = [
    'You classify wedding-venue tour cancellation emails.',
    'Read the inbound email and pick the SINGLE best bucket from the allowed enum.',
    'Allowed buckets:',
    '  - weather: weather event forced the cancel (storm, hurricane, snow).',
    '  - date_conflict: schedule shifted (work, family event, calendar clash).',
    '  - family_emergency: illness, bereavement, urgent family matter.',
    '  - venue_concern: couple raised a concern about the venue itself.',
    '  - travel_blocker: travel issue (flight cancel, illness in transit).',
    '  - rescheduled: explicit reschedule to another date — lead alive.',
    '  - no_show_followup: post-hoc note that the couple did not show.',
    '  - other: anything else, or signal too thin to bucket.',
    'Return JSON: { "reason": "<one of the buckets above>" }',
    'Use "other" when the email gives no clear signal. Do not invent reasons.',
  ].join('\n')

  // Cap at 4000 chars to stay under the token budget for cheap classification.
  const bodyExcerpt = trimmedBody.length > 4000 ? trimmedBody.slice(0, 4000) : trimmedBody

  const userPrompt = [
    `Subject: ${subject ?? '(none)'}`,
    '',
    'Body:',
    bodyExcerpt,
  ].join('\n')

  try {
    const raw = await callAIJson<unknown>({
      systemPrompt,
      userPrompt,
      maxTokens: 60,
      temperature: 0.0,
      venueId,
      taskType: 'tour_cancellation_reason_extract',
      // Tier 1: raw inbound couple email body. OPS-21.3.5.
      contentTier: 1,
    })
    const reason = (raw as { reason?: unknown } | null)?.reason
    if (typeof reason === 'string' && REASON_SET.has(reason)) {
      return reason as TourCancellationReason
    }
    return 'other'
  } catch (err) {
    // Tier-1 redaction: error messages echo prompt content.
    console.warn(
      '[tour-cancellation-reason] extraction failed:',
      redactError(err)
    )
    return 'other'
  }
}

/**
 * Locate a tour row that matches the (venue, wedding, eventDatetime)
 * triple within ±14 days, prefer outcome='pending' or 'completed'.
 *
 * Mirrors the matching tolerance used by the email-pipeline cancellation
 * guard (TOLERANCE_MS = 14 days). Returns null when no match — the
 * cancellation engagement event still lands; we just can't flip a tours
 * row that doesn't exist.
 */
export async function findCancellableTour(
  supabase: SupabaseClient,
  args: {
    venueId: string
    weddingId: string
    eventDatetime: string | null
  }
): Promise<{ id: string } | null> {
  const { venueId, weddingId, eventDatetime } = args
  if (!eventDatetime) {
    // No anchor — pick the most recent pending tour for this wedding.
    const { data } = await supabase
      .from('tours')
      .select('id')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .in('outcome', ['pending', 'completed'])
      .order('scheduled_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as { id: string } | null) ?? null
  }
  const evtMs = Date.parse(eventDatetime)
  if (!Number.isFinite(evtMs)) return null
  const lower = new Date(evtMs - 14 * 24 * 60 * 60 * 1000).toISOString()
  const upper = new Date(evtMs + 14 * 24 * 60 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('tours')
    .select('id, scheduled_at')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .in('outcome', ['pending', 'completed'])
    .gte('scheduled_at', lower)
    .lte('scheduled_at', upper)
    .order('scheduled_at', { ascending: true })
    .limit(5)
  const rows = (data ?? []) as Array<{ id: string; scheduled_at: string | null }>
  if (rows.length === 0) return null
  // Prefer the row whose scheduled_at is closest to eventDatetime.
  let best: { id: string; delta: number } | null = null
  for (const r of rows) {
    if (!r.scheduled_at) continue
    const ms = Date.parse(r.scheduled_at)
    if (!Number.isFinite(ms)) continue
    const delta = Math.abs(ms - evtMs)
    if (best === null || delta < best.delta) {
      best = { id: r.id, delta }
    }
  }
  if (best) return { id: best.id }
  return { id: rows[0].id }
}
