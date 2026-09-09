/**
 * Wave 18 follow-up / W6 (November Plan, 2026-09-08). The missing
 * calibration -> prediction feedback edge.
 *
 * LOOP-ASSESSMENT.md Loop 2 verdict: "analyzeCalibration is pure
 * read-only reporting... the prediction model never reads calibration
 * history. The feedback edge from 'we were 20% over-confident on
 * persona X' back into 'adjust persona X predictions' does not exist
 * in code." This file is that edge.
 *
 * Two halves, deliberately split:
 *
 *   1. buildPersonaBiasSummary() — PURE. No Supabase, no callAI, no
 *      Date.now(). Takes the per-persona rows analyzeCalibration()
 *      already computes and turns them into plain-English bias
 *      statements ("persona X predictions ran +12 points hot over
 *      n=34") plus one formatted prompt block. This is the unit the
 *      task asked to be fixture-testable — see bias-summary.test.ts.
 *
 *   2. loadPersonaBiasSummaryForVenue() — the I/O wiring. Calls
 *      analyzeCalibration() for a venue and feeds its perPersona rows
 *      into the pure builder. This is what per-couple-derive.ts
 *      actually calls; kept thin on purpose so the pure function stays
 *      the source of truth for the bias arithmetic + wording.
 *
 * Threshold: n >= 20. Below that a persona's average-predicted vs
 * average-actual gap is noise, not bias — same rule of thumb
 * analyze.ts already uses for "sufficientForAnalysis" on the headline
 * metric (diagnostics.sufficientForAnalysis, analyze.ts:460).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PersonaCalibrationRow } from './analyze'

// ---------------------------------------------------------------------------
// Pure summary builder
// ---------------------------------------------------------------------------

/** Below this many samples, a persona's average-predicted-vs-actual gap
 * is noise, not a bias worth correcting for. Mirrors analyze.ts's own
 * "sufficientForAnalysis" rule of thumb (n >= 20) at the headline level. */
export const PERSONA_BIAS_MIN_N = 20

/** Below this many points of |bias| we call the persona well-calibrated
 * rather than flagging a fractional-point "hot"/"cold" as noise. */
const NEUTRAL_BAND_POINTS = 2

export type PersonaBiasDirection = 'hot' | 'cold' | 'neutral'

export interface PersonaBiasEntry {
  persona: string
  n: number
  /**
   * avgPredictedPct - avgActualPct, rounded to 1 decimal place.
   * Positive = the model over-predicted booking likelihood for this
   * persona (ran hot / overconfident) — correction is to score lower.
   * Negative = under-predicted (ran cold) — correction is to score
   * higher.
   */
  biasPoints: number
  direction: PersonaBiasDirection
  /** e.g. "persona Budget-Conscious Planners predictions ran +12 points hot over n=34" */
  summary: string
}

export interface PersonaBiasSummary {
  /** Every persona at n >= minN, sorted by |biasPoints| descending
   * (largest miscalibration first) so a truncated read still surfaces
   * what matters most. Includes 'neutral' entries so callers can see
   * what WAS checked, not just what needs correcting. */
  entries: PersonaBiasEntry[]
  /**
   * Ready-to-inject prompt text. Empty string when there is nothing to
   * correct (no persona at n >= minN, or every qualifying persona is
   * within the neutral band). Callers should skip the section entirely
   * when this is empty rather than injecting a block that says nothing.
   */
  promptBlock: string
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Turn per-persona calibration rows into a bias summary + a correction
 * prompt block. Pure — deterministic given the same input, no I/O.
 *
 * @param personaRows  The same shape as analyzeCalibration()'s
 *   `perPersona` field (calibration/analyze.ts). Only `persona`, `n`,
 *   `avgPredictedPct`, `avgActualPct` are read.
 * @param options.minN Override the n >= 20 threshold (tests only).
 */
export function buildPersonaBiasSummary(
  personaRows: ReadonlyArray<
    Pick<PersonaCalibrationRow, 'persona' | 'n' | 'avgPredictedPct' | 'avgActualPct'>
  >,
  options: { minN?: number } = {},
): PersonaBiasSummary {
  const minN = options.minN ?? PERSONA_BIAS_MIN_N
  const entries: PersonaBiasEntry[] = []

  for (const row of personaRows) {
    if (!row || row.n < minN) continue
    if (row.avgPredictedPct === null || row.avgActualPct === null) continue

    const biasPoints = round1(row.avgPredictedPct - row.avgActualPct)
    const direction: PersonaBiasDirection =
      biasPoints > NEUTRAL_BAND_POINTS
        ? 'hot'
        : biasPoints < -NEUTRAL_BAND_POINTS
          ? 'cold'
          : 'neutral'

    const summary =
      direction === 'neutral'
        ? `persona ${row.persona} predictions are well-calibrated over n=${row.n}`
        : `persona ${row.persona} predictions ran ${biasPoints > 0 ? '+' : ''}${biasPoints} points ${direction} over n=${row.n}`

    entries.push({ persona: row.persona, n: row.n, biasPoints, direction, summary })
  }

  // Largest miscalibration first — a correction that matters more
  // should not get buried after five neutral entries.
  entries.sort((a, b) => Math.abs(b.biasPoints) - Math.abs(a.biasPoints))

  const correctable = entries.filter((e) => e.direction !== 'neutral')
  const promptBlock =
    correctable.length === 0
      ? ''
      : [
          'CALIBRATION CORRECTION (measured against real booking outcomes, not a guess):',
          ...correctable.map(
            (e) =>
              `- ${e.summary}. If this couple's persona matches "${e.persona}", adjust your raw ` +
              `close-probability estimate ${e.direction === 'hot' ? 'DOWN' : 'UP'} by roughly ` +
              `${Math.abs(e.biasPoints)} points before settling on a final number.`,
          ),
          'This is a nudge, not a rule — still ground the final number in this couple\'s own evidence.',
        ].join('\n')

  return { entries, promptBlock }
}

// ---------------------------------------------------------------------------
// I/O wiring — thin. All the logic above is pure; this just supplies it.
// ---------------------------------------------------------------------------

export interface LoadPersonaBiasSummaryOptions {
  supabase?: SupabaseClient
  /** Window fed to analyzeCalibration(). Defaults to a year so a
   * slow-booking venue still accumulates enough terminal outcomes to
   * clear PERSONA_BIAS_MIN_N. */
  windowDays?: number
  kind?: string
  minN?: number
}

/**
 * Load calibration history for a venue and summarise it into a
 * PersonaBiasSummary. Not pure (calls analyzeCalibration -> Supabase).
 * Callers (per-couple-derive.ts) should treat failures as "no
 * correction available" rather than fatal — calibration data simply
 * may not exist yet for a new venue.
 */
export async function loadPersonaBiasSummaryForVenue(
  venueId: string,
  options: LoadPersonaBiasSummaryOptions = {},
): Promise<PersonaBiasSummary> {
  const { analyzeCalibration } = await import('./analyze')
  const report = await analyzeCalibration({
    venueId,
    kind: options.kind ?? 'close_probability_pct',
    windowDays: options.windowDays ?? 365,
    supabase: options.supabase,
  })
  return buildPersonaBiasSummary(report.perPersona, { minN: options.minN })
}
