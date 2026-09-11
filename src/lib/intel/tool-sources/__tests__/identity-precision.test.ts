/**
 * Identity-precision tool source (battery Q6, Q29, Q36).
 *
 * Two things these tests are really guarding. First, that the denominator is
 * right: a tombstoned couples row is a duplicate that was caught, a live row
 * is a couple, and the other venue's rows are neither. Second, that names come
 * back with the ids, because an operator cannot check a merge against a uuid,
 * and that a flagged pair is never dressed up as a merge that happened.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from './fake-supabase-memory'
import { runIdentityPrecision, identityPrecisionSource } from '../identity-precision'

const VENUE = 'venue-1'
const TODAY = '2026-09-09'

interface Side {
  id: string
  names: string | null
  tombstoned: boolean
  handles: Record<string, string>
}
interface ShapedMerge {
  eventType: string
  confidenceTier: string
  rule: string | null
  reason: string | null
  kept: Side | null
  foldedIn: Side | null
}
interface ShapedPair {
  confidenceTier: string
  matcherReason: string | null
  primary: { recordType: string; recordId: string; names: string | null; handles: Record<string, string> }
  secondary: { recordType: string; recordId: string; names: string | null; handles: Record<string, string> }
}
interface PrecisionResult {
  records: { totalRecords: number; uniqueCouples: number; duplicatesFolded: number; n: number }
  duplicateSharePercent: { value: number | null; n: number; enoughData: boolean; reason?: string }
  highestConfidenceMerges: { n: number; requested: number; merges: ShapedMerge[] }
  lowestConfidenceMerges: { n: number; merges: ShapedMerge[] }
  unmergedLookAlikes: { n: number; pairs: ShapedPair[] }
  flaggedSample: { askedFor: number; possiblyOverMerged: ShapedMerge[]; possiblyTheSameCouple: ShapedPair[] }
  caveat: string
}

function couple(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    venue_id: VENUE,
    primary_contact_name: name,
    partner_contact_name: null,
    lifecycle_state: 'resolved',
    merged_into_id: null,
    ...over,
  }
}

function merge(over: Record<string, unknown>) {
  return {
    venue_id: VENUE,
    event_type: 'candidate_confirmed',
    primary_couple_id: 'live-1',
    secondary_couple_id: 'dupe-1',
    confidence_tier: 'high',
    rule_triggered: 'email_exact',
    reason: 'Same email address on both records',
    occurred_at: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

function tables() {
  const couples = [
    couple('live-1', 'Ashley Rivera', { partner_contact_name: 'Ryan Rivera', handles: { instagram: 'ashley.rivera' } }),
    couple('live-2', 'Nia Okafor'),
    couple('live-3', 'Priya Raman', { handles: { instagram: 'priya.raman' } }),
    couple('live-4', 'Tom Beckett'),
    couple('live-5', 'Marta Silva'),
    couple('live-6', 'Owen Hale'),
    couple('live-7', 'Jess Mbeki'),
    couple('live-8', 'Sam Choi'),
    couple('dupe-1', 'A. Rivera', { merged_into_id: 'live-1', lifecycle_state: 'resolved' }),
    couple('dupe-2', 'N Okafor', { merged_into_id: 'live-2', lifecycle_state: 'resolved' }),
    { ...couple('elsewhere', 'Other Venue Couple'), venue_id: 'venue-2' },
  ]
  return {
    couples,
    couple_merge_events: [
      merge({}),
      merge({
        event_type: 'partner_reconciliation',
        primary_couple_id: 'live-2',
        secondary_couple_id: 'dupe-2',
        confidence_tier: 'low',
        rule_triggered: 'partner_first_name',
        reason: 'Same first name, different email',
        occurred_at: '2026-08-05T00:00:00.000Z',
      }),
      // Not a fusion — must never appear as a merge.
      merge({ event_type: 'couple_minted', secondary_couple_id: null, occurred_at: '2026-08-06T00:00:00.000Z' }),
      // Another venue's fusion.
      merge({ venue_id: 'venue-2', primary_couple_id: 'elsewhere', occurred_at: '2026-08-07T00:00:00.000Z' }),
    ],
    candidate_matches: [
      {
        venue_id: VENUE,
        primary_record_id: 'live-3',
        primary_record_type: 'couple',
        secondary_record_id: 'live-4',
        secondary_record_type: 'couple',
        confidence_tier: 'high',
        matcher_reason: 'Same surname and wedding date, different email domain',
        created_at: '2026-08-10T00:00:00.000Z',
        resolved_at: null,
      },
      {
        venue_id: VENUE,
        primary_record_id: 'live-5',
        primary_record_type: 'couple',
        secondary_record_id: 'frag-9',
        secondary_record_type: 'fragment',
        confidence_tier: 'low',
        matcher_reason: 'Shared phone prefix only',
        created_at: '2026-08-11T00:00:00.000Z',
        resolved_at: null,
      },
      // Already dealt with — not an open question.
      {
        venue_id: VENUE,
        primary_record_id: 'live-6',
        primary_record_type: 'couple',
        secondary_record_id: 'live-7',
        secondary_record_type: 'couple',
        confidence_tier: 'high',
        matcher_reason: 'resolved already',
        created_at: '2026-08-12T00:00:00.000Z',
        resolved_at: '2026-08-13T00:00:00.000Z',
      },
    ],
  }
}

describe('identity-precision tool source', () => {
  it('exposes only limit and claims Q6, Q29 and Q36', () => {
    expect(identityPrecisionSource.tool.name).toBe('get_identity_precision')
    const props = identityPrecisionSource.tool.input_schema.properties as Record<string, unknown>
    expect(Object.keys(props)).toEqual(['limit'])
    expect(identityPrecisionSource.batteryQuestions).toEqual(['6', '29', '36'])
    expect(JSON.stringify(identityPrecisionSource.tool.input_schema)).not.toContain('venue')
  })

  it('counts records against unique couples and reports the duplicate share', async () => {
    const supabase = makeFakeSupabase(tables())
    const out = (await runIdentityPrecision(VENUE, {}, { supabase, today: TODAY })) as PrecisionResult

    expect(out.records.totalRecords).toBe(10)
    expect(out.records.uniqueCouples).toBe(8)
    expect(out.records.duplicatesFolded).toBe(2)
    expect(out.duplicateSharePercent.enoughData).toBe(true)
    expect(out.duplicateSharePercent.value).toBe(20)
    expect(out.duplicateSharePercent.n).toBe(10)
  })

  it('returns names beside ids on both sides of every merge', async () => {
    const supabase = makeFakeSupabase(tables())
    const out = (await runIdentityPrecision(VENUE, {}, { supabase, today: TODAY })) as PrecisionResult

    expect(out.highestConfidenceMerges.n).toBe(1)
    const high = out.highestConfidenceMerges.merges[0]
    expect(high.confidenceTier).toBe('high')
    expect(high.kept?.names).toBe('Ashley Rivera & Ryan Rivera')
    expect(high.kept?.id).toBe('live-1')
    expect(high.kept?.handles).toEqual({ instagram: 'ashley.rivera' })
    expect(high.foldedIn?.names).toBe('A. Rivera')
    expect(high.foldedIn?.tombstoned).toBe(true)
    expect(high.foldedIn?.handles).toEqual({})
    expect(high.rule).toBe('email_exact')

    // A mint is not a fusion.
    const everyType = [...out.highestConfidenceMerges.merges, ...out.lowestConfidenceMerges.merges].map((m) => m.eventType)
    expect(everyType).not.toContain('couple_minted')
    // Nor is another venue's work.
    expect([...out.highestConfidenceMerges.merges, ...out.lowestConfidenceMerges.merges].every((m) => m.kept?.id !== 'elsewhere')).toBe(true)
  })

  it('puts the borderline merge in the low-confidence list with its reason', async () => {
    const supabase = makeFakeSupabase(tables())
    const out = (await runIdentityPrecision(VENUE, {}, { supabase, today: TODAY })) as PrecisionResult

    expect(out.lowestConfidenceMerges.n).toBe(1)
    const weak = out.lowestConfidenceMerges.merges[0]
    expect(weak.confidenceTier).toBe('low')
    expect(weak.reason).toMatch(/different email/i)
    expect(weak.kept?.names).toBe('Nia Okafor')
    expect(out.flaggedSample.possiblyOverMerged[0].confidenceTier).toBe('low')
  })

  it('returns unresolved pairs as open questions, highest matcher confidence first', async () => {
    const supabase = makeFakeSupabase(tables())
    const out = (await runIdentityPrecision(VENUE, {}, { supabase, today: TODAY })) as PrecisionResult

    expect(out.unmergedLookAlikes.n).toBe(2)
    const first = out.unmergedLookAlikes.pairs[0]
    expect(first.confidenceTier).toBe('high')
    expect(first.primary.names).toBe('Priya Raman')
    expect(first.primary.handles).toEqual({ instagram: 'priya.raman' })
    expect(first.secondary.names).toBe('Tom Beckett')
    expect(first.matcherReason).toMatch(/different email domain/i)

    // A non-couple record has no couple name to resolve, and says so with null
    // rather than borrowing one — same for handles, which come back {} not a
    // borrowed couple's map.
    const second = out.unmergedLookAlikes.pairs[1]
    expect(second.secondary.recordType).toBe('fragment')
    expect(second.secondary.names).toBeNull()
    expect(second.secondary.handles).toEqual({})

    // Resolved candidates are not open questions.
    const ids = out.unmergedLookAlikes.pairs.flatMap((p) => [p.primary.recordId, p.secondary.recordId])
    expect(ids).not.toContain('live-6')

    expect(out.caveat).toMatch(/never state a candidate pair as a merge/i)
    expect(out.flaggedSample.askedFor).toBe(5)
  })

  it('refuses a percentage when there are barely any records', async () => {
    const supabase = makeFakeSupabase({
      couples: [couple('live-1', 'Ashley Rivera'), couple('dupe-1', 'A. Rivera', { merged_into_id: 'live-1' })],
      couple_merge_events: [],
      candidate_matches: [],
    })
    const out = (await runIdentityPrecision(VENUE, {}, { supabase, today: TODAY })) as PrecisionResult
    expect(out.records.totalRecords).toBe(2)
    expect(out.duplicateSharePercent.value).toBeNull()
    expect(out.duplicateSharePercent.enoughData).toBe(false)
    expect(out.duplicateSharePercent.reason).toMatch(/minimum/i)
  })

  it('caps the limit at twenty however large the model asks for', async () => {
    const supabase = makeFakeSupabase(tables())
    const out = (await runIdentityPrecision(VENUE, { limit: 500 }, { supabase, today: TODAY })) as PrecisionResult
    expect(out.highestConfidenceMerges.requested).toBe(20)
  })
})
