/**
 * W66 — contract tests for the wedding-id → spine reader.
 *
 * The point of these is not that the SQL runs; it is that the reader
 * reads `couples` and only `couples`, that a tombstoned couple never
 * comes back, that another tenant's wedding id resolves to nothing, and
 * that the display name has exactly one rule wherever it is asked for.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase, type FilterCall } from '@/lib/intel/tool-sources/__tests__/fake-supabase'
import {
  loadCoupleByWedding,
  loadCouplesByWeddings,
  loadCouplesByWeddingDate,
  findCouplesByName,
  coupleDisplayName,
  coupleEmails,
  partnerCount,
  type CoupleMirror,
} from '../couple-by-wedding'

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'couple-1',
    venue_id: 'venue-1',
    source_wedding_id: 'wed-1',
    lifecycle_state: 'booked',
    wedding_date: '2026-06-06',
    primary_contact_name: 'Alex Rivera',
    primary_contact_email: 'alex@example.com',
    primary_contact_phone: null,
    partner_contact_name: 'Sam Rivera',
    partner_contact_email: 'SAM@example.com',
    partner_contact_phone: null,
    ...over,
  }
}

/** Records every table touched so a test can assert "spine only". */
function spy(rowsByTable: Record<string, unknown[]>) {
  const tables: string[] = []
  const calls: Record<string, FilterCall[]> = {}
  const client = makeFakeSupabase((table, filterCalls) => {
    tables.push(table)
    calls[table] = filterCalls
    return { data: (rowsByTable[table] ?? []) as unknown[], error: null }
  })
  return { client, tables, calls }
}

describe('loadCoupleByWedding', () => {
  it('resolves a wedding id through couples.source_wedding_id', async () => {
    const { client, tables, calls } = spy({ couples: [row()] })
    const couple = await loadCoupleByWedding(client, 'wed-1', 'venue-1')
    expect(couple?.coupleId).toBe('couple-1')
    expect(couple?.weddingId).toBe('wed-1')
    expect(couple?.weddingDate).toBe('2026-06-06')
    // Spine only. No weddings, no people.
    expect(tables).toEqual(['couples'])
    const applied = calls.couples!.map((c) => `${c.method}:${String(c.args[0])}`)
    expect(applied).toContain('eq:source_wedding_id')
    expect(applied).toContain('is:merged_into_id')
    expect(applied).toContain('eq:venue_id')
  })

  it('returns null for a missing wedding id rather than guessing', async () => {
    const { client } = spy({ couples: [] })
    expect(await loadCoupleByWedding(client, 'wed-nope', 'venue-1')).toBeNull()
    expect(await loadCoupleByWedding(client, null)).toBeNull()
  })

  it('scopes to the venue, so a foreign wedding id finds nothing', async () => {
    // The fake returns whatever the table holds; the assertion that
    // matters is that the venue filter was actually applied.
    const { client, calls } = spy({ couples: [row()] })
    await loadCoupleByWedding(client, 'wed-1', 'venue-2')
    const venueFilter = calls.couples!.find(
      (c) => c.method === 'eq' && c.args[0] === 'venue_id',
    )
    expect(venueFilter?.args[1]).toBe('venue-2')
  })
})

describe('loadCouplesByWeddings', () => {
  it('keys the map by wedding id and skips ids with no couple', async () => {
    const { client } = spy({
      couples: [row(), row({ id: 'couple-2', source_wedding_id: 'wed-2' })],
    })
    const map = await loadCouplesByWeddings(client, ['wed-1', 'wed-2', 'wed-3'])
    expect(map.get('wed-1')?.coupleId).toBe('couple-1')
    expect(map.get('wed-2')?.coupleId).toBe('couple-2')
    expect(map.has('wed-3')).toBe(false)
  })

  it('is an empty map for an empty id list, with no query at all', async () => {
    const { client, tables } = spy({ couples: [row()] })
    const map = await loadCouplesByWeddings(client, [])
    expect(map.size).toBe(0)
    expect(tables).toEqual([])
  })
})

describe('loadCouplesByWeddingDate', () => {
  it('filters on the spine lifecycle states, not weddings.status', async () => {
    const { client, tables, calls } = spy({ couples: [row()] })
    const found = await loadCouplesByWeddingDate(
      client,
      'venue-1',
      '2026-06-01',
      '2026-06-30',
    )
    expect(found).toHaveLength(1)
    expect(tables).toEqual(['couples'])
    const inFilter = calls.couples!.find((c) => c.method === 'in')
    expect(inFilter?.args[0]).toBe('lifecycle_state')
    expect(inFilter?.args[1]).toEqual(['booked', 'completed'])
  })
})

describe('findCouplesByName', () => {
  it('escapes LIKE wildcards before they reach the filter grammar', async () => {
    const { client, calls } = spy({ couples: [] })
    await findCouplesByName(client, 'venue-1', 'A%_x')
    const orFilter = calls.couples!.find((c) => c.method === 'or')
    expect(String(orFilter?.args[0])).toContain('A\\%\\_x')
  })

  it('refuses to query on a name too short to mean anything', async () => {
    const { client, tables } = spy({ couples: [row()] })
    expect(await findCouplesByName(client, 'venue-1', 'Jo')).toEqual([])
    expect(tables).toEqual([])
  })
})

describe('display helpers', () => {
  const both: CoupleMirror = {
    coupleId: 'c', venueId: 'v', weddingId: 'w', lifecycleState: 'booked',
    weddingDate: null, primaryName: 'Alex', primaryEmail: 'a@x.com',
    primaryPhone: null, partnerName: 'Sam', partnerEmail: 'A@X.com',
    partnerPhone: null,
  }

  it('joins two partners with an ampersand', () => {
    expect(coupleDisplayName(both)).toBe('Alex & Sam')
  })

  it('does not double up a primary name that already names both', () => {
    expect(coupleDisplayName({ ...both, primaryName: 'Alex & Sam' })).toBe('Alex & Sam')
  })

  it('falls back to whichever single name exists, else null', () => {
    expect(coupleDisplayName({ ...both, partnerName: null })).toBe('Alex')
    expect(coupleDisplayName({ ...both, primaryName: null })).toBe('Sam')
    expect(coupleDisplayName({ ...both, primaryName: ' ', partnerName: null })).toBeNull()
    expect(coupleDisplayName(null)).toBeNull()
  })

  it('de-duplicates addresses case-insensitively', () => {
    expect(coupleEmails(both)).toEqual(['a@x.com'])
    expect(coupleEmails(null)).toEqual([])
  })

  it('counts partners, and says null rather than "solo" off the spine', () => {
    expect(partnerCount(both)).toBe(2)
    expect(partnerCount({ ...both, partnerName: null })).toBe(1)
    expect(partnerCount({ ...both, primaryName: null, partnerName: null })).toBeNull()
    expect(partnerCount(null)).toBeNull()
  })
})
