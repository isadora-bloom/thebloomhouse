/**
 * S5 (2026-09-14 security audit, item 11) — the seating commit payload.
 */

import { describe, it, expect } from 'vitest'
import {
  validateParsedSeatingChart,
  SeatingChartShapeError,
  MAX_IMPORT_TABLES,
  MAX_GUESTS_PER_TABLE,
} from '../seating-import'

function table(name: string, guestCount = 2) {
  return {
    table_name: name,
    table_type: 'round',
    capacity: 10,
    notes: null,
    guests: Array.from({ length: guestCount }, (_, i) => ({
      full_name: `Guest ${i}`,
      first_name: `Guest`,
      last_name: String(i),
      relationship: null,
      coordinator_notes: null,
      dietary_restrictions: null,
      rsvp_status: 'attending',
      seat_number: i + 1,
    })),
  }
}

describe('validateParsedSeatingChart', () => {
  it('accepts a normal chart and recomputes the guest total', () => {
    const out = validateParsedSeatingChart({
      tables: [table('Table 1', 8), table('Table 2', 6)],
      global_notes: 'no nuts on table 2',
      total_guests: 9999, // a lie; recomputed
      warnings: ['one row had no name'],
    })
    expect(out.tables).toHaveLength(2)
    expect(out.total_guests).toBe(14)
    expect(out.global_notes).toBe('no nuts on table 2')
    expect(out.warnings).toEqual(['one row had no name'])
  })

  it('refuses a payload that is not an object', () => {
    expect(() => validateParsedSeatingChart(null)).toThrow(SeatingChartShapeError)
    expect(() => validateParsedSeatingChart('nope')).toThrow(SeatingChartShapeError)
    expect(() => validateParsedSeatingChart([])).toThrow(SeatingChartShapeError)
  })

  it('refuses tables that are not an array', () => {
    expect(() => validateParsedSeatingChart({ tables: 'lots' })).toThrow(
      /tables must be an array/,
    )
  })

  it('caps the number of tables', () => {
    const tables = Array.from({ length: MAX_IMPORT_TABLES + 1 }, (_, i) =>
      table(`T${i}`, 0),
    )
    expect(() => validateParsedSeatingChart({ tables })).toThrow(/the limit is 200/)
  })

  it('caps guests per table', () => {
    const tables = [table('Head', MAX_GUESTS_PER_TABLE + 1)]
    expect(() => validateParsedSeatingChart({ tables })).toThrow(/limit per table/)
  })

  it('caps the total guest count across tables', () => {
    const tables = Array.from({ length: 40 }, (_, i) =>
      table(`T${i}`, MAX_GUESTS_PER_TABLE),
    )
    expect(() => validateParsedSeatingChart({ tables })).toThrow(/more than 3000/)
  })

  it('refuses a table whose name is not a string', () => {
    expect(() =>
      validateParsedSeatingChart({ tables: [{ table_name: { $ne: null }, guests: [] }] }),
    ).toThrow(/every table needs a name/)
  })

  it('refuses a guest whose name is not a string', () => {
    expect(() =>
      validateParsedSeatingChart({
        tables: [{ table_name: 'T1', guests: [{ full_name: 42 }] }],
      }),
    ).toThrow(/every guest needs a name/)
  })

  it('falls back to a known table_type rather than passing one through', () => {
    const out = validateParsedSeatingChart({
      tables: [{ table_name: 'T1', table_type: 'exploding', guests: [] }],
    })
    expect(out.tables[0].table_type).toBe('round')
  })

  it('drops an rsvp_status it does not recognise', () => {
    const out = validateParsedSeatingChart({
      tables: [
        {
          table_name: 'T1',
          guests: [{ full_name: 'A B', first_name: 'A', rsvp_status: 'maybe-ish' }],
        },
      ],
    })
    expect(out.tables[0].guests[0].rsvp_status).toBeNull()
  })

  it('drops fields nobody asked for', () => {
    const out = validateParsedSeatingChart({
      tables: [{ table_name: 'T1', guests: [], id: 'injected', wedding_id: 'other' }],
      venue_id: 'someone-elses-venue',
    })
    expect(Object.keys(out.tables[0]).sort()).toEqual(
      ['capacity', 'guests', 'notes', 'table_name', 'table_type'].sort(),
    )
    expect(JSON.stringify(out)).not.toContain('someone-elses-venue')
  })

  it('bounds a very long string rather than refusing the whole chart', () => {
    const out = validateParsedSeatingChart({
      tables: [{ table_name: 'x'.repeat(5000), guests: [] }],
    })
    expect(out.tables[0].table_name.length).toBe(200)
  })

  it('clamps a nonsense capacity', () => {
    const out = validateParsedSeatingChart({
      tables: [{ table_name: 'T1', capacity: 1e9, guests: [] }],
    })
    expect(out.tables[0].capacity).toBe(MAX_GUESTS_PER_TABLE)
  })
})
