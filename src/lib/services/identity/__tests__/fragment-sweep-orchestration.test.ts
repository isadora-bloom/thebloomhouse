/**
 * Sweep orchestration — `sweepFragmentsForVenue` / `sweepFragmentsAllVenues`
 * with a fake Supabase client (Wave 3 W26, NOVEMBER-PLAN.md).
 *
 * The handle pass (W22, ./fragment-sweep-handles.ts) is mocked to a clean
 * zero result so this file exercises the orchestration and the coalesce
 * pass only. See fragment-sweep-handle-promotion.test.ts for pass 1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeSupabase } from './fragment-sweep-fake-supabase'
import { sweepFragmentsForVenue, sweepFragmentsAllVenues } from '../fragment-sweep'

vi.mock('../fragment-sweep-handles', () => ({
  sweepFragmentsByHandle: vi.fn(async () => ({ scanned: 0, promoted: [], couplesTouched: 0, ambiguous: 0 })),
  promoteFragmentsByHandle: vi.fn(),
  sweepFragmentsForCouple: vi.fn(),
}))

vi.mock('../mint-couple', () => ({
  lockAndMintCouple: vi.fn(async () => ({
    coupleId: 'couple-orch-1',
    minted: true,
    touchpointInserted: true,
    touchpointId: 'tp-orch-1',
  })),
}))

function addFragment(
  db: FakeSupabase,
  id: string,
  venueId: string,
  channel: string,
  identityHint: string,
  occurredAt: string,
) {
  db.table('fragments').push({
    id,
    venue_id: venueId,
    channel,
    identity_hint: identityHint,
    occurred_at: occurredAt,
    promoted_to_couple_id: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sweepFragmentsForVenue', () => {
  it('runs both passes, reports an empty handle pass honestly, and writes started+succeeded telemetry', async () => {
    const db = new FakeSupabase()
    addFragment(db, 'f1', 'venue-a', 'knot', 'Amy Park', '2026-02-01T00:00:00.000Z')
    addFragment(db, 'f2', 'venue-a', 'instagram', 'Amy Park', '2026-02-01T01:00:00.000Z')

    const summary = await sweepFragmentsForVenue(
      db as unknown as Parameters<typeof sweepFragmentsForVenue>[0],
      'venue-a',
    )

    expect(summary.status).toBe('succeeded')
    expect(summary.venue_id).toBe('venue-a')
    expect(summary.handle_promotion).toEqual({
      couplesWithHandles: 0,
      fragmentsPromoted: 0,
      skipped: false,
    })
    // full_name_exact (60) + cross_channel_temporal_lt_6h (35) = 95 — promoted.
    expect(summary.identity_hint_coalesce.promoted).toBe(1)
    expect(summary.couples_minted).toBe(1)

    const events = db.table('tracer_run_events').filter((r) => r.venue_id === 'venue-a')
    const stages = events.map((e) => e.stage)
    const statuses = events.map((e) => e.status)
    expect(stages.every((s) => s === 'fragment_sweep')).toBe(true)
    expect(statuses).toContain('started')
    expect(statuses).toContain('succeeded')
    expect(statuses).not.toContain('failed')
  })

  it('never throws and records a failed telemetry row when a pass errors', async () => {
    const db = new FakeSupabase()
    // Force a failure: make the fragments table's rows non-iterable by
    // stubbing `.table()` to throw when sweepIdentityHintCoalesce reads
    // it a second time isn't practical with this fake, so instead we
    // corrupt the row shape to make Date.parse blow up isn't
    // deterministic either. Simplest reliable fault injection: patch
    // `from` to throw for the 'fragments' select specifically.
    const originalFrom = db.from.bind(db)
    db.from = ((name: string) => {
      if (name === 'fragments') {
        throw new Error('simulated fragments read failure')
      }
      return originalFrom(name)
    }) as typeof db.from

    const summary = await sweepFragmentsForVenue(
      db as unknown as Parameters<typeof sweepFragmentsForVenue>[0],
      'venue-b',
    )

    expect(summary.status).toBe('failed')
    expect(summary.error).toContain('simulated fragments read failure')

    // Restore so we can inspect telemetry written before the failure.
    db.from = originalFrom
    const events = db.table('tracer_run_events').filter((r) => r.venue_id === 'venue-b')
    expect(events.some((e) => e.status === 'started')).toBe(true)
    expect(events.some((e) => e.status === 'failed')).toBe(true)
  })
})

describe('sweepFragmentsAllVenues', () => {
  it('sweeps every venue and isolates per-venue results', async () => {
    const db = new FakeSupabase()
    db.table('venues').push({ id: 'venue-x' }, { id: 'venue-y' })
    addFragment(db, 'f1', 'venue-x', 'knot', 'Kim Lee', '2026-03-01T00:00:00.000Z')
    addFragment(db, 'f2', 'venue-x', 'facebook', 'Kim Lee', '2026-03-01T01:00:00.000Z')

    const result = await sweepFragmentsAllVenues(
      db as unknown as Parameters<typeof sweepFragmentsAllVenues>[0],
    )

    expect(result.venues_swept).toBe(2)
    expect(result.per_venue).toHaveLength(2)
    const venueX = result.per_venue.find((v) => v.venue_id === 'venue-x')!
    const venueY = result.per_venue.find((v) => v.venue_id === 'venue-y')!
    expect(venueX.identity_hint_coalesce.promoted).toBe(1)
    expect(venueY.identity_hint_coalesce.fragmentsScanned).toBe(0)
  })
})
