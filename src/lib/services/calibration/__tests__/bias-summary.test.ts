/**
 * Unit tests for bias-summary.ts's buildPersonaBiasSummary — pure
 * function, fixture-driven, no Supabase/mocks needed.
 *
 * Covers:
 *   - n < 20 personas are dropped entirely
 *   - hot bias (over-predicted) produces a DOWN correction
 *   - cold bias (under-predicted) produces an UP correction
 *   - within-neutral-band personas are kept in `entries` but excluded
 *     from the prompt block
 *   - empty/insufficient input yields an empty promptBlock
 *   - entries are sorted by |biasPoints| descending
 *   - the minN override option
 */

import { describe, it, expect } from 'vitest'
import { buildPersonaBiasSummary, PERSONA_BIAS_MIN_N } from '@/lib/services/calibration/bias-summary'
import type { PersonaCalibrationRow } from '@/lib/services/calibration/analyze'

function row(
  persona: string,
  n: number,
  avgPredictedPct: number | null,
  avgActualPct: number | null,
): PersonaCalibrationRow {
  return {
    persona,
    n,
    brierScore: null,
    accuracyPct: null,
    avgPredictedPct,
    avgActualPct,
  }
}

describe('buildPersonaBiasSummary', () => {
  it('drops personas below the n=20 threshold', () => {
    const rows = [row('Small Sample', 19, 80, 40)]
    const result = buildPersonaBiasSummary(rows)
    expect(result.entries).toHaveLength(0)
    expect(result.promptBlock).toBe('')
  })

  it('keeps personas at exactly n=20', () => {
    const rows = [row('Right At Threshold', 20, 80, 40)]
    const result = buildPersonaBiasSummary(rows)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].persona).toBe('Right At Threshold')
  })

  it('flags an over-predicting persona as hot with a DOWN correction', () => {
    const rows = [row('Destination Dreamers', 34, 62, 50)]
    const result = buildPersonaBiasSummary(rows)
    expect(result.entries).toHaveLength(1)
    const entry = result.entries[0]
    expect(entry.direction).toBe('hot')
    expect(entry.biasPoints).toBe(12)
    expect(entry.summary).toBe(
      'persona Destination Dreamers predictions ran +12 points hot over n=34',
    )
    expect(result.promptBlock).toContain('Destination Dreamers')
    expect(result.promptBlock).toContain('DOWN')
    expect(result.promptBlock).toContain('12 points')
  })

  it('flags an under-predicting persona as cold with an UP correction', () => {
    const rows = [row('Budget-Conscious Planners', 40, 38, 50)]
    const result = buildPersonaBiasSummary(rows)
    const entry = result.entries[0]
    expect(entry.direction).toBe('cold')
    expect(entry.biasPoints).toBe(-12)
    expect(entry.summary).toBe(
      'persona Budget-Conscious Planners predictions ran -12 points cold over n=40',
    )
    expect(result.promptBlock).toContain('UP')
    expect(result.promptBlock).toContain('12 points')
  })

  it('treats small gaps inside the neutral band as well-calibrated', () => {
    const rows = [row('Well Calibrated', 25, 51, 50)]
    const result = buildPersonaBiasSummary(rows)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].direction).toBe('neutral')
    expect(result.entries[0].summary).toBe(
      'persona Well Calibrated predictions are well-calibrated over n=25',
    )
    // Neutral entries are reported but never injected as a correction.
    expect(result.promptBlock).toBe('')
  })

  it('returns an empty summary for no input', () => {
    const result = buildPersonaBiasSummary([])
    expect(result.entries).toEqual([])
    expect(result.promptBlock).toBe('')
  })

  it('skips rows with null predicted/actual percentages', () => {
    const rows = [
      row('Missing Predicted', 30, null, 50),
      row('Missing Actual', 30, 50, null),
    ]
    const result = buildPersonaBiasSummary(rows)
    expect(result.entries).toHaveLength(0)
  })

  it('sorts entries by |biasPoints| descending, largest miscalibration first', () => {
    const rows = [
      row('Small Bias', 25, 55, 50), // +5, hot
      row('Huge Bias', 25, 90, 40), // +50, hot
      row('Medium Bias', 25, 30, 50), // -20, cold
    ]
    const result = buildPersonaBiasSummary(rows)
    expect(result.entries.map((e) => e.persona)).toEqual([
      'Huge Bias',
      'Medium Bias',
      'Small Bias',
    ])
  })

  it('includes every correctable persona in the prompt block, not just the first', () => {
    const rows = [
      row('Hot Persona', 25, 80, 50), // +30, hot
      row('Cold Persona', 25, 20, 50), // -30, cold
    ]
    const result = buildPersonaBiasSummary(rows)
    expect(result.promptBlock).toContain('Hot Persona')
    expect(result.promptBlock).toContain('Cold Persona')
  })

  it('honours a custom minN override', () => {
    const rows = [row('Tiny Venue Persona', 5, 80, 40)]
    const dropped = buildPersonaBiasSummary(rows)
    expect(dropped.entries).toHaveLength(0)

    const kept = buildPersonaBiasSummary(rows, { minN: 5 })
    expect(kept.entries).toHaveLength(1)
  })

  it('exports the documented default threshold', () => {
    expect(PERSONA_BIAS_MIN_N).toBe(20)
  })

  it('the promptBlock leads with a header naming real outcomes, not a guess', () => {
    const rows = [row('Any Persona', 25, 80, 50)]
    const result = buildPersonaBiasSummary(rows)
    expect(result.promptBlock.startsWith('CALIBRATION CORRECTION')).toBe(true)
  })
})
