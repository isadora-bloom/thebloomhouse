/**
 * Building a contract from a booked wedding, against the fake database.
 *
 * The claims worth pinning: the row lands under the wedding's OWN venue
 * (not one passed in from anywhere), the figures are frozen rather than
 * referenced, a wedding that is not booked is refused rather than rendered
 * with blanks, and a venue that has saved their own wording gets it.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { FakeContractsDb } from './fake-contracts-db'
import {
  generateContract,
  joinCoupleNames,
  loadPackageSnapshot,
  readGeneratedFrom,
} from '../generate'
import { DEFAULT_CONTRACT_TEMPLATE } from '../templates'

const VENUE = '22222222-2222-2222-2222-222222222202'
const WEDDING = '44444444-4444-4444-4444-444444000209'

function seedBookedWedding(db: FakeContractsDb, overrides: Record<string, unknown> = {}) {
  db.seed('weddings', [
    {
      id: WEDDING,
      venue_id: VENUE,
      status: 'booked',
      wedding_date: '2027-06-12',
      event_code: 'CW-2706-12',
      guest_count_estimate: 120,
      booking_value: 1_850_000,
      deposit_amount: 500_000,
      amount_paid: 500_000,
      tax_amount: null,
      gratuity_amount: null,
      package_name: 'Saturday Full Weekend',
      ...overrides,
    },
  ])
  db.seed('wedding_details', [
    {
      wedding_id: WEDDING,
      venue_id: VENUE,
      contract_checkin: '10:00am Friday',
      contract_checkout: '11:00am Sunday',
      contract_wedding_hours: '8 hours',
      contract_rehearsal_hours: '2 hours',
      contract_max_wedding: 150,
      contract_max_rehearsal: null,
      contract_overnights: null,
    },
  ])
  db.seed('venues', [{ id: VENUE, name: 'Crestwood Farm' }])
  db.seed('venue_config', [
    {
      venue_id: VENUE,
      business_name: 'Crestwood Farm',
      coordinator_name: 'Sarah Chen',
      coordinator_email: 'sarah@crestwood.test',
      coordinator_phone: '540 555 0142',
      currency: 'USD',
      feature_flags: {},
    },
  ])
  db.seed('people', [
    {
      wedding_id: WEDDING,
      role: 'partner1',
      first_name: 'Chloe',
      last_name: 'Barnes',
      merged_into_id: null,
    },
    {
      wedding_id: WEDDING,
      role: 'partner2',
      first_name: 'Ryan',
      last_name: 'Okafor',
      merged_into_id: null,
    },
  ])
}

let db: FakeContractsDb

beforeEach(() => {
  db = new FakeContractsDb()
})

describe('joinCoupleNames', () => {
  it('puts partner one first', () => {
    expect(
      joinCoupleNames([
        { role: 'partner2', first_name: 'Ryan', last_name: 'Okafor' },
        { role: 'partner1', first_name: 'Chloe', last_name: 'Barnes' },
      ]),
    ).toBe('Chloe Barnes and Ryan Okafor')
  })

  it('uses whichever half exists', () => {
    expect(joinCoupleNames([{ role: 'partner1', first_name: 'Chloe' }])).toBe('Chloe')
  })

  it('addresses the couple generically rather than addressing nobody', () => {
    expect(joinCoupleNames([])).toBe('the couple')
    expect(joinCoupleNames([{ role: 'partner1', first_name: '  ' }])).toBe('the couple')
  })
})

describe('loadPackageSnapshot', () => {
  it('reads the wedding, its details, the venue and the couple', async () => {
    seedBookedWedding(db)
    const load = await loadPackageSnapshot(WEDDING, db.asClient())

    expect(load.ok).toBe(true)
    expect(load.venueId).toBe(VENUE)
    expect(load.snapshot?.coupleNames).toBe('Chloe Barnes and Ryan Okafor')
    expect(load.snapshot?.totalCents).toBe(1_850_000)
    expect(load.snapshot?.checkIn).toBe('10:00am Friday')
    expect(load.snapshot?.maxRehearsalGuests).toBeNull()
    expect(load.snapshot?.currency).toBe('USD')
  })

  it('refuses a wedding that is not booked', async () => {
    seedBookedWedding(db, { status: 'inquiry' })
    const load = await loadPackageSnapshot(WEDDING, db.asClient())
    expect(load.ok).toBe(false)
    expect(load.failure).toBe('not_booked')
  })

  it('refuses a wedding that does not exist', async () => {
    const load = await loadPackageSnapshot('missing', db.asClient())
    expect(load.ok).toBe(false)
    expect(load.failure).toBe('wedding_not_found')
  })

  it('uses the venue’s own wording when they have saved some', async () => {
    seedBookedWedding(db)
    db.table('venue_config')[0].feature_flags = {
      contract_template: {
        key: 'elopement',
        title: 'Elopement agreement',
        clauses: [{ heading: 'The day', body: 'Just the two of you.' }],
      },
    }
    const load = await loadPackageSnapshot(WEDDING, db.asClient())
    expect(load.template?.key).toBe('elopement')
    expect(load.template?.title).toBe('Elopement agreement')
  })

  it('falls back to the standard wording when they have not', async () => {
    seedBookedWedding(db)
    const load = await loadPackageSnapshot(WEDDING, db.asClient())
    expect(load.template).toEqual(DEFAULT_CONTRACT_TEMPLATE)
  })
})

describe('generateContract', () => {
  it('stores a PDF and records a draft under the wedding’s own venue', async () => {
    seedBookedWedding(db)
    const result = await generateContract({
      weddingId: WEDDING,
      db: db.asClient(),
      now: new Date('2026-09-14T10:30:00Z'),
    })

    expect(result.ok).toBe(true)
    const row = db.table('contracts')[0]
    expect(row.kind).toBe('generated')
    expect(row.status).toBe('draft')
    expect(row.venue_id).toBe(VENUE)
    expect(row.wedding_id).toBe(WEDDING)
    expect(row.file_type).toBe('pdf')
    expect(row.template_key).toBe('standard')
    expect(String(row.filename)).toContain('CW-2706-12')

    const stored = db.storedFiles.get(String(row.storage_path))
    expect(stored).toBeTruthy()
    expect(stored?.contentType).toBe('application/pdf')
    expect(stored!.bytes.length).toBeGreaterThan(500)
  })

  it('freezes the figures and the wording on the row', async () => {
    seedBookedWedding(db)
    await generateContract({ weddingId: WEDDING, db: db.asClient() })

    const frozen = readGeneratedFrom(db.table('contracts')[0].generated_from)
    expect(frozen).not.toBeNull()
    expect(frozen!.snapshot.totalCents).toBe(1_850_000)
    expect(frozen!.snapshot.coupleNames).toBe('Chloe Barnes and Ryan Okafor')
    expect(frozen!.template.title).toBe('Wedding agreement')

    // Moving the wedding on afterwards does not move the contract.
    db.table('weddings')[0].booking_value = 9_999_900
    const stillFrozen = readGeneratedFrom(db.table('contracts')[0].generated_from)
    expect(stillFrozen!.snapshot.totalCents).toBe(1_850_000)
  })

  it('puts the contract text on the row so the search finds it', async () => {
    seedBookedWedding(db)
    await generateContract({ weddingId: WEDDING, db: db.asClient() })
    const text = String(db.table('contracts')[0].extracted_text)
    expect(text).toContain('What it costs')
    expect(text).toContain('$18,500')
  })

  it('refuses a wedding that is not booked and writes nothing', async () => {
    seedBookedWedding(db, { status: 'proposal_sent' })
    const result = await generateContract({ weddingId: WEDDING, db: db.asClient() })
    expect(result.ok).toBe(false)
    expect(result.failure).toBe('not_booked')
    expect(db.table('contracts')).toHaveLength(0)
    expect(db.storedFiles.size).toBe(0)
  })
})

describe('readGeneratedFrom', () => {
  it('refuses a blob that is not a frozen contract', () => {
    expect(readGeneratedFrom(null)).toBeNull()
    expect(readGeneratedFrom('a string')).toBeNull()
    expect(readGeneratedFrom([])).toBeNull()
    expect(readGeneratedFrom({})).toBeNull()
    expect(readGeneratedFrom({ snapshot: {} })).toBeNull()
    expect(readGeneratedFrom({ snapshot: { venueName: 'x' } })).toBeNull()
  })

  it('fills in the standard wording when only the figures were stored', () => {
    const frozen = readGeneratedFrom({
      snapshot: { venueName: 'Crestwood Farm', coupleNames: 'A and B' },
    })
    expect(frozen?.template).toEqual(DEFAULT_CONTRACT_TEMPLATE)
  })
})
