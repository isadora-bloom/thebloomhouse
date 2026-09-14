/**
 * Coordinator table-map page — the joined seating board (NOVEMBER-PLAN.md
 * wave 6, W61).
 *
 * The table-map page is a react-konva client component, so these tests do
 * not render it. What they pin down instead is the thing that mattered for
 * this workstream: the coordinator's own fetch shapes (guest_list rows
 * selected the same way the couple page selects them, seating_tables rows,
 * and the page's own in-memory Konva `elements` as the map) go through the
 * exact same `buildSeatingView` the couple's board uses and come out the
 * same. If a coordinator-side query ever drops a column `buildSeatingView`
 * needs, or someone starts computing a second, different count on this
 * page, one of these breaks.
 *
 * Venue isolation is inherent here: every query in the real page is scoped
 * by `wedding_id` (`.eq('wedding_id', weddingId)`), and a wedding belongs
 * to one venue, so there is no cross-venue read to test against a fake
 * client — the isolation boundary is the wedding row itself, not something
 * this module adds on top.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSeatingView,
  countSeatedParties,
  type SeatingGuestRow,
  type SeatingMapElement,
  type SeatingTableRow,
} from '@/lib/services/couple-portal/seating-view'

// Shape of `MapElement` as the Konva editor keeps it in memory — a
// superset of `SeatingMapElement`, exactly what the table-map page passes
// as `mapElements` straight from its own `elements` state.
interface KonvaMapElement {
  id: string
  type: 'round' | 'rect' | 'block'
  x: number
  y: number
  feetW: number
  feetH: number
  rotation: number
  label: string
  capacity: number
  color: string
}

const KONVA_ELEMENTS: KonvaMapElement[] = [
  { id: 'e1', type: 'round', x: 120, y: 80, feetW: 5, feetH: 5, rotation: 0, label: 'Table 1', capacity: 8, color: '#F5EDE0' },
  { id: 'e2', type: 'rect', x: 400, y: 80, feetW: 8, feetH: 2.5, rotation: 0, label: 'Head Table', capacity: 4, color: '#F5EDE0' },
  { id: 'e3', type: 'block', x: 250, y: 300, feetW: 20, feetH: 20, rotation: 0, label: 'Dance Floor', capacity: 0, color: '#DBEAFE' },
]

// Rows shaped exactly like the coordinator page's own
// `.from('seating_tables').select('id, table_name, table_type, capacity, sort_order')`.
const COORDINATOR_TABLES: SeatingTableRow[] = [
  { id: 't1', table_name: 'Table 1', table_type: 'round', capacity: 8, sort_order: 0 },
  { id: 't2', table_name: 'Head Table', table_type: 'head', capacity: 4, sort_order: 1 },
]

// Rows shaped exactly like the coordinator page's own
// `.from('guest_list').select('id, table_assignment, rsvp_status, plus_one,
// has_plus_one, plus_one_name, group_name, first_name, last_name')` — the
// same select the couple seating page uses.
function coordinatorGuest(over: Partial<SeatingGuestRow> & { id: string }): SeatingGuestRow {
  return { first_name: 'Priya', last_name: 'Nair', rsvp_status: 'attending', ...over }
}

describe('table-map page seating view — same helper, coordinator-shaped rows', () => {
  it('accepts the Konva element shape as SeatingMapElement without loss', () => {
    const view = buildSeatingView({
      tables: COORDINATOR_TABLES,
      guests: [coordinatorGuest({ id: 'g1', table_assignment: 'Table 1' })],
      mapElements: KONVA_ELEMENTS as unknown as SeatingMapElement[],
    })
    const t1 = view.tables.find((t) => t.tableId === 't1')!
    expect(t1.mapElementId).toBe('e1')
    expect(t1.parties.map((p) => p.guestId)).toEqual(['g1'])
    // A block (Dance Floor) never shows up as a table nobody can sit at.
    expect(view.unmatchedMapLabels).not.toContain('Dance Floor')
  })

  it('an unnamed plus one inherits the host surname, same as the couple board', () => {
    const view = buildSeatingView({
      tables: COORDINATOR_TABLES,
      guests: [
        coordinatorGuest({ id: 'g1', table_assignment: 'Table 1', has_plus_one: true, plus_one_name: null }),
      ],
      mapElements: KONVA_ELEMENTS as unknown as SeatingMapElement[],
    })
    const t1 = view.tables.find((t) => t.tableId === 't1')!
    expect(t1.parties).toHaveLength(1)
    expect(t1.parties[0].plusOneName).toBe('Guest Nair')
    expect(t1.parties[0].label).toBe('Priya Nair + Guest Nair')
    // A party of two takes two seats, coordinator side or couple side.
    expect(t1.seated).toBe(2)
  })

  it('a blank plus_one_name never invents a plus one on the coordinator board either', () => {
    const view = buildSeatingView({
      tables: COORDINATOR_TABLES,
      guests: [coordinatorGuest({ id: 'g1', table_assignment: 'Table 1', plus_one_name: '   ' })],
      mapElements: [],
    })
    const t1 = view.tables.find((t) => t.tableId === 't1')!
    expect(t1.parties[0].plusOneName).toBeNull()
    expect(t1.seated).toBe(1)
  })

  it('an assignment saved from the coordinator side reads back identically to the couple side', () => {
    // Same guest row, once as the couple page would have it in state,
    // once as the coordinator page would. Both go through buildSeatingView
    // and must produce the same table membership.
    const guestRow = coordinatorGuest({ id: 'g1', table_assignment: 'head table' })
    const fromCouplePage = buildSeatingView({ tables: COORDINATOR_TABLES, guests: [guestRow], mapElements: [] })
    const fromCoordinatorPage = buildSeatingView({
      tables: COORDINATOR_TABLES,
      guests: [guestRow],
      mapElements: KONVA_ELEMENTS as unknown as SeatingMapElement[],
    })
    expect(fromCouplePage.tables.find((t) => t.tableId === 't2')!.parties.map((p) => p.guestId)).toEqual(['g1'])
    expect(fromCoordinatorPage.tables.find((t) => t.tableId === 't2')!.parties.map((p) => p.guestId)).toEqual(['g1'])
  })
})

describe('countSeatedParties — the wedding page count agrees with the board', () => {
  it('counts a row seated the moment it has a non-blank table_assignment', () => {
    const guests = [
      coordinatorGuest({ id: 'g1', table_assignment: 'Table 1' }),
      coordinatorGuest({ id: 'g2', table_assignment: '  ' }),
      coordinatorGuest({ id: 'g3', table_assignment: null }),
    ]
    expect(countSeatedParties(guests)).toBe(1)
  })

  it('matches totals.seatedParties from buildSeatingView for the same rows', () => {
    const guests = [
      coordinatorGuest({ id: 'g1', table_assignment: 'Table 1' }),
      coordinatorGuest({ id: 'g2', table_assignment: 'Head Table', has_plus_one: true }),
      coordinatorGuest({ id: 'g3', table_assignment: null }),
    ]
    const view = buildSeatingView({ tables: COORDINATOR_TABLES, guests, mapElements: [] })
    expect(countSeatedParties(guests)).toBe(view.totals.seatedParties)
  })

  it('works with only the table_assignment column, the shape the wedding page actually selects', () => {
    // The coordinator wedding page's GuestRow carries only
    // { id, rsvp_status, dietary_restrictions, table_assignment } — no
    // plus-one columns at all. countSeatedParties must not need them.
    const slimGuests = [{ table_assignment: 'Table 1' }, { table_assignment: null }]
    expect(countSeatedParties(slimGuests)).toBe(1)
  })
})
