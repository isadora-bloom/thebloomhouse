/**
 * Handle-based promotion seam (W22 `sweepFragmentsForCouple`),
 * exercised with `../identity-cascade` mocked to provide that export.
 * This is the "once W22 lands it" half of the seam documented on
 * `sweepHandlePromotionForVenue` in fragment-sweep.ts — kept in its
 * own file so the mock doesn't leak into the orchestration tests that
 * want to see the real (current) not-wired behaviour.
 *
 * The mock preserves every REAL export of identity-cascade.ts
 * (matcher.ts depends on `cascadeMatch` etc via its own import, and
 * this file's fake couples/fragments don't touch that path anyway,
 * but preserving actual exports keeps this test honest about what it
 * is and is not replacing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeSupabase } from './fragment-sweep-fake-supabase'

// vi.mock factories are hoisted above all other top-level code in this
// file, so the mock fn they close over must be created via
// vi.hoisted() rather than a plain top-level const — otherwise it is
// referenced before its own initializer runs.
const { sweepFragmentsForCoupleMock } = vi.hoisted(() => ({
  sweepFragmentsForCoupleMock: vi.fn(
    async (_supabase: unknown, _venueId: string, coupleId: string) => {
      // Deterministic per-couple result keyed off the id so
      // assertions can tell which couple each call was for.
      return { fragmentsPromoted: coupleId === 'couple-with-handle-1' ? 2 : 1 }
    },
  ),
}))

vi.mock('../identity-cascade', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../identity-cascade')>()
  return {
    ...actual,
    sweepFragmentsForCouple: sweepFragmentsForCoupleMock,
  }
})

// Imported AFTER the mock is registered (vi.mock is hoisted by
// vitest, so this ordering in source is fine either way, but written
// this way for readability).
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
  sweepFragmentsForCoupleMock.mockClear()
})

describe('sweepHandlePromotionForVenue (wired)', () => {
  it('calls sweepFragmentsForCouple once per couple that carries a handle, and sums fragmentsPromoted', async () => {
    const db = new FakeSupabase()
    db.table('couples').push(
      { id: 'couple-with-handle-1', venue_id: VENUE_ID, handles: [{ platform: 'instagram', handle: 'amypark' }] },
      { id: 'couple-with-handle-2', venue_id: VENUE_ID, handles: [{ platform: 'tiktok', handle: 'amyp' }] },
      { id: 'couple-no-handle', venue_id: VENUE_ID, handles: null },
      { id: 'couple-empty-handles', venue_id: VENUE_ID, handles: [] },
    )
    const state = makeState(db)

    const result = await sweepHandlePromotionForVenue(state)

    expect(result.skipped).toBe(false)
    // Only the two couples with a non-empty handles array count.
    expect(result.couplesWithHandles).toBe(2)
    expect(result.fragmentsPromoted).toBe(3) // 2 + 1
    expect(sweepFragmentsForCoupleMock).toHaveBeenCalledTimes(2)
    expect(sweepFragmentsForCoupleMock).toHaveBeenCalledWith(db, VENUE_ID, 'couple-with-handle-1')
    expect(sweepFragmentsForCoupleMock).toHaveBeenCalledWith(db, VENUE_ID, 'couple-with-handle-2')
  })

  it('isolates a per-couple failure so one bad couple does not stop the pass', async () => {
    sweepFragmentsForCoupleMock.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const db = new FakeSupabase()
    db.table('couples').push(
      { id: 'couple-fails', venue_id: VENUE_ID, handles: [{ platform: 'instagram', handle: 'x' }] },
      { id: 'couple-ok', venue_id: VENUE_ID, handles: [{ platform: 'instagram', handle: 'y' }] },
    )
    const state = makeState(db)

    const result = await sweepHandlePromotionForVenue(state)

    expect(result.couplesWithHandles).toBe(2)
    expect(result.fragmentsPromoted).toBe(1) // only the couple that didn't throw
    expect(sweepFragmentsForCoupleMock).toHaveBeenCalledTimes(2)
  })

  it('is a no-op when no couple in the venue carries a handle', async () => {
    const db = new FakeSupabase()
    db.table('couples').push({ id: 'couple-no-handle', venue_id: VENUE_ID, handles: null })
    const state = makeState(db)

    const result = await sweepHandlePromotionForVenue(state)

    expect(result).toEqual({ couplesWithHandles: 0, fragmentsPromoted: 0, skipped: false })
    expect(sweepFragmentsForCoupleMock).not.toHaveBeenCalled()
  })
})
