/**
 * getWeddingRecord / loadWeddingRecord — W65 of NOVEMBER-PLAN.md wave 9.
 *
 * Fake-supabase-memory pattern, same as the rest of src/lib/intel — no
 * database required. Mapping-focused: given fixed input rows, does the
 * reader produce the fields the couple-facing and wedding-record pages
 * actually render.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '../../tool-sources/__tests__/fake-supabase-memory'
import { loadWeddingRecord } from '../wedding-record'

const VENUE = 'venue-1'

describe('loadWeddingRecord', () => {
  it('honest-empty when neither a couple nor a wedding row exists', async () => {
    const supabase = makeFakeSupabase({})
    const r = await loadWeddingRecord(supabase, 'nope', VENUE)
    expect(r.found).toBe(false)
    expect(r.coupleNames).toBeNull()
    expect(r.weddingDate).toBeNull()
    expect(r.operatorStage).toBeNull()
  })

  it('honest-empty for a weddingId from a foreign venue', async () => {
    const supabase = makeFakeSupabase({
      weddings: [
        { id: 'W1', venue_id: 'other-venue', wedding_date: '2027-06-01', guest_count_estimate: 100 },
      ],
    })
    const r = await loadWeddingRecord(supabase, 'W1', VENUE)
    expect(r.found).toBe(false)
  })

  it('builds first names from the spine and prefers the spine wedding date', async () => {
    const supabase = makeFakeSupabase({
      couples: [
        {
          id: 'C1',
          venue_id: VENUE,
          source_wedding_id: 'W1',
          primary_contact_name: 'Chloe Smith',
          partner_contact_name: 'Ryan Jones',
          wedding_date: '2027-09-12',
          lifecycle_state: 'booked',
          merged_into_id: null,
        },
      ],
      weddings: [
        {
          id: 'W1',
          venue_id: VENUE,
          wedding_date: '2027-09-11', // stale legacy copy — spine wins
          guest_count_estimate: 120,
          package_name: 'The Grand',
          package: null,
          event_code: 'HAW-042',
          code_extension: 'B',
          couple_photo_url: 'https://x.supabase.co/storage/v1/object/public/couple-photos/w1.jpg',
        },
      ],
      packages: [
        { venue_id: VENUE, kind: 'package', name: 'The Grand', description: 'Everything.', season: 'peak', tier: null },
      ],
    })

    const r = await loadWeddingRecord(supabase, 'W1', VENUE)

    expect(r.found).toBe(true)
    expect(r.coupleId).toBe('C1')
    expect(r.coupleNames).toBe('Chloe & Ryan')
    expect(r.weddingDate).toBe('2027-09-12')
    expect(r.guestCount).toBe(120)
    expect(r.eventCode).toBe('HAW-042')
    expect(r.codeExtension).toBe('B')
    expect(r.couplePhotoUrl).toBe('https://x.supabase.co/storage/v1/object/public/couple-photos/w1.jpg')
    expect(r.lifecycle).toBe('booked')
    expect(r.package).toEqual({ name: 'The Grand', description: 'Everything.', seasonOrTier: 'peak' })
  })

  it('falls back to the bare package label when the catalog has no matching row', async () => {
    const supabase = makeFakeSupabase({
      couples: [
        {
          id: 'C2',
          venue_id: VENUE,
          source_wedding_id: 'W2',
          primary_contact_name: 'Ana Lee',
          partner_contact_name: null,
          wedding_date: '2027-04-01',
          lifecycle_state: 'resolved',
          merged_into_id: null,
        },
      ],
      weddings: [
        {
          id: 'W2',
          venue_id: VENUE,
          wedding_date: '2027-04-01',
          guest_count_estimate: null,
          package_name: null,
          package: 'Legacy Label Only',
          event_code: null,
          code_extension: null,
          couple_photo_url: null,
        },
      ],
    })

    const r = await loadWeddingRecord(supabase, 'W2', VENUE)
    expect(r.package).toEqual({ name: 'Legacy Label Only', description: null, seasonOrTier: null })
    // Solo partner — one first name, no ampersand.
    expect(r.coupleNames).toBe('Ana')
  })

  it('falls back to the legacy wedding row when no spine couple is mirrored yet', async () => {
    const supabase = makeFakeSupabase({
      weddings: [
        {
          id: 'W3',
          venue_id: VENUE,
          wedding_date: '2027-01-15',
          guest_count_estimate: 80,
          package_name: null,
          package: null,
          event_code: 'HAW-099',
          code_extension: null,
          couple_photo_url: null,
        },
      ],
    })

    const r = await loadWeddingRecord(supabase, 'W3', VENUE)
    expect(r.found).toBe(true)
    expect(r.coupleId).toBeNull()
    expect(r.coupleNames).toBeNull() // honest-empty, never guessed from the legacy row
    expect(r.weddingDate).toBe('2027-01-15')
    expect(r.lifecycle).toBeNull()
    expect(r.operatorStage).toBeNull()
  })

  it('excludes a merged-away couple, reading as though it were never mirrored', async () => {
    const supabase = makeFakeSupabase({
      couples: [
        {
          id: 'C4',
          venue_id: VENUE,
          source_wedding_id: 'W4',
          primary_contact_name: 'Gone',
          partner_contact_name: null,
          wedding_date: '2027-05-01',
          lifecycle_state: 'resolved',
          merged_into_id: 'C-canonical',
        },
      ],
      weddings: [
        { id: 'W4', venue_id: VENUE, wedding_date: '2027-05-01', guest_count_estimate: null, package_name: null, package: null, event_code: null, code_extension: null, couple_photo_url: null },
      ],
    })
    const r = await loadWeddingRecord(supabase, 'W4', VENUE)
    expect(r.coupleId).toBeNull()
    expect(r.coupleNames).toBeNull()
  })
})
