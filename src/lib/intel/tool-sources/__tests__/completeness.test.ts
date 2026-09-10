/**
 * Record-completeness tool source (battery Q30).
 *
 * The thing worth pinning down is the definition, because "complete" is a
 * choice rather than a fact: these tests fix what the four criteria mean, that
 * the definition travels back with the answer, and that a window with almost
 * nothing in it returns counts and no percentage.
 */

import { describe, it, expect } from 'vitest'
import type { TouchpointRow } from '@/lib/services/cohort/types'
import { makeFakeSupabase } from './fake-supabase'
import {
  runRecordCompleteness,
  assessCoupleCompleteness,
  completenessSource,
  MAX_GAP_DAYS,
} from '../completeness'

const VENUE = 'venue-1'
const TODAY = '2026-09-09'

interface CompletenessResult {
  definition: { windowDays: number; maxGapDays: number; criteria: Record<string, string> }
  counts: { recordsInWindow: number; complete: number; partial: number }
  completePercent: { value: number | null; n: number; enoughData: boolean; reason?: string }
  failureCounts: Record<string, number>
  partialExamples: { n: number; of: number; couples: Array<{ coupleId: string; names: string | null; missing: string[] }> }
  canonicalBaseline: Record<string, unknown>
}

function tp(over: Partial<TouchpointRow>): TouchpointRow {
  return {
    id: 'tp',
    couple_id: 'c',
    channel: 'gmail',
    action_type: 'reply',
    occurred_at: '2026-08-01T10:00:00.000Z',
    signal_tier: 'high',
    confidence_tier: 'high',
    raw_payload: null,
    ...over,
  }
}

function couple(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    venue_id: VENUE,
    merged_into_id: null,
    primary_contact_name: `Couple ${id}`,
    partner_contact_name: null,
    primary_contact_email: `${id}@example.com`,
    primary_contact_phone: null,
    last_progression_at: '2026-08-20T00:00:00.000Z',
    ...over,
  }
}

/** Two touchpoints a day apart, an inbound then a venue reply — the shape a
 *  complete record has. */
function goodPair(id: string) {
  return [
    { ...tp({ id: `${id}-in`, couple_id: id, action_type: 'reply', occurred_at: '2026-08-20T09:00:00.000Z' }), venue_id: VENUE },
    { ...tp({ id: `${id}-out`, couple_id: id, action_type: 'venue_sent', occurred_at: '2026-08-20T11:00:00.000Z' }), venue_id: VENUE },
  ]
}

describe('completeness tool source', () => {
  it('exposes only window_days and claims Q30', () => {
    expect(completenessSource.tool.name).toBe('get_record_completeness')
    const props = completenessSource.tool.input_schema.properties as Record<string, unknown>
    expect(Object.keys(props)).toEqual(['window_days'])
    expect(completenessSource.batteryQuestions).toEqual(['30'])
    expect(JSON.stringify(completenessSource.tool.input_schema)).not.toContain('venue')
  })

  describe('assessCoupleCompleteness', () => {
    const base = {
      id: 'c1',
      primaryContactName: 'Ada',
      partnerContactName: 'Bo',
      primaryContactEmail: 'ada@example.com',
      primaryContactPhone: null,
    }

    it('calls a record complete when all four criteria hold', () => {
      const r = assessCoupleCompleteness(base, goodPair('c1') as TouchpointRow[])
      expect(r.complete).toBe(true)
      expect(r.missing).toEqual([])
      expect(r.names).toBe('Ada & Bo')
      expect(r.longestGapDays).toBeCloseTo(0.1, 1)
    })

    it('names every failing criterion rather than a bare false', () => {
      const r = assessCoupleCompleteness(
        { ...base, primaryContactEmail: '  ', primaryContactPhone: null },
        [],
      )
      expect(r.complete).toBe(false)
      expect(r.missing).toEqual(['hasFirstTouch', 'hasReply', 'hasIdentity'])
      expect(r.touchpointCount).toBe(0)
    })

    it('does not count a self-service booking as a message the venue answered', () => {
      const r = assessCoupleCompleteness(base, [
        tp({ action_type: 'tour_booked', channel: 'calendly' }),
        tp({ action_type: 'venue_sent', occurred_at: '2026-08-02T10:00:00.000Z' }),
      ])
      expect(r.missing).toContain('hasReply')
    })

    it('flags a hole between touchpoints but not silence since the last one', () => {
      const gapped = assessCoupleCompleteness(base, [
        tp({ id: 'a', action_type: 'reply', occurred_at: '2026-05-01T10:00:00.000Z' }),
        tp({ id: 'b', action_type: 'venue_sent', occurred_at: '2026-07-20T10:00:00.000Z' }),
      ])
      expect(gapped.longestGapDays).toBeGreaterThan(MAX_GAP_DAYS)
      expect(gapped.missing).toContain('noLongGap')

      // One old pair, close together, then nothing for months. No hole.
      const quiet = assessCoupleCompleteness(base, [
        tp({ id: 'a', action_type: 'reply', occurred_at: '2026-05-01T10:00:00.000Z' }),
        tp({ id: 'b', action_type: 'venue_sent', occurred_at: '2026-05-02T10:00:00.000Z' }),
      ])
      expect(quiet.missing).toEqual([])
    })
  })

  it('scores a window, returns the definition, and names the partial records', async () => {
    const couples = [
      couple('c1'),
      couple('c2'),
      couple('c3'),
      couple('c4'),
      couple('c5'),
      couple('c6'),
      couple('c7'),
      // No identifier at all.
      couple('c8', { primary_contact_email: null, primary_contact_phone: null }),
      // Outside the window.
      couple('old', { last_progression_at: '2025-01-01T00:00:00.000Z' }),
      // Another venue.
      { ...couple('elsewhere'), venue_id: 'venue-2' },
      // Already folded into another couple.
      couple('tombstoned', { merged_into_id: 'c1' }),
    ]
    const touchpoints = [
      ...goodPair('c1'),
      ...goodPair('c2'),
      ...goodPair('c3'),
      ...goodPair('c4'),
      ...goodPair('c5'),
      ...goodPair('c6'),
      ...goodPair('c8'),
      // c7 wrote and nobody answered.
      { ...tp({ id: 'c7-in', couple_id: 'c7', action_type: 'reply', occurred_at: '2026-08-20T09:00:00.000Z' }), venue_id: VENUE },
    ]
    const supabase = makeFakeSupabase({ couples, touchpoints })

    const out = (await runRecordCompleteness(VENUE, {}, { supabase, today: TODAY })) as CompletenessResult

    expect(out.definition.windowDays).toBe(90)
    expect(out.definition.maxGapDays).toBe(MAX_GAP_DAYS)
    expect(Object.keys(out.definition.criteria).sort()).toEqual([
      'hasFirstTouch',
      'hasIdentity',
      'hasReply',
      'noLongGap',
    ])

    // c1..c6 complete, c7 has no reply, c8 has no identifier. The old couple,
    // the other venue's couple and the tombstoned row are all out.
    expect(out.counts.recordsInWindow).toBe(8)
    expect(out.counts.complete).toBe(6)
    expect(out.counts.partial).toBe(2)
    expect(out.completePercent.enoughData).toBe(true)
    expect(out.completePercent.value).toBe(75)
    expect(out.completePercent.n).toBe(8)

    expect(out.failureCounts.hasReply).toBe(1)
    expect(out.failureCounts.hasIdentity).toBe(1)
    expect(out.failureCounts.hasFirstTouch).toBe(0)

    const named = out.partialExamples.couples.map((c) => c.coupleId).sort()
    expect(named).toEqual(['c7', 'c8'])
    expect(out.partialExamples.couples[0].names).toMatch(/Couple c/)

    // The product's existing narrower figure travels alongside, unchanged.
    expect(out.canonicalBaseline.couplesInWindow).toBe(8)
    expect(out.canonicalBaseline.complete).toBe(7)
  })

  it('returns counts and no percentage when the window is nearly empty', async () => {
    const supabase = makeFakeSupabase({
      couples: [couple('c1'), couple('c2')],
      touchpoints: goodPair('c1'),
    })
    const out = (await runRecordCompleteness(VENUE, {}, { supabase, today: TODAY })) as CompletenessResult
    expect(out.counts.recordsInWindow).toBe(2)
    expect(out.completePercent.value).toBeNull()
    expect(out.completePercent.enoughData).toBe(false)
    expect(out.completePercent.n).toBe(2)
    expect(out.completePercent.reason).toMatch(/minimum/i)
  })

  it('honours window_days', async () => {
    const supabase = makeFakeSupabase({
      couples: [couple('recent'), couple('older', { last_progression_at: '2026-06-01T00:00:00.000Z' })],
      touchpoints: [],
    })
    const narrow = (await runRecordCompleteness(VENUE, { window_days: 30 }, { supabase, today: TODAY })) as CompletenessResult
    expect(narrow.definition.windowDays).toBe(30)
    expect(narrow.counts.recordsInWindow).toBe(1)

    const wide = (await runRecordCompleteness(VENUE, { window_days: 365 }, { supabase, today: TODAY })) as CompletenessResult
    expect(wide.counts.recordsInWindow).toBe(2)
  })
})
