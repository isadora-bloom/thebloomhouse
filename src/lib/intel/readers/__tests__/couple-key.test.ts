/**
 * loadCoupleKeyForWedding / loadCoupleKeysForWeddings.
 *
 * The point of these tests is tenancy and tombstones, not shape: the
 * routes that used to do `from('weddings').eq('id', weddingId)` then
 * compare `venue_id` in JavaScript now rely on this one query to be the
 * whole check. If it ever stops filtering by venue, or starts resolving
 * a merged-away couple, a coordinator sees another venue's couple.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '../../tool-sources/__tests__/fake-supabase-memory'
import { loadCoupleKeyForWedding, loadCoupleKeysForWeddings } from '../couple-key'

const VENUE = 'venue-1'
const OTHER = 'venue-2'

function couple(over: Record<string, unknown> = {}) {
  return {
    id: 'C1',
    venue_id: VENUE,
    source_wedding_id: 'W1',
    primary_contact_name: 'Emma',
    partner_contact_name: 'Jake',
    lifecycle_state: 'resolved',
    wedding_date: '2027-06-12',
    heat_score: 61,
    merged_into_id: null,
    ...over,
  }
}

describe('loadCoupleKeyForWedding', () => {
  it('maps a wedding id onto the couple it was minted from', async () => {
    const sb = makeFakeSupabase({ couples: [couple()] })
    const key = await loadCoupleKeyForWedding(sb, VENUE, 'W1')
    expect(key?.coupleId).toBe('C1')
    expect(key?.sourceWeddingId).toBe('W1')
    expect(key?.names).toBe('Emma & Jake')
    expect(key?.heatScore).toBe(61)
  })

  it('names the primary alone when there is no partner on file', async () => {
    const sb = makeFakeSupabase({ couples: [couple({ partner_contact_name: null })] })
    const key = await loadCoupleKeyForWedding(sb, VENUE, 'W1')
    expect(key?.names).toBe('Emma')
  })

  it('refuses a couple that belongs to another venue', async () => {
    const sb = makeFakeSupabase({ couples: [couple({ venue_id: OTHER })] })
    expect(await loadCoupleKeyForWedding(sb, VENUE, 'W1')).toBeNull()
  })

  it('refuses a merged-away couple rather than returning a tombstone', async () => {
    const sb = makeFakeSupabase({ couples: [couple({ merged_into_id: 'C9' })] })
    expect(await loadCoupleKeyForWedding(sb, VENUE, 'W1')).toBeNull()
  })

  it('returns null for a wedding with no mirrored couple', async () => {
    const sb = makeFakeSupabase({ couples: [couple()] })
    expect(await loadCoupleKeyForWedding(sb, VENUE, 'W-unknown')).toBeNull()
  })

  it('returns null on a blank venue or wedding id without querying', async () => {
    const sb = makeFakeSupabase({ couples: [couple()] })
    expect(await loadCoupleKeyForWedding(sb, '', 'W1')).toBeNull()
    expect(await loadCoupleKeyForWedding(sb, VENUE, '')).toBeNull()
  })
})

describe('loadCoupleKeysForWeddings', () => {
  it('keys the map by wedding id and drops out-of-scope rows', async () => {
    const sb = makeFakeSupabase({
      couples: [
        couple(),
        couple({ id: 'C2', source_wedding_id: 'W2', primary_contact_name: 'Ada', partner_contact_name: null }),
        couple({ id: 'C3', source_wedding_id: 'W3', venue_id: OTHER }),
        couple({ id: 'C4', source_wedding_id: 'W4', merged_into_id: 'C1' }),
      ],
    })
    const map = await loadCoupleKeysForWeddings(sb, [VENUE], ['W1', 'W2', 'W3', 'W4'])
    expect([...map.keys()].sort()).toEqual(['W1', 'W2'])
    expect(map.get('W2')?.names).toBe('Ada')
  })

  it('returns an empty map when asked for nothing', async () => {
    const sb = makeFakeSupabase({ couples: [couple()] })
    expect((await loadCoupleKeysForWeddings(sb, [], ['W1'])).size).toBe(0)
    expect((await loadCoupleKeysForWeddings(sb, [VENUE], [])).size).toBe(0)
  })
})
