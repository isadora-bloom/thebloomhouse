/**
 * venue-freeze.ts asks the database's own rule (venue_is_frozen, migration
 * 417) and must fail open: the trigger still refuses the write, and a DB
 * hiccup must never stop a paying venue.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  isVenueFrozen,
  assertVenueNotFrozen,
  withoutFrozenVenues,
  isVenueFrozenError,
  clearVenueFreezeCache,
  VenueFrozenError,
} from '@/lib/services/billing/venue-freeze'

const FROZEN = '11111111-1111-4111-8111-111111111111'
const LIVE = '22222222-2222-4222-8222-222222222222'

function fakeClient(opts: { frozen?: string[]; error?: boolean; throws?: boolean } = {}) {
  const calls: string[] = []
  const client = {
    calls,
    rpc(fn: string, args: { p_venue_id: string }) {
      calls.push(`${fn}:${args.p_venue_id}`)
      if (opts.throws) throw new Error('network down')
      if (opts.error) return Promise.resolve({ data: null, error: { message: 'boom' } })
      return Promise.resolve({ data: (opts.frozen ?? []).includes(args.p_venue_id), error: null })
    },
  }
  return client as typeof client & Parameters<typeof isVenueFrozen>[1]
}

beforeEach(() => clearVenueFreezeCache())

describe('isVenueFrozen', () => {
  it('answers from venue_is_frozen', async () => {
    const c = fakeClient({ frozen: [FROZEN] })
    expect(await isVenueFrozen(FROZEN, c)).toBe(true)
    expect(await isVenueFrozen(LIVE, c)).toBe(false)
  })

  it("treats 'system', empty and non-uuid ids as platform work, without a lookup", async () => {
    const c = fakeClient({ frozen: [FROZEN] })
    for (const id of ['system', '', null, undefined, 'not-a-uuid']) {
      expect(await isVenueFrozen(id, c)).toBe(false)
    }
    expect(c.calls).toHaveLength(0)
  })

  it('fails open on an error or a throw', async () => {
    expect(await isVenueFrozen(FROZEN, fakeClient({ error: true }))).toBe(false)
    expect(await isVenueFrozen(FROZEN, fakeClient({ throws: true }))).toBe(false)
  })

  it('caches an answer, but not a failed lookup', async () => {
    const failing = fakeClient({ error: true })
    await isVenueFrozen(FROZEN, failing)
    const c = fakeClient({ frozen: [FROZEN] })
    expect(await isVenueFrozen(FROZEN, c)).toBe(true)
    expect(await isVenueFrozen(FROZEN, c)).toBe(true)
    expect(c.calls).toHaveLength(1)
  })
})

describe('assertVenueNotFrozen', () => {
  it('throws VenueFrozenError for a frozen venue only', async () => {
    const c = fakeClient({ frozen: [FROZEN] })
    await expect(assertVenueNotFrozen(FROZEN, c)).rejects.toBeInstanceOf(VenueFrozenError)
    await expect(assertVenueNotFrozen(LIVE, c)).resolves.toBeUndefined()
  })
})

describe('withoutFrozenVenues', () => {
  it('drops frozen venues and keeps order', async () => {
    const c = fakeClient({ frozen: [FROZEN] })
    expect(await withoutFrozenVenues(new Set([LIVE, FROZEN, 'system']), c)).toEqual([LIVE, 'system'])
  })
})

describe('isVenueFrozenError', () => {
  it("recognises our error and the trigger's error as Supabase returns it", () => {
    expect(isVenueFrozenError(new VenueFrozenError(FROZEN))).toBe(true)
    expect(isVenueFrozenError({ code: 'PT402', message: 'venue_frozen: ...' })).toBe(true)
    expect(isVenueFrozenError({ code: 'XX000', message: 'venue_frozen: this venue...' })).toBe(true)
    expect(isVenueFrozenError({ code: '23505', message: 'duplicate key' })).toBe(false)
    expect(isVenueFrozenError(null)).toBe(false)
  })
})
