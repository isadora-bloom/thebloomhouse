/**
 * Seating view model (NOVEMBER-PLAN.md wave 6, W44).
 *
 * The point of these tests is that the map and the assignment list are the
 * same function of the same rows. If anyone reintroduces a second reader off
 * `table_assignment_id`, or starts counting a party as one person, or blocks a
 * save because a table is full, these break.
 */

import { describe, it, expect } from 'vitest'
import {
  SEATING_ASSIGNMENT_COLUMN,
  buildSeatingView,
  capacityNote,
  countSeatedParties,
  hostName,
  normaliseTableName,
  partySize,
  plusOneName,
  toParty,
  type SeatingGuestRow,
  type SeatingMapElement,
  type SeatingTableRow,
} from '../seating-view'

function guest(over: Partial<SeatingGuestRow> & { id: string }): SeatingGuestRow {
  return { first_name: 'Ana', last_name: 'Ruiz', ...over }
}

const TABLES: SeatingTableRow[] = [
  { id: 't1', table_name: 'Table 1', table_type: 'round', capacity: 2, sort_order: 0 },
  { id: 't2', table_name: 'Head Table', table_type: 'head', capacity: 4, sort_order: 1 },
]

const ELEMENTS: SeatingMapElement[] = [
  { id: 'e1', type: 'round', label: 'Table 1', capacity: 2, x: 100, y: 100, feetW: 5, feetH: 5 },
  { id: 'e2', type: 'rect', label: 'head table', capacity: 4, x: 400, y: 100, feetW: 8, feetH: 2.5 },
  { id: 'e3', type: 'block', label: 'Dance Floor', capacity: 0, x: 250, y: 300, feetW: 20, feetH: 20 },
]

describe('the authoritative column', () => {
  it('is guest_list.table_assignment', () => {
    expect(SEATING_ASSIGNMENT_COLUMN).toBe('table_assignment')
  })
})

describe('names — a row is a party, not a person', () => {
  it('reads the host name off first and last', () => {
    expect(hostName(guest({ id: 'g1' }))).toBe('Ana Ruiz')
  })

  it('falls back rather than rendering an empty name', () => {
    expect(hostName({ id: 'g1', first_name: null, last_name: null })).toBe('Unnamed guest')
  })

  it('never infers a plus one from a blank name', () => {
    expect(plusOneName(guest({ id: 'g1', plus_one_name: '   ' }))).toBeNull()
    expect(partySize(guest({ id: 'g1', plus_one_name: null }))).toBe(1)
  })

  it('uses the stored plus-one name when there is one', () => {
    const p = toParty(guest({ id: 'g1', plus_one_name: 'Sam Okafor' }))
    expect(p.plusOneName).toBe('Sam Okafor')
    expect(p.label).toBe('Ana Ruiz + Sam Okafor')
    expect(p.size).toBe(2)
  })

  it('gives a nameless, flagged plus one the host surname', () => {
    expect(plusOneName(guest({ id: 'g1', has_plus_one: true }))).toBe('Guest Ruiz')
    expect(plusOneName(guest({ id: 'g1', plus_one: true }))).toBe('Guest Ruiz')
    expect(partySize(guest({ id: 'g1', has_plus_one: true }))).toBe(2)
  })

  it('takes the surname off a single crammed name field', () => {
    expect(
      plusOneName({ id: 'g1', first_name: 'Ana Maria Ruiz', last_name: null, has_plus_one: true }),
    ).toBe('Guest Ruiz')
  })

  it('says just Guest when there is no surname to inherit', () => {
    expect(plusOneName({ id: 'g1', first_name: 'Ana', last_name: null, has_plus_one: true })).toBe(
      'Guest',
    )
  })
})

describe('capacity, in plain words', () => {
  it('counts seats left', () => {
    expect(capacityNote(8, 5)).toBe('3 seats left')
    expect(capacityNote(8, 7)).toBe('1 seat left')
  })

  it('says full without dressing it up', () => {
    expect(capacityNote(8, 8)).toBe('Full')
  })

  it('says how far over, in seats', () => {
    expect(capacityNote(8, 9)).toBe('1 seat over capacity')
    expect(capacityNote(8, 11)).toBe('3 seats over capacity')
  })

  it('admits when no seat count was ever set', () => {
    expect(capacityNote(0, 0)).toBe('No seat count set')
    expect(capacityNote(0, 3)).toBe('3 seats taken, no seat count set')
  })
})

describe('buildSeatingView', () => {
  it('groups parties onto tables by name, ignoring case and spacing', () => {
    const view = buildSeatingView({
      tables: TABLES,
      guests: [
        guest({ id: 'g1', table_assignment: 'Table 1' }),
        guest({ id: 'g2', first_name: 'Ben', table_assignment: ' table  1 ' }),
        guest({ id: 'g3', first_name: 'Cara', table_assignment: null }),
      ],
      mapElements: ELEMENTS,
    })

    const t1 = view.tables.find((t) => t.tableId === 't1')!
    expect(t1.parties.map((p) => p.guestId)).toEqual(['g1', 'g2'])
    expect(view.unseated.map((p) => p.guestId)).toEqual(['g3'])
  })

  it('counts seats as people, so a plus one takes a chair', () => {
    const view = buildSeatingView({
      tables: TABLES,
      guests: [guest({ id: 'g1', table_assignment: 'Table 1', has_plus_one: true })],
      mapElements: ELEMENTS,
    })
    const t1 = view.tables.find((t) => t.tableId === 't1')!
    expect(t1.seated).toBe(2)
    expect(t1.isFull).toBe(true)
    expect(t1.capacityNote).toBe('Full')
    expect(view.totals.people).toBe(2)
    expect(view.totals.seatedPeople).toBe(2)
  })

  it('reports over capacity rather than refusing it', () => {
    const view = buildSeatingView({
      tables: TABLES,
      guests: [
        guest({ id: 'g1', table_assignment: 'Table 1', has_plus_one: true }),
        guest({ id: 'g2', first_name: 'Ben', table_assignment: 'Table 1' }),
      ],
      mapElements: ELEMENTS,
    })
    const t1 = view.tables.find((t) => t.tableId === 't1')!
    expect(t1.seated).toBe(3)
    expect(t1.isOver).toBe(true)
    expect(t1.overBy).toBe(1)
    expect(t1.remaining).toBe(-1)
    expect(t1.capacityNote).toBe('1 seat over capacity')
    expect(view.totals.tablesOverCapacity).toBe(1)
    expect(view.overallNote).toContain('1 table is over capacity')
  })

  it('joins a table to its map element by label', () => {
    const view = buildSeatingView({ tables: TABLES, guests: [], mapElements: ELEMENTS })
    expect(view.tables.find((t) => t.tableId === 't1')!.mapElementId).toBe('e1')
    // 'head table' on the plan, 'Head Table' in the list — same table.
    expect(view.tables.find((t) => t.tableId === 't2')!.mapElementId).toBe('e2')
    expect(view.tablesNotOnMap).toEqual([])
    expect(view.unmatchedMapLabels).toEqual([])
  })

  it('does not treat a dance floor as a table nobody can sit at', () => {
    const view = buildSeatingView({ tables: TABLES, guests: [], mapElements: ELEMENTS })
    expect(view.unmatchedMapLabels).not.toContain('Dance Floor')
  })

  it('names the tables that are drawn but not in the list', () => {
    const view = buildSeatingView({
      tables: [TABLES[0]],
      guests: [],
      mapElements: ELEMENTS,
    })
    expect(view.unmatchedMapLabels).toEqual(['head table'])
  })

  it('names the tables in the list that are not drawn yet', () => {
    const view = buildSeatingView({
      tables: TABLES,
      guests: [],
      mapElements: [ELEMENTS[0]],
    })
    expect(view.tablesNotOnMap).toEqual(['Head Table'])
  })

  it('surfaces a typed table name that matches no table, rather than losing it', () => {
    const view = buildSeatingView({
      tables: TABLES,
      guests: [guest({ id: 'g1', table_assignment: 'Table 7' })],
      mapElements: ELEMENTS,
    })
    expect(view.orphanTableNames).toEqual(['Table 7'])
    const orphan = view.tables.find((t) => t.name === 'Table 7')!
    expect(orphan.existsInTables).toBe(false)
    expect(orphan.parties).toHaveLength(1)
    // Still counted as seated: the guest is somewhere, just not anywhere real.
    expect(view.unseated).toHaveLength(0)
    expect(view.overallNote).toContain('Table 7')
  })

  it('is quiet when the plan is sound', () => {
    const view = buildSeatingView({
      tables: TABLES,
      guests: [guest({ id: 'g1', table_assignment: 'Table 1' })],
      mapElements: ELEMENTS,
    })
    expect(view.overallNote).toBeNull()
  })

  it('warns when there are more guests than seats in the room', () => {
    const view = buildSeatingView({
      tables: [{ id: 't1', table_name: 'Table 1', capacity: 1 }],
      guests: [guest({ id: 'g1' }), guest({ id: 'g2', first_name: 'Ben' })],
      mapElements: [],
    })
    expect(view.overallNote).toContain('2 guests but only 1 seat')
  })

  it('keeps the same table order the couple set', () => {
    const view = buildSeatingView({
      tables: [
        { id: 't2', table_name: 'Head Table', sort_order: 1, capacity: 4 },
        { id: 't1', table_name: 'Table 1', sort_order: 0, capacity: 2 },
      ],
      guests: [],
    })
    expect(view.tables.map((t) => t.tableId)).toEqual(['t1', 't2'])
  })
})

describe('countSeatedParties — used by the coordinator wedding page (W61)', () => {
  it('counts rows with a non-blank table_assignment, matching totals.seatedParties', () => {
    const guests = [
      guest({ id: 'g1', table_assignment: 'Table 1' }),
      guest({ id: 'g2', first_name: 'Ben', table_assignment: '   ' }),
      guest({ id: 'g3', first_name: 'Cara', table_assignment: null }),
    ]
    expect(countSeatedParties(guests)).toBe(1)
    const view = buildSeatingView({ tables: TABLES, guests, mapElements: ELEMENTS })
    expect(countSeatedParties(guests)).toBe(view.totals.seatedParties)
  })

  it('needs nothing but table_assignment, not the full guest shape', () => {
    expect(countSeatedParties([{ table_assignment: 'Table 1' }, { table_assignment: null }])).toBe(1)
  })
})

describe('normaliseTableName', () => {
  it('collapses case and whitespace so a typo in spacing still matches', () => {
    expect(normaliseTableName('  Head   Table ')).toBe('head table')
    expect(normaliseTableName(null)).toBe('')
  })
})
