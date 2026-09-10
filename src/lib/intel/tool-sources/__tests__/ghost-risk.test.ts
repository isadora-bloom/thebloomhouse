/**
 * Ghost-risk tool source (battery Q19).
 *
 * The calibration service is mocked: whether analyzeCalibration computes a
 * Brier score correctly is its own unit's problem. What is this file's problem
 * is that a thin track record comes back as enoughData false with a reason and
 * no numbers attached, and a real one comes back with the numbers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CalibrationReport } from '@/lib/services/calibration/analyze'
import type { TouchpointRow } from '@/lib/services/cohort/types'
import { makeFakeSupabase } from './fake-supabase-memory'

const analyzeMock = vi.fn<(args: unknown) => Promise<CalibrationReport>>()
vi.mock('@/lib/services/calibration/analyze', () => ({
  analyzeCalibration: (args: unknown) => analyzeMock(args),
}))

// vi.mock is hoisted above this import, so the source under test picks up the
// stub rather than the real analyzer.
import { runGhostRisk, buildContactEvidence, ghostRiskSource } from '../ghost-risk'

interface RankedCouple {
  coupleId: string
  names: string | null
  riskTier: string
  evidence: Record<string, unknown>
  why: string[]
}
interface GhostRiskResult {
  ranked: { n: number; enoughData: boolean; reason?: string; couples: RankedCouple[] }
  calibration: {
    n: number
    enoughData: boolean
    reason?: string
    brierScore: number | null
    didNotBookCallAccuracyPct: number | null
    outcomesAwaitingMeasurement: number | null
  }
}

const VENUE = 'venue-1'
const TODAY = '2026-09-09'

function report(over: Partial<CalibrationReport>): CalibrationReport {
  return {
    venueId: VENUE,
    kind: 'close_probability_pct',
    windowDays: 365,
    generatedAt: `${TODAY}T00:00:00.000Z`,
    n: 0,
    brierScore: null,
    accuracyPct: null,
    above50AccuracyPct: null,
    below50AccuracyPct: null,
    meanAbsoluteErrorPct: null,
    reliabilityBins: [],
    perPersona: [],
    drift: [],
    diagnostics: {
      snapshotsTotal: 0,
      outcomesTotal: 0,
      pendingMeasurement: 0,
      sufficientForAnalysis: false,
    },
    ...over,
  }
}

function tp(over: Partial<TouchpointRow>): TouchpointRow {
  return {
    id: 'tp',
    couple_id: 'c',
    channel: 'gmail',
    action_type: 'reply',
    occurred_at: '2026-05-20T10:00:00.000Z',
    signal_tier: 'high',
    confidence_tier: 'high',
    raw_payload: null,
    ...over,
  }
}

/** One cold couple, one warm-and-recent couple that must be filtered out,
 *  and one channel-scoped couple with nothing on record. */
function tables() {
  return {
    couples: [
      {
        id: 'cold-1',
        venue_id: VENUE,
        merged_into_id: null,
        lifecycle_state: 'resolved',
        primary_contact_name: 'Ashley Rivera',
        partner_contact_name: 'Ryan Rivera',
        last_progression_at: '2026-05-20T00:00:00.000Z',
        decay_window_days: 120,
      },
      {
        id: 'warm-1',
        venue_id: VENUE,
        merged_into_id: null,
        lifecycle_state: 'resolved',
        primary_contact_name: 'Nia Okafor',
        partner_contact_name: null,
        last_progression_at: '2026-09-08T00:00:00.000Z',
        decay_window_days: 120,
      },
      {
        id: 'quiet-1',
        venue_id: VENUE,
        merged_into_id: null,
        lifecycle_state: 'channel_scoped',
        primary_contact_name: 'Unknown Saver',
        partner_contact_name: null,
        last_progression_at: null,
        decay_window_days: 120,
      },
      {
        id: 'other-venue',
        venue_id: 'venue-2',
        merged_into_id: null,
        lifecycle_state: 'resolved',
        primary_contact_name: 'Someone Else',
        partner_contact_name: null,
        last_progression_at: '2026-05-01T00:00:00.000Z',
        decay_window_days: 120,
      },
    ],
    touchpoints: [
      { ...tp({ id: 't1', couple_id: 'cold-1', channel: 'the_knot', action_type: 'reply', occurred_at: '2026-05-20T10:00:00.000Z' }), venue_id: VENUE },
      { ...tp({ id: 't2', couple_id: 'cold-1', channel: 'gmail', action_type: 'venue_sent', occurred_at: '2026-05-20T13:30:00.000Z' }), venue_id: VENUE },
      { ...tp({ id: 't3', couple_id: 'warm-1', channel: 'gmail', action_type: 'reply', occurred_at: '2026-09-08T09:00:00.000Z', signal_tier: 'highest' }), venue_id: VENUE },
    ],
  }
}

describe('ghost-risk tool source', () => {
  beforeEach(() => {
    analyzeMock.mockReset()
    analyzeMock.mockResolvedValue(report({}))
  })

  it('registers one tool, takes no model arguments, and claims Q19', () => {
    expect(ghostRiskSource.tool.name).toBe('get_ghost_risk')
    expect(ghostRiskSource.tool.input_schema.properties).toEqual({})
    expect(ghostRiskSource.batteryQuestions).toContain('19')
    // venueId must never be something the model can pick.
    expect(JSON.stringify(ghostRiskSource.tool.input_schema)).not.toContain('venue')
  })

  it('ranks the cold couple, drops the recent one, and carries its evidence', async () => {
    const supabase = makeFakeSupabase(tables())
    const out = (await runGhostRisk(VENUE, {}, { supabase, today: TODAY })) as GhostRiskResult
    const ranked = out.ranked

    expect(ranked.n).toBe(2)
    const ids = ranked.couples.map((c) => c.coupleId)
    expect(ids).toContain('cold-1')
    expect(ids).not.toContain('warm-1')
    expect(ids).not.toContain('other-venue')

    const cold = ranked.couples.find((c) => c.coupleId === 'cold-1')!
    expect(cold.riskTier).toBe('high')
    expect(cold.names).toBe('Ashley Rivera & Ryan Rivera')
    expect(cold.evidence.daysSilent).toBe(112)
    expect(cold.evidence.lastActivityOn).toBe('2026-05-20')
    expect(cold.evidence.firstTouchChannel).toBe('the_knot')
    expect(cold.evidence.lastTouchChannel).toBe('gmail')
    // 10:00 inbound, 13:30 reply.
    expect(cold.evidence.responseDelayHours).toBe(3.5)
    expect(cold.why.length).toBeGreaterThan(0)
  })

  it('says the predictor is not reliable yet when the track record is thin', async () => {
    analyzeMock.mockResolvedValue(report({ n: 6, diagnostics: { snapshotsTotal: 30, outcomesTotal: 6, pendingMeasurement: 24, sufficientForAnalysis: false } }))
    const supabase = makeFakeSupabase(tables())
    const out = (await runGhostRisk(VENUE, {}, { supabase, today: TODAY })) as GhostRiskResult
    expect(out.calibration.n).toBe(6)
    expect(out.calibration.enoughData).toBe(false)
    expect(out.calibration.reason).toMatch(/not yet reliable/i)
    // No numbers leak out of an unreliable predictor.
    expect(out.calibration.brierScore).toBeNull()
    expect(out.calibration.didNotBookCallAccuracyPct).toBeNull()
    expect(out.calibration.outcomesAwaitingMeasurement).toBe(24)
  })

  it('surfaces the measured hit rate once there are enough outcomes', async () => {
    analyzeMock.mockResolvedValue(
      report({
        n: 44,
        brierScore: 0.18,
        accuracyPct: 71.2,
        above50AccuracyPct: 64,
        below50AccuracyPct: 82.5,
        diagnostics: { snapshotsTotal: 60, outcomesTotal: 44, pendingMeasurement: 16, sufficientForAnalysis: true },
      }),
    )
    const supabase = makeFakeSupabase(tables())
    const out = (await runGhostRisk(VENUE, {}, { supabase, today: TODAY })) as GhostRiskResult
    expect(out.calibration.enoughData).toBe(true)
    expect(out.calibration.reason).toBeUndefined()
    expect(out.calibration.brierScore).toBe(0.18)
    expect(out.calibration.didNotBookCallAccuracyPct).toBe(82.5)
  })

  it('does not fail the whole call when calibration blows up', async () => {
    analyzeMock.mockRejectedValue(new Error('prediction_outcomes fetch failed'))
    const supabase = makeFakeSupabase(tables())
    const out = (await runGhostRisk(VENUE, {}, { supabase, today: TODAY })) as GhostRiskResult
    expect(out.ranked.n).toBe(2)
    expect(out.calibration.enoughData).toBe(false)
    expect(out.calibration.reason).toMatch(/could not be read/i)
  })

  it('returns an honest empty list rather than a fake zero when nobody is at risk', async () => {
    const supabase = makeFakeSupabase({ couples: [], touchpoints: [] })
    const out = (await runGhostRisk(VENUE, {}, { supabase, today: TODAY })) as GhostRiskResult
    expect(out.ranked.n).toBe(0)
    expect(out.ranked.enoughData).toBe(false)
    expect(out.ranked.reason).toBeTruthy()
    expect(out.ranked.couples).toEqual([])
  })

  describe('buildContactEvidence', () => {
    it('measures the delay from the first replyable message to the first reply', () => {
      const e = buildContactEvidence([
        tp({ id: 'a', action_type: 'tour_booked', channel: 'calendly', occurred_at: '2026-05-01T09:00:00.000Z' }),
        tp({ id: 'b', action_type: 'reply', channel: 'gmail', occurred_at: '2026-05-02T09:00:00.000Z' }),
        tp({ id: 'c', action_type: 'venue_sent', channel: 'gmail', occurred_at: '2026-05-02T11:00:00.000Z' }),
      ])
      expect(e.responseDelayHours).toBe(2)
      expect(e.firstTouchChannel).toBe('calendly')
      expect(e.touchpointCount).toBe(3)
      expect(e.responseDelayNote).toBeNull()
    })

    it('says why there is no delay when the venue has not replied', () => {
      const e = buildContactEvidence([tp({ action_type: 'reply' })])
      expect(e.responseDelayHours).toBeNull()
      expect(e.responseDelayNote).toMatch(/has not replied/i)
    })

    it('says why there is no delay when nothing replyable arrived', () => {
      const e = buildContactEvidence([tp({ action_type: 'tour_booked', channel: 'calendly' })])
      expect(e.responseDelayHours).toBeNull()
      expect(e.responseDelayNote).toMatch(/no replyable inbound/i)
    })
  })
})
