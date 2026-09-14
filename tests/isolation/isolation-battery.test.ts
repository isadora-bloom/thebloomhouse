/**
 * Proves the isolation-battery checker itself catches a leak, against a
 * fake Supabase client with deliberately leaked rows — no real database.
 *
 * NOVEMBER-PLAN.md wave 5, W38. Three things are locked down:
 *   1. walk() correctly pulls venue_id fields and uuid-shaped strings out
 *      of an arbitrary reader/tool-source response shape.
 *   2. checkSurface() FAILs when a response embeds an id that belongs to
 *      the OTHER venue's couples/touchpoints rows, or a venue_id field
 *      that doesn't match the venue queried, and PASSes a clean response.
 *   3. guardReadOnly() refuses every write verb (insert/update/upsert/
 *      delete/rpc) and still lets ordinary reads through — the property
 *      the real script leans on to guarantee it never writes.
 *   4. toursIsolationVerdict() catches a leak the walker cannot see: the
 *      correlation engine's `tours` channel is a count per day with no
 *      uuid in it, so a venue B tour landing in venue A's series has to be
 *      caught by comparing days (NOVEMBER-PLAN.md wave 7, W47).
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  walk,
  checkSurface,
  findForeignIds,
  guardReadOnly,
  ReadOnlyViolation,
  toursIsolationVerdict,
} from '../../scripts/isolation-battery'

const VENUE_A = '11111111-1111-1111-1111-111111111101'
const VENUE_B = '11111111-1111-1111-1111-111111111102'

type Row = Record<string, unknown>

/** Minimal chainable fake — enough to support the exact
 *  .from(table).select('id').eq('venue_id', x).in('id', ids) shape the
 *  checker's cross-check queries use. Not a general Supabase mock. */
function fakeSupabase(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      let filtered = rows
      const builder = {
        select() {
          return builder
        },
        eq(k: string, v: unknown) {
          filtered = filtered.filter((r) => r[k] === v)
          return builder
        },
        in(k: string, values: unknown[]) {
          filtered = filtered.filter((r) => values.includes(r[k]))
          return builder
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          return Promise.resolve({ data: filtered, error: null }).then(resolve)
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
}

/** A fake client whose write verbs actually "succeed" if reached, so the
 *  guard tests prove interception happens BEFORE the write, not after. */
function fakeWritableSupabase(): { client: SupabaseClient; wrote: () => boolean } {
  let didWrite = false
  const client = {
    from(_table: string) {
      const builder: Record<string, unknown> = {
        select() {
          return builder
        },
        eq() {
          return builder
        },
        in() {
          return builder
        },
        insert() {
          didWrite = true
          return builder
        },
        update() {
          didWrite = true
          return builder
        },
        upsert() {
          didWrite = true
          return builder
        },
        delete() {
          didWrite = true
          return builder
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(resolve)
        },
      }
      return builder
    },
    rpc() {
      didWrite = true
      return Promise.resolve({ data: null, error: null })
    },
  }
  return { client: client as unknown as SupabaseClient, wrote: () => didWrite }
}

describe('walk', () => {
  it('collects venue_id fields, uuid-shaped strings, and a record count', () => {
    const sample = {
      id: '11111111-1111-1111-1111-111111111111',
      venue_id: VENUE_A,
      children: [{ id: '33333333-3333-3333-3333-333333333333', venue_id: VENUE_A }],
      note: 'not a uuid',
    }
    const result = walk(sample)
    expect(result.venueIdFields).toEqual([
      { path: '$.venue_id', value: VENUE_A },
      { path: '$.children[0].venue_id', value: VENUE_A },
    ])
    expect(result.uuids.has('11111111-1111-1111-1111-111111111111')).toBe(true)
    expect(result.uuids.has('33333333-3333-3333-3333-333333333333')).toBe(true)
    expect(result.uuids.has(VENUE_A)).toBe(true) // venue_id values are uuid-shaped leaves too
    expect(result.recordCount).toBe(2) // top object + the one child both carry an `id`
  })

  it('ignores non-uuid strings and null/undefined branches', () => {
    const result = walk({ a: 'hello', b: null, c: undefined, d: [null, 'not-a-uuid'] })
    expect(result.uuids.size).toBe(0)
    expect(result.venueIdFields).toEqual([])
    expect(result.recordCount).toBe(0)
  })
})

describe('findForeignIds', () => {
  it('returns no hits when the id list is empty (no query issued)', async () => {
    const hits = await findForeignIds(fakeSupabase({}), VENUE_B, [])
    expect(hits).toEqual([])
  })
})

describe('checkSurface', () => {
  const LEAKED_COUPLE_ID = '99999999-9999-9999-9999-999999999999'
  const OWN_COUPLE_ID = '22222222-2222-2222-2222-222222222222'

  it('FAILs when the response carries an id belonging to the OTHER venue couples table', async () => {
    const supabase = fakeSupabase({
      couples: [
        { id: LEAKED_COUPLE_ID, venue_id: VENUE_B },
        { id: OWN_COUPLE_ID, venue_id: VENUE_A },
      ],
      touchpoints: [],
    })
    const result = await checkSurface({
      surface: 'test.getDailyList',
      venue: 'A',
      venueId: VENUE_A,
      otherVenueId: VENUE_B,
      supabase,
      result: { needsReply: [{ id: LEAKED_COUPLE_ID, names: 'Leaked Couple' }] },
    })
    expect(result.status).toBe('FAIL')
    expect(result.foreignIds).toEqual([{ table: 'couples', id: LEAKED_COUPLE_ID }])
  })

  it('FAILs when the response carries a touchpoint id belonging to the OTHER venue', async () => {
    const LEAKED_TOUCHPOINT_ID = '88888888-8888-8888-8888-888888888888'
    const supabase = fakeSupabase({
      couples: [],
      touchpoints: [{ id: LEAKED_TOUCHPOINT_ID, venue_id: VENUE_B }],
    })
    const result = await checkSurface({
      surface: 'test.getVenueOverview',
      venue: 'A',
      venueId: VENUE_A,
      otherVenueId: VENUE_B,
      supabase,
      result: { recentActivity: [{ id: LEAKED_TOUCHPOINT_ID, kind: 'gmail/reply' }] },
    })
    expect(result.status).toBe('FAIL')
    expect(result.foreignIds).toEqual([{ table: 'touchpoints', id: LEAKED_TOUCHPOINT_ID }])
  })

  it('PASSes when every id in the response belongs to the venue that was queried', async () => {
    const supabase = fakeSupabase({
      couples: [{ id: OWN_COUPLE_ID, venue_id: VENUE_A }],
      touchpoints: [],
    })
    const result = await checkSurface({
      surface: 'test.getDailyList',
      venue: 'A',
      venueId: VENUE_A,
      otherVenueId: VENUE_B,
      supabase,
      result: { needsReply: [{ id: OWN_COUPLE_ID, names: 'Own Couple' }] },
    })
    expect(result.status).toBe('PASS')
    expect(result.foreignIds).toEqual([])
  })

  it('FAILs on a venue_id field that does not match the venue queried, even with no id leak', async () => {
    const supabase = fakeSupabase({ couples: [], touchpoints: [] })
    const result = await checkSurface({
      surface: 'test.getVenueOverview',
      venue: 'A',
      venueId: VENUE_A,
      otherVenueId: VENUE_B,
      supabase,
      result: { couples: { total: 1 }, recentActivity: [{ id: 'not-a-uuid', venue_id: VENUE_B }] },
    })
    expect(result.status).toBe('FAIL')
    expect(result.venueIdMismatches).toEqual([{ path: '$.recentActivity[0].venue_id', value: VENUE_B }])
    expect(result.foreignIds).toEqual([]) // 'not-a-uuid' never reaches the cross-check
  })

  it('rows reflects the record count from the walk', async () => {
    const supabase = fakeSupabase({ couples: [], touchpoints: [] })
    const result = await checkSurface({
      surface: 'test.getCohortFunnel',
      venue: 'B',
      venueId: VENUE_B,
      otherVenueId: VENUE_A,
      supabase,
      result: { funnel: [{ id: 'x', stage: 'inquiry' }, { id: 'y', stage: 'tour' }] },
    })
    expect(result.rows).toBe(2)
  })
})

describe('guardReadOnly', () => {
  it('refuses insert/update/upsert/delete/rpc without reaching the underlying client', () => {
    const { client, wrote } = fakeWritableSupabase()
    const guarded = guardReadOnly(client)
    const builder = guarded.from('couples') as unknown as Record<string, (...args: unknown[]) => unknown>

    expect(() => builder.insert({})).toThrow(ReadOnlyViolation)
    expect(() => builder.update({})).toThrow(ReadOnlyViolation)
    expect(() => builder.upsert({})).toThrow(ReadOnlyViolation)
    expect(() => builder.delete()).toThrow(ReadOnlyViolation)
    expect(() => (guarded as unknown as { rpc: () => unknown }).rpc()).toThrow(ReadOnlyViolation)
    expect(wrote()).toBe(false)
  })

  it('still allows select/eq/in reads through the guard', async () => {
    const { client } = fakeWritableSupabase()
    const guarded = guardReadOnly(client)
    const builder = guarded.from('couples') as unknown as {
      select: () => { eq: (k: string, v: unknown) => { in: (k: string, v: unknown[]) => Promise<{ data: unknown[] }> } }
    }
    const { data } = await builder.select().eq('venue_id', VENUE_A).in('id', ['x'])
    expect(data).toEqual([])
  })

  it('blocks a write chained after a legitimate-looking read call', () => {
    const { client, wrote } = fakeWritableSupabase()
    const guarded = guardReadOnly(client)
    const builder = guarded.from('couples') as unknown as {
      select: () => { insert: (v: unknown) => unknown }
    }
    expect(() => builder.select().insert({})).toThrow(ReadOnlyViolation)
    expect(wrote()).toBe(false)
  })
})

/**
 * The correlation engine's `tours` channel (NOVEMBER-PLAN.md wave 7, W47).
 * A daily count carries no uuid, so the walker above is blind to a leak in
 * it, and one venue's counts compared against the other's prove nothing —
 * a leaked count and a legitimate one look identical. What separates them
 * is whose couples produced them, which is what this verdict reads.
 */
describe('toursIsolationVerdict', () => {
  const days = { mon: '2026-09-07', tue: '2026-09-08', wed: '2026-09-09' }
  const OWN_COUPLE = '55555555-5555-5555-5555-555555555501'
  const FOREIGN_COUPLE = '55555555-5555-5555-5555-555555555502'

  it('passes when every couple behind the series belongs to the venue queried', () => {
    const verdict = toursIsolationVerdict({
      venue: 'A',
      venueId: VENUE_A,
      held: new Map([[days.mon, 2], [days.tue, 1]]),
      coupleIds: [OWN_COUPLE],
      foreignIds: [],
    })
    expect(verdict.status).toBe('PASS')
    expect(verdict.note).toContain('3 tour(s)')
  })

  it("fails when a couple behind the series belongs to the other venue", () => {
    const verdict = toursIsolationVerdict({
      venue: 'A',
      venueId: VENUE_A,
      held: new Map([[days.mon, 2], [days.wed, 3]]),
      coupleIds: [OWN_COUPLE, FOREIGN_COUPLE],
      foreignIds: [{ table: 'couples', id: FOREIGN_COUPLE }],
    })
    expect(verdict.status).toBe('FAIL')
    expect(verdict.foreignIds).toEqual([{ table: 'couples', id: FOREIGN_COUPLE }])
  })

  it('skips rather than claiming a pass when the venue held no tours', () => {
    const verdict = toursIsolationVerdict({
      venue: 'B',
      venueId: VENUE_B,
      held: new Map(),
      coupleIds: [],
      foreignIds: [],
    })
    expect(verdict.status).toBe('SKIP')
    expect(verdict.note).toContain('no tour touchpoints')
  })
})
