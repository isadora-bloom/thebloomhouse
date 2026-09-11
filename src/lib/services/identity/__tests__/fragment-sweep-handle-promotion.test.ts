/**
 * Pass 1 of the nightly fragment sweep: the handle-based promotion.
 *
 * At integration (2026-09-11) the seam W26 wrote against a not-yet-landed
 * W22 export was replaced by a direct call to W22's batch promotion in
 * ./fragment-sweep-handles.ts. These tests mock that module and pin the
 * mapping from its result onto the sweep's HandlePromotionResult, plus the
 * failure isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeSupabase } from './fragment-sweep-fake-supabase'

const { sweepFragmentsByHandleMock } = vi.hoisted(() => ({
  sweepFragmentsByHandleMock: vi.fn(),
}))

vi.mock('../fragment-sweep-handles', () => ({
  sweepFragmentsByHandle: sweepFragmentsByHandleMock,
  promoteFragmentsByHandle: vi.fn(),
  sweepFragmentsForCouple: vi.fn(),
}))

import { sweepHandlePromotionForVenue, type FragmentSweepState } from '../fragment-sweep'

const VENUE_ID = 'venue-handles'

function makeState(db: FakeSupabase): FragmentSweepState {
  return {
    venueId: VENUE_ID,
    supabase: db as unknown as FragmentSweepState['supabase'],
    runId: 'test-run-handles',
    couplesMinted: 0,
  }
}

beforeEach(() => {
  sweepFragmentsByHandleMock.mockReset()
})

describe('sweepHandlePromotionForVenue', () => {
  it('calls the batch promotion once for the venue and reports its counts', async () => {
    sweepFragmentsByHandleMock.mockResolvedValueOnce({
      scanned: 5,
      promoted: [
        { fragmentId: 'f1', coupleId: 'c1', platform: 'instagram', handle: 'amypark', touchpointsReanchored: 1 },
        { fragmentId: 'f2', coupleId: 'c1', platform: 'instagram', handle: 'amypark', touchpointsReanchored: 0 },
        { fragmentId: 'f3', coupleId: 'c2', platform: 'tiktok', handle: 'amyp', touchpointsReanchored: 2 },
      ],
      couplesTouched: 2,
      ambiguous: 0,
    })
    const db = new FakeSupabase()
    const result = await sweepHandlePromotionForVenue(makeState(db))

    expect(result).toEqual({ couplesWithHandles: 2, fragmentsPromoted: 3, skipped: false })
    expect(sweepFragmentsByHandleMock).toHaveBeenCalledTimes(1)
    expect(sweepFragmentsByHandleMock).toHaveBeenCalledWith({ supabase: db, venueId: VENUE_ID })
  })

  it('reports a failed pass honestly instead of throwing', async () => {
    sweepFragmentsByHandleMock.mockRejectedValueOnce(new Error('boom'))
    const result = await sweepHandlePromotionForVenue(makeState(new FakeSupabase()))

    expect(result).toEqual({ couplesWithHandles: 0, fragmentsPromoted: 0, skipped: true, reason: 'failed' })
  })

  it('is a no-op when no couple in the venue carries a handle', async () => {
    sweepFragmentsByHandleMock.mockResolvedValueOnce({ scanned: 0, promoted: [], couplesTouched: 0, ambiguous: 0 })
    const result = await sweepHandlePromotionForVenue(makeState(new FakeSupabase()))

    expect(result).toEqual({ couplesWithHandles: 0, fragmentsPromoted: 0, skipped: false })
  })
})
