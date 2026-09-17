/**
 * Guest CSV import against a list that already has people on it.
 *
 * The behaviour worth protecting, in order of how much damage it does
 * when it breaks:
 *
 * 1. A re-import must not double the list. That was the bug.
 * 2. An update must not carry the insert defaults. `rsvp_status:
 *    'pending'` applied to a guest who already said yes is silent data
 *    loss, and the couple would never know which rows it hit.
 * 3. A blank cell means "nothing to say", not "clear the value".
 */

import { describe, it, expect } from 'vitest'
import {
  countMatches,
  fieldsFromRow,
  normaliseRsvp,
  planGuestImport,
  type ExistingGuest,
} from '../guest-import'

const VENUE = 'venue-1'
const WEDDING = 'wedding-1'

const plan = (
  rows: Array<Record<string, string>>,
  mapping: Record<string, string>,
  existing: ExistingGuest[] = []
) => planGuestImport({ rows, mapping, existing, venueId: VENUE, weddingId: WEDDING })

const NAME_MAP = { First: 'first_name', Last: 'last_name' }
const FULL_MAP = { ...NAME_MAP, Email: 'email' }

describe('planGuestImport — the doubling bug', () => {
  const existing: ExistingGuest[] = [
    { id: 'g1', first_name: 'Sam', last_name: 'Patel', email: 'sam@example.com' },
  ]

  it('updates a guest matched on email instead of inserting again', () => {
    const result = plan([{ First: 'Sam', Last: 'Patel', Email: 'sam@example.com' }], FULL_MAP, existing)
    expect(result.inserts).toHaveLength(0)
    expect(result.updates).toHaveLength(1)
    expect(result.updates[0].id).toBe('g1')
  })

  it('matches on email regardless of case or surrounding space', () => {
    const result = plan([{ First: 'Sam', Last: 'Patel', Email: '  SAM@Example.COM ' }], FULL_MAP, existing)
    expect(result.inserts).toHaveLength(0)
    expect(result.updates[0].id).toBe('g1')
  })

  it('matches on email even when the name has changed', () => {
    const result = plan([{ First: 'Sam', Last: 'Okonjo', Email: 'sam@example.com' }], FULL_MAP, existing)
    expect(result.inserts).toHaveLength(0)
    expect(result.updates[0].fields.last_name).toBe('Okonjo')
  })

  it('falls back to first + last name when the file has no email', () => {
    const result = plan([{ First: 'sam', Last: 'PATEL' }], NAME_MAP, existing)
    expect(result.inserts).toHaveLength(0)
    expect(result.updates[0].id).toBe('g1')
  })

  it('still inserts somebody genuinely new', () => {
    const result = plan([{ First: 'Ada', Last: 'Byron', Email: 'ada@example.com' }], FULL_MAP, existing)
    expect(result.updates).toHaveLength(0)
    expect(result.inserts).toHaveLength(1)
    expect(result.inserts[0]).toMatchObject({
      venue_id: VENUE,
      wedding_id: WEDDING,
      first_name: 'Ada',
      last_name: 'Byron',
      rsvp_status: 'pending',
    })
  })

  it('collapses a row repeated inside one file rather than inserting it twice', () => {
    const result = plan(
      [
        { First: 'Ada', Last: 'Byron', Email: 'ada@example.com' },
        { First: 'Ada', Last: 'Byron', Email: 'ada@example.com' },
      ],
      FULL_MAP
    )
    expect(result.inserts).toHaveLength(1)
    expect(result.duplicateRowsInFile).toBe(1)
  })

  it('is idempotent in the only way that matters: no second row', () => {
    const rows = [{ First: 'Ada', Last: 'Byron', Email: 'ada@example.com' }]
    const first = plan(rows, FULL_MAP)
    expect(first.inserts).toHaveLength(1)

    // Simulate that insert landing, then run the same file again.
    const now: ExistingGuest[] = [
      { id: 'g2', first_name: 'Ada', last_name: 'Byron', email: 'ada@example.com' },
    ]
    const second = plan(rows, FULL_MAP, now)
    expect(second.inserts).toHaveLength(0)
    // It does write, because the planner cannot see the columns it is not
    // given and so cannot prove the values are unchanged. The patch is the
    // same values landing on the same row, which costs a round trip and
    // changes nothing.
    expect(second.updates).toEqual([
      { id: 'g2', fields: { first_name: 'Ada', last_name: 'Byron', email: 'ada@example.com' } },
    ])
  })
})

describe('planGuestImport — an update must not reset what it did not supply', () => {
  const existing: ExistingGuest[] = [
    { id: 'g1', first_name: 'Sam', last_name: 'Patel', email: 'sam@example.com' },
  ]

  it('never puts the insert defaults into a patch', () => {
    const result = plan([{ First: 'Sam', Last: 'Patel', Email: 'sam@example.com', Meal: 'Fish' }], { ...FULL_MAP, Meal: 'meal_choice' }, existing)
    const patch = result.updates[0].fields
    expect(patch).not.toHaveProperty('rsvp_status')
    expect(patch).not.toHaveProperty('has_plus_one')
    expect(patch).not.toHaveProperty('invitation_sent')
    expect(patch).not.toHaveProperty('venue_id')
    expect(patch).not.toHaveProperty('wedding_id')
    expect(patch.meal_choice).toBe('Fish')
  })

  it('leaves a blank cell out of the patch entirely', () => {
    const result = plan(
      [{ First: 'Sam', Last: 'Patel', Email: 'sam@example.com', Notes: '   ' }],
      { ...FULL_MAP, Notes: 'notes' },
      existing
    )
    expect(result.updates[0].fields).not.toHaveProperty('notes')
  })

  it('counts a row that supplies nothing beyond its own identity', () => {
    const result = plan([{ First: '', Last: '', Email: 'sam@example.com' }], FULL_MAP, existing)
    // The email is the only field, and it is what matched, so the patch is
    // just that. It writes, harmlessly, rather than being counted unchanged.
    expect(result.updates).toHaveLength(1)
    expect(Object.keys(result.updates[0].fields)).toEqual(['email'])
  })

  it('drops an unreadable RSVP value rather than defaulting it on an update', () => {
    const result = plan(
      [{ First: 'Sam', Last: 'Patel', Email: 'sam@example.com', RSVP: 'ask her mother' }],
      { ...FULL_MAP, RSVP: 'rsvp_status' },
      existing
    )
    expect(result.updates[0].fields).not.toHaveProperty('rsvp_status')
  })
})

describe('fieldsFromRow', () => {
  it('splits a combined name column', () => {
    const f = fieldsFromRow({ Name: 'Ada Lovelace Byron' }, { Name: '_full_name' })
    expect(f.first_name).toBe('Ada')
    expect(f.last_name).toBe('Lovelace Byron')
    expect(f).not.toHaveProperty('_full_name')
  })

  it('does not let a combined column overwrite explicit columns', () => {
    const f = fieldsFromRow(
      { Name: 'Wrong Person', First: 'Ada', Last: 'Byron' },
      { Name: '_full_name', First: 'first_name', Last: 'last_name' }
    )
    expect(f.first_name).toBe('Ada')
    expect(f.last_name).toBe('Byron')
  })

  it('reads a plus-one column as a yes or no', () => {
    expect(fieldsFromRow({ P: 'yes' }, { P: '_plus_one' }).has_plus_one).toBe(true)
    expect(fieldsFromRow({ P: 'no' }, { P: '_plus_one' }).has_plus_one).toBe(false)
    expect(fieldsFromRow({ P: 'none' }, { P: '_plus_one' }).has_plus_one).toBe(false)
    expect(fieldsFromRow({ P: '' }, { P: '_plus_one' })).not.toHaveProperty('has_plus_one')
  })

  it('keeps a plus-one name when the column holds one', () => {
    const f = fieldsFromRow({ P: 'Charles Babbage' }, { P: '_plus_one' })
    expect(f.has_plus_one).toBe(true)
    expect(f.plus_one_name).toBe('Charles Babbage')
  })

  it('does not store "yes" as somebody\'s name', () => {
    const f = fieldsFromRow({ P: 'yes' }, { P: '_plus_one' })
    expect(f).not.toHaveProperty('plus_one_name')
  })

  it('never emits an empty string into a column', () => {
    const f = fieldsFromRow(
      { First: 'Ada', Email: '', Phone: '  ' },
      { First: 'first_name', Email: 'email', Phone: 'phone' }
    )
    expect(Object.values(f)).not.toContain('')
    expect(f).not.toHaveProperty('email')
    expect(f).not.toHaveProperty('phone')
  })
})

describe('planGuestImport — rubbish in', () => {
  it('ignores a row with neither name nor email', () => {
    const result = plan([{ Notes: 'just a note' }], { Notes: 'notes' })
    expect(result.inserts).toHaveLength(0)
    expect(result.updates).toHaveLength(0)
  })

  it('names an unnamed but emailed guest Unknown so they stay findable', () => {
    const result = plan([{ Email: 'mystery@example.com' }], { Email: 'email' })
    expect(result.inserts[0].first_name).toBe('Unknown')
  })

  it('handles an empty file', () => {
    const result = plan([], FULL_MAP)
    expect(result).toEqual({ inserts: [], updates: [], unchanged: 0, duplicateRowsInFile: 0 })
  })

  it('keeps existing duplicates stable by matching the first', () => {
    const existing: ExistingGuest[] = [
      { id: 'first', first_name: 'Sam', last_name: 'Patel', email: null },
      { id: 'second', first_name: 'Sam', last_name: 'Patel', email: null },
    ]
    const result = plan([{ First: 'Sam', Last: 'Patel' }], NAME_MAP, existing)
    expect(result.updates[0].id).toBe('first')
  })
})

describe('countMatches', () => {
  it('reports what the preview line needs', () => {
    const existing: ExistingGuest[] = [
      { id: 'g1', first_name: 'Sam', last_name: 'Patel', email: 'sam@example.com' },
    ]
    const counts = countMatches({
      rows: [
        { First: 'Sam', Last: 'Patel', Email: 'sam@example.com' },
        { First: 'Ada', Last: 'Byron', Email: 'ada@example.com' },
      ],
      mapping: FULL_MAP,
      existing,
    })
    expect(counts).toEqual({ matching: 1, newGuests: 1 })
  })
})

describe('normaliseRsvp', () => {
  it('maps the words people actually type', () => {
    expect(normaliseRsvp('Yes')).toBe('attending')
    expect(normaliseRsvp("can't attend")).toBe('declined')
    expect(normaliseRsvp('Tentative')).toBe('maybe')
    expect(normaliseRsvp('no response')).toBe('pending')
  })

  it('returns null for anything it cannot read, including blank', () => {
    expect(normaliseRsvp('')).toBeNull()
    expect(normaliseRsvp('  ')).toBeNull()
    expect(normaliseRsvp('probably not sure')).toBeNull()
  })
})
