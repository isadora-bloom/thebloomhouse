/**
 * Phase 4 Task 41 — Tour attendee intelligence signal.
 *
 * Hypothesis (from the checklist): the mix of attendees at a tour correlates
 * with booking likelihood. Couples bringing parents may book at a different
 * rate than couples bringing friends. This is a per-venue learning signal,
 * we do NOT pool across venues.
 *
 * Data dependency (per checklist): "do not build until 10+ tours with
 * attendee data exist" at the venue. The computer below returns a
 * null-signal result when the threshold is not met, so UI surfaces can
 * show a deliberate "not enough data yet" state rather than a spurious
 * number computed from two rows.
 *
 * tours.attendees is a jsonb array of strings (migration 075). Canonical
 * values we derive a named bucket for:
 *   - 'couple'         the partners alone
 *   - 'parents'        at least one parent
 *   - 'friends'        at least one friend
 *   - 'family'         sibling, relative, etc (not parents)
 *   - 'wedding_party'  members of the wedding party
 * Anything else falls into 'other'.
 *
 * AI-VS-TEMPLATED-AUDIT finding #6: bucket math stays deterministic, but
 * `topInsight` is now narrated by Sonnet so the framing reads as a
 * coordinator action ("when a couple mentions parents, prioritise getting
 * all attendees onto the tour calendar") rather than a percentage tongue-
 * twister. The deterministic template is preserved as the LLM-failure
 * fallback. `top_insight_source` is stamped so callers can distinguish.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'

export const ATTENDEE_INTEL_PROMPT_VERSION = 'attendee-intel.v1'

export const MIN_TOURS_FOR_ATTENDEE_SIGNAL = 10

export interface AttendeeBucketStats {
  bucket: string
  toursWithBucket: number
  bookedFromBucket: number
  bookingRatePct: number
}

export interface TourAttendeeSignal {
  venueId: string
  totalTours: number
  bookedTours: number
  overallBookingRatePct: number
  buckets: AttendeeBucketStats[]
  /**
   * Top named insight when the best bucket's rate meaningfully exceeds the
   * overall rate. Null when under the data threshold or no clear outlier.
   */
  topInsight: string | null
  /**
   * Provenance of `topInsight`:
   *   'llm'      Sonnet narrated 1-2 sentences with a coordinator action.
   *   'template' Deterministic format string (LLM unavailable / gate closed
   *              / call failed). Numbers identical to the LLM path,
   *              framing flatter.
   *   null       No outlier found (topInsight is also null).
   */
  top_insight_source: 'llm' | 'template' | null
}

const BUCKET_ORDER = ['couple', 'parents', 'family', 'friends', 'wedding_party', 'other'] as const

function classifyAttendee(raw: string): string {
  const a = raw.trim().toLowerCase()
  if (!a) return 'other'
  if (a === 'couple' || a === 'partners' || a === 'bride' || a === 'groom') return 'couple'
  if (/parent|mom|mum|dad|mother|father/.test(a)) return 'parents'
  if (/friend/.test(a)) return 'friends'
  if (/sibling|sister|brother|aunt|uncle|cousin|grandparent|family/.test(a)) return 'family'
  if (/wedding party|bridesmaid|groomsm|maid of honou?r|best man/.test(a)) return 'wedding_party'
  return 'other'
}

/**
 * Compute the attendee-type signal for a single venue. Returns a null-signal
 * (topInsight === null) when under the data threshold or no clear outlier.
 */
export async function computeTourAttendeeSignal(venueId: string): Promise<TourAttendeeSignal> {
  const supabase = createServiceClient()

  const { data: tours } = await supabase
    .from('tours')
    .select('id, outcome, attendees, scheduled_at')
    .eq('venue_id', venueId)
    .in('outcome', ['completed', 'booked', 'lost'])

  const rows = tours ?? []
  const totalTours = rows.length
  const bookedTours = rows.filter((t) => t.outcome === 'booked').length

  const bucketCounts: Record<string, { total: number; booked: number }> = {}
  for (const b of BUCKET_ORDER) bucketCounts[b] = { total: 0, booked: 0 }

  for (const t of rows) {
    const attendees = Array.isArray(t.attendees) ? (t.attendees as string[]) : []
    const tourBuckets = new Set<string>()
    for (const a of attendees) {
      if (typeof a === 'string') tourBuckets.add(classifyAttendee(a))
    }
    if (tourBuckets.size === 0) tourBuckets.add('other')
    const booked = t.outcome === 'booked'
    for (const bucket of tourBuckets) {
      bucketCounts[bucket].total++
      if (booked) bucketCounts[bucket].booked++
    }
  }

  const buckets: AttendeeBucketStats[] = BUCKET_ORDER.map((bucket) => {
    const { total, booked } = bucketCounts[bucket]
    const rate = total > 0 ? (booked / total) * 100 : 0
    return { bucket, toursWithBucket: total, bookedFromBucket: booked, bookingRatePct: rate }
  }).filter((b) => b.toursWithBucket > 0)

  const overallRate = totalTours > 0 ? (bookedTours / totalTours) * 100 : 0

  // Below threshold: return a valid shape but no named insight.
  if (totalTours < MIN_TOURS_FOR_ATTENDEE_SIGNAL) {
    return {
      venueId,
      totalTours,
      bookedTours,
      overallBookingRatePct: overallRate,
      buckets,
      topInsight: null,
      top_insight_source: null,
    }
  }

  // Only name an insight when the best bucket with >= 5 supporting tours
  // materially beats the overall rate.
  const candidate = [...buckets]
    .filter((b) => b.toursWithBucket >= 5)
    .sort((a, b) => b.bookingRatePct - a.bookingRatePct)[0]

  let topInsight: string | null = null
  let top_insight_source: 'llm' | 'template' | null = null

  if (candidate && candidate.bookingRatePct >= overallRate + 10) {
    const prettyMap: Record<string, string> = {
      couple: 'Couples who toured alone',
      parents: 'Couples who brought parents',
      family: 'Couples who brought family',
      friends: 'Couples who brought friends',
      wedding_party: 'Couples who brought their wedding party',
      other: 'Couples with mixed attendees',
    }
    const bucketLabel = prettyMap[candidate.bucket] ?? 'Couples in this group'

    // LLM narration first; deterministic template is the fallback.
    const gate = await gateForBrainCall(venueId)
    if (gate.ok) {
      try {
        const narrated = await narrateAttendeeOutlier(venueId, {
          bucket: candidate.bucket,
          bucketLabel,
          bucketRatePct: Math.round(candidate.bookingRatePct),
          overallRatePct: Math.round(overallRate),
          toursWithBucket: candidate.toursWithBucket,
          totalTours,
        })
        if (narrated) {
          topInsight = narrated
          top_insight_source = 'llm'
        }
      } catch (err) {
        console.warn(
          '[attendee-intelligence] LLM narration failed:',
          redactError(err),
        )
      }
    }

    if (!topInsight) {
      topInsight = `${bucketLabel} have booked at ${candidate.bookingRatePct.toFixed(0)}% vs an overall ${overallRate.toFixed(0)}% at your venue.`
      top_insight_source = 'template'
    }
  }

  return {
    venueId,
    totalTours,
    bookedTours,
    overallBookingRatePct: overallRate,
    buckets,
    topInsight,
    top_insight_source,
  }
}

// ---------------------------------------------------------------------------
// LLM narration
// ---------------------------------------------------------------------------

interface AttendeeNarrationInput {
  bucket: string
  bucketLabel: string
  bucketRatePct: number
  overallRatePct: number
  toursWithBucket: number
  totalTours: number
}

interface AttendeeNarrationJson {
  insight?: string
}

/**
 * Compose 1-2 sentences that frame the attendee outlier as a coordinator
 * action, not a percentage. Bucket math is already done by the caller;
 * the LLM only narrates the outlier with a recommended action.
 *
 * Prompt rules: numbers in the output must come from the input block;
 * we hand the model a ratio (bucketRatePct / overallRatePct) it can
 * reference but we forbid invented denominators or rates not listed.
 *
 * Returns the trimmed insight string, or null when the model returned
 * nothing usable. Caller falls back to the deterministic template.
 */
async function narrateAttendeeOutlier(
  venueId: string,
  input: AttendeeNarrationInput,
): Promise<string | null> {
  const lift = input.overallRatePct > 0
    ? Math.round((input.bucketRatePct / input.overallRatePct) * 10) / 10
    : null

  const systemPrompt = `You are an intelligence assistant for a wedding-venue
coordinator. The platform has detected an attendee-mix outlier from the
venue's tour history: a particular attendee bucket books at a meaningfully
higher rate than the overall venue average.

Output JSON:
  {
    "insight": "<1-2 sentences. First sentence states the pattern. Second
                sentence states ONE concrete coordinator action.>"
  }

CRITICAL RULES:
- The ONLY numbers you may reference are the percentages, tour counts, and
  the lift ratio listed in the input block. Do NOT invent ratios,
  conversion gaps, or sample sizes.
- Lead with the action framing. Coordinators read this on a tour-prep
  surface; the value is "what should I do differently", not "what does
  the chart say".
- Never name specific couples, vendors, or third parties.
- Keep it to 1-2 sentences. No bullets, no markdown.
- Do not use em dashes. Use commas, periods, or "and / but / so" instead.
- No emojis. No exclamation marks.
- Do not promise a future booking. Frame the action as something to
  prioritise this week, not a guaranteed outcome.`

  const userPrompt = `ATTENDEE-MIX OUTLIER

Bucket label (coordinator-readable): ${input.bucketLabel}
Bucket key: ${input.bucket}
Booking rate for this bucket: ${input.bucketRatePct}%
Overall venue booking rate: ${input.overallRatePct}%
Lift vs overall (multiplier): ${lift !== null ? `${lift}x` : 'unavailable'}
Tours where this bucket was present: ${input.toursWithBucket} of ${input.totalTours}

Compose the JSON insight. 1-2 sentences. Numbers strictly from the
listed values.`

  const result = await callAIJson<AttendeeNarrationJson>({
    systemPrompt,
    userPrompt,
    maxTokens: 220,
    temperature: 0.4,
    venueId,
    taskType: 'attendee_intelligence_top',
    tier: 'sonnet',
    promptVersion: ATTENDEE_INTEL_PROMPT_VERSION,
  })

  const insight = (result?.insight ?? '').trim()
  if (!insight) return null
  // Strip stray em dashes the model might emit despite the prompt rule.
  return insight.replace(/—/g, ', ').replace(/\s+/g, ' ').trim()
}
