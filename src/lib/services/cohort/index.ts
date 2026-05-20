/**
 * D9 — couple-keyed cohort intelligence (Tier 8 / Appendix C §C.5).
 *
 * `buildCohortIntel` is the single entry point: it loads the
 * identity-first spine slice once, derives per-couple facts, and runs
 * every D9 analysis over them. The result answers ~20 of the 36
 * battery questions (§C.4) — funnel ratios, response-time
 * distributions, booking lead time, the conversion curve, text-pattern
 * trends, year-over-year volume, weather effects, and anomalies.
 *
 * Every distribution it returns carries its own `n` and an
 * `enoughData` flag; the surface layer must respect them so a median
 * over n=2 is never rendered as a confident fact (§C.6 Tier-4 honesty).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CohortIntel } from './types'
import { ENGAGED_STATES } from './types'
import { loadCohortData } from './data'
import { buildCoupleFacts } from './facts'
import { computeFunnel } from './funnel'
import { computeResponseTime } from './response-time'
import { computeLeadTime } from './lead-time'
import { computeCurve } from './curve'
import { computeTextPatterns } from './text-patterns'
import { computeYoY } from './yoy'
import { computeWeather } from './weather'
import { computeAnomalies } from './anomaly'

export interface BuildCohortIntelOptions {
  /** Inclusive lower bound on touchpoint occurred_at (ISO). Omit for a
   *  full-history sweep (the battery's YoY / trend questions need it). */
  since?: string | null
}

export async function buildCohortIntel(
  supabase: SupabaseClient,
  venueId: string,
  opts: BuildCohortIntelOptions = {},
): Promise<CohortIntel> {
  const data = await loadCohortData(supabase, venueId, { since: opts.since })
  const facts = buildCoupleFacts(data)

  // Async analyses (need their own scoped DB reads) in parallel.
  const [yoy, weather] = await Promise.all([
    computeYoY(data, facts, supabase),
    computeWeather(data, supabase),
  ])

  const occurredAts = data.touchpoints.map((t) => t.occurred_at)
  const earliestTouchpoint =
    occurredAts.length > 0
      ? occurredAts.reduce((a, b) => (a < b ? a : b))
      : null
  const latestTouchpoint =
    occurredAts.length > 0
      ? occurredAts.reduce((a, b) => (a > b ? a : b))
      : null

  return {
    venueId,
    generatedAt: new Date().toISOString(),
    timezone: data.timezone,
    meta: {
      coupleCount: data.couples.length,
      engagedCoupleCount: data.couples.filter((c) =>
        (ENGAGED_STATES as readonly string[]).includes(c.lifecycle_state),
      ).length,
      touchpointCount: data.touchpoints.length,
      earliestTouchpoint,
      latestTouchpoint,
    },
    funnel: computeFunnel(data, facts),
    responseTime: computeResponseTime(data, facts),
    leadTime: computeLeadTime(facts),
    curve: computeCurve(facts),
    textPatterns: computeTextPatterns(data, facts),
    yoy,
    weather,
    anomalies: computeAnomalies(data, facts),
  }
}

export type { CohortIntel } from './types'
