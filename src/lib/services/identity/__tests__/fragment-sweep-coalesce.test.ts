/**
 * Identity-hint cross-channel coalesce — moved verbatim from the
 * retired tracer.ts (Wave 3 W26, NOVEMBER-PLAN.md / HANDLE-IDENTITY-
 * SPEC.md §5). Same score threshold (91), same 14-day pair window,
 * same couple_merge_events 'fragment_promoted' audit row.
 *
 * `lockAndMintCouple` (mint-couple.ts) is mocked so these tests pin
 * the coalesce's OWN decision logic (bucketing, pair scoring,
 * threshold, transitive promotion) without depending on the mint
 * RPC's behaviour, which has its own test coverage elsewhere.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeSupabase } from './fragment-sweep-fake-supabase'
import {
  sweepIdentityHintCoalesce,
  FRAGMENT_PROMOTE_MIN_SCORE,
  type FragmentSweepState,
} from '../fragment-sweep'

const VENUE_ID = 'venue-1'

let mintCounter = 0
vi.mock('../mint-couple', () => ({
  lockAndMintCouple: vi.fn(async (_supabase: unknown, _venueId: string) => {
    mintCounter += 1
    return {
      coupleId: `couple-${mintCounter}`,
      minted: true,
      touchpointInserted: true,
      touchpointId: `tp-${mintCounter}`,
    }
  }),
}))

import { lockAndMintCouple } from '../mint-couple'

function makeState(db: FakeSupabase): FragmentSweepState {
  return {
    venueId: VENUE_ID,
    // FakeSupabase implements only the query-builder surface this
    // module touches — cast past the real SupabaseClient shape.
    supabase: db as unknown as FragmentSweepState['supabase'],
    runId: 'test-run',
    couplesMinted: 0,
  }
}

function addFragment(
  db: FakeSupabase,
  id: string,
  channel: string,
  identityHint: string,
  occurredAt: string,
) {
  db.table('fragments').push({
    id,
    venue_id: VENUE_ID,
    channel,
    identity_hint: identityHint,
    occurred_at: occurredAt,
    promoted_to_couple_id: null,
  })
}

beforeEach(() => {
  mintCounter = 0
  vi.mocked(lockAndMintCouple).mockClear()
})

describe('sweepIdentityHintCoalesce', () => {
  it('auto-promotes a cross-channel pair scoring above FRAGMENT_PROMOTE_MIN_SCORE', async () => {
    // full_name_exact (60) + cross_channel_temporal_lt_6h (35) = 95,
    // which clears the 91 threshold. Same identity_hint, different
    // channels, 2 hours apart.
    const db = new FakeSupabase()
    addFragment(db, 'f1', 'knot', 'Sarah Ross', '2026-01-01T00:00:00.000Z')
    addFragment(db, 'f2', 'instagram', 'Sarah Ross', '2026-01-01T02:00:00.000Z')
    const state = makeState(db)

    const result = await sweepIdentityHintCoalesce(state)

    expect(result.fragmentsScanned).toBe(2)
    expect(result.promoted).toBe(1)
    expect(lockAndMintCouple).toHaveBeenCalledTimes(1)

    const frags = db.table('fragments')
    const f1 = frags.find((r) => r.id === 'f1')!
    const f2 = frags.find((r) => r.id === 'f2')!
    expect(f1.promoted_to_couple_id).toBe('couple-1')
    expect(f2.promoted_to_couple_id).toBe('couple-1')

    const audit = db.table('couple_merge_events')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.event_type).toBe('fragment_promoted')
    expect(audit[0]!.rule_triggered).toBe('cross_channel_coalesce')
    expect(audit[0]!.primary_couple_id).toBe('couple-1')
  })

  it('queues a candidate_match instead of promoting when the score lands in the 30-90 band', async () => {
    // A single-token identity_hint ("Sarah") never satisfies the
    // matcher's full-name checks (cascade exact_full_name included —
    // that needs a real first+last pair), so the only signal that
    // fires is cross_channel_temporal_lt_6h (35): below
    // FRAGMENT_PROMOTE_MIN_SCORE (91) but above the >=30 queue floor.
    const db = new FakeSupabase()
    addFragment(db, 'f1', 'knot', 'Sarah', '2026-01-01T00:00:00.000Z')
    addFragment(db, 'f2', 'pinterest', 'Sarah', '2026-01-01T02:00:00.000Z')
    const state = makeState(db)

    const result = await sweepIdentityHintCoalesce(state)

    expect(result.promoted).toBe(0)
    expect(result.candidatesQueued).toBe(1)
    expect(lockAndMintCouple).not.toHaveBeenCalled()

    const frags = db.table('fragments')
    expect(frags.find((r) => r.id === 'f1')!.promoted_to_couple_id).toBeNull()
    expect(frags.find((r) => r.id === 'f2')!.promoted_to_couple_id).toBeNull()

    const candidates = db.table('candidate_matches')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.primary_record_type).toBe('fragment')
    expect(candidates[0]!.secondary_record_type).toBe('fragment')
  })

  it('never scores a same-channel pair, even with an identical hint', async () => {
    const db = new FakeSupabase()
    addFragment(db, 'f1', 'knot', 'Sarah Ross', '2026-01-01T00:00:00.000Z')
    addFragment(db, 'f2', 'knot', 'Sarah Ross', '2026-01-01T01:00:00.000Z')
    const state = makeState(db)

    const result = await sweepIdentityHintCoalesce(state)

    expect(result.promoted).toBe(0)
    expect(result.candidatesQueued).toBe(0)
    expect(lockAndMintCouple).not.toHaveBeenCalled()
  })

  it('does not promote a pair outside the 14-day window', async () => {
    const db = new FakeSupabase()
    addFragment(db, 'f1', 'knot', 'Sarah Ross', '2026-01-01T00:00:00.000Z')
    addFragment(db, 'f2', 'instagram', 'Sarah Ross', '2026-01-20T00:00:00.000Z')
    const state = makeState(db)

    const result = await sweepIdentityHintCoalesce(state)

    // Still scores full_name_exact (60, no temporal bonus past 2
    // weeks) — that is the 30-90 candidate band, not a hard skip, so
    // it queues rather than promoting.
    expect(result.promoted).toBe(0)
    expect(lockAndMintCouple).not.toHaveBeenCalled()
  })

  it('transitively joins a third same-hint fragment onto an already-promoted couple', async () => {
    const db = new FakeSupabase()
    addFragment(db, 'f1', 'knot', 'Sarah Ross', '2026-01-01T00:00:00.000Z')
    addFragment(db, 'f2', 'instagram', 'Sarah Ross', '2026-01-01T02:00:00.000Z')
    addFragment(db, 'f3', 'pinterest', 'Sarah Ross', '2026-01-01T03:00:00.000Z')
    const state = makeState(db)

    const result = await sweepIdentityHintCoalesce(state)

    expect(result.promoted).toBeGreaterThanOrEqual(1)
    // All three fragments land on the SAME couple — only one mint.
    expect(lockAndMintCouple).toHaveBeenCalledTimes(1)
    const frags = db.table('fragments')
    const coupleIds = new Set(frags.map((r) => r.promoted_to_couple_id))
    expect(coupleIds.size).toBe(1)
    expect(coupleIds.has(null)).toBe(false)
  })

  it('is a no-op on an empty fragment set', async () => {
    const db = new FakeSupabase()
    const state = makeState(db)
    const result = await sweepIdentityHintCoalesce(state)
    expect(result).toEqual({ fragmentsScanned: 0, promoted: 0, candidatesQueued: 0 })
  })

  it('FRAGMENT_PROMOTE_MIN_SCORE stays above the matcher judge band ceiling (90)', () => {
    // Doctrine: promotion fires only above the band where a
    // human/LLM judge is required (matcher.ts JUDGE_BAND_HIGH).
    expect(FRAGMENT_PROMOTE_MIN_SCORE).toBeGreaterThan(90)
  })
})
