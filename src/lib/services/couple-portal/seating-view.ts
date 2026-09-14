/**
 * Seating view model — one source of truth for "who sits where".
 *
 * ===========================================================================
 * AUTHORITATIVE COLUMN: `guest_list.table_assignment` (text, holds the table
 * NAME, not an id).
 * ===========================================================================
 *
 * There are two candidate columns on `guest_list` and only one of them has
 * ever carried data:
 *
 *   - `table_assignment_id` (uuid, FK to `seating_tables`, migration 004).
 *     Nothing in `src/` writes it. The only reader is the coordinator print
 *     page, which therefore prints an empty seating chart. Migration 094 also
 *     dropped the `seating_assignments` join table for the same reason, and
 *     recorded that "the seating page uses guest_list.table_assignment_id
 *     instead" — which was already wrong when it was written.
 *
 *   - `table_assignment` (text, migration 020). Written by the couple seating
 *     page, the couple guest-list page, and the wave-1 spreadsheet import
 *     (`seating-import.ts`). Read by the coordinator wedding page. This is
 *     where the real data lives.
 *
 * The floor-plan layout (`table_map_layouts.elements`) identifies a table by
 * its `label`, which is also a name. So a name is the join that the data
 * already has, end to end: guest -> table name -> `seating_tables.table_name`
 * -> map element label. Every surface reads `table_assignment` and matches on
 * a normalised name.
 *
 * No migration this wave. When `table_assignment_id` is eventually
 * backfilled and written, this module is the single place to flip.
 *
 * ---------------------------------------------------------------------------
 * A GUEST ROW IS A PARTY, NOT A PERSON
 * ---------------------------------------------------------------------------
 * One `guest_list` row is an invitation: a host, and possibly a plus one. The
 * seats a row consumes is its party size, not 1. Two standing rules, both
 * derived on read and never written back:
 *
 *   1. A blank `plus_one_name` never, on its own, creates a plus one. Do not
 *      infer one.
 *   2. Only an explicit flag (`has_plus_one` or the older `plus_one` boolean)
 *      adds a second, nameless seat. That nameless plus one is shown with the
 *      host's surname, because that is how the couple will read the place
 *      card, not because a name was stored.
 */

// ---------------------------------------------------------------------------
// Row shapes (the columns each surface actually selects)
// ---------------------------------------------------------------------------

/** The one column that says where a party sits. See the file header. */
export const SEATING_ASSIGNMENT_COLUMN = 'table_assignment' as const

export interface SeatingGuestRow {
  id: string
  first_name?: string | null
  last_name?: string | null
  /** Authoritative. Holds the table NAME. */
  table_assignment?: string | null
  plus_one?: boolean | null
  has_plus_one?: boolean | null
  plus_one_name?: string | null
  group_name?: string | null
  rsvp_status?: string | null
}

export interface SeatingTableRow {
  id: string
  table_name?: string | null
  table_type?: string | null
  capacity?: number | null
  sort_order?: number | null
}

/** One entry of `table_map_layouts.elements`. Tables carry a label + capacity. */
export interface SeatingMapElement {
  id: string
  type?: string
  label?: string | null
  capacity?: number | null
  x?: number
  y?: number
  feetW?: number
  feetH?: number
  rotation?: number
  color?: string
}

// ---------------------------------------------------------------------------
// View shapes
// ---------------------------------------------------------------------------

export interface SeatedParty {
  guestId: string
  /** The person the invitation is addressed to. */
  hostName: string
  /** Null when the row has no plus one. Derived, never stored. */
  plusOneName: string | null
  /** What to print on the table: "Ana Ruiz" or "Ana Ruiz + Guest Ruiz". */
  label: string
  /** Seats this row consumes. 1 or 2. */
  size: number
  groupName: string | null
  rsvpStatus: string | null
}

export interface SeatingTableView {
  /** `seating_tables.id`, or '' for a name only guests refer to. */
  tableId: string
  name: string
  tableType: string | null
  /** 0 means the couple has not set a seat count. */
  capacity: number
  /** Seats taken, counting plus ones. */
  seated: number
  /** capacity - seated. Negative when squeezed. */
  remaining: number
  /** How many seats past capacity. 0 when within. */
  overBy: number
  isOver: boolean
  isFull: boolean
  /** False when guests point at a name with no `seating_tables` row. */
  existsInTables: boolean
  parties: SeatedParty[]
  /** The map element this table is drawn as, when the layout has one. */
  mapElementId: string | null
  /** Plain words: "3 seats left", "Full", "2 seats over capacity". */
  capacityNote: string
  sortOrder: number
}

export interface SeatingTotals {
  parties: number
  people: number
  seatedParties: number
  seatedPeople: number
  unseatedParties: number
  unseatedPeople: number
  tables: number
  capacity: number
  tablesOverCapacity: number
}

export interface SeatingView {
  tables: SeatingTableView[]
  unseated: SeatedParty[]
  totals: SeatingTotals
  /** Table names guests sit at that have no `seating_tables` row. */
  orphanTableNames: string[]
  /** Map labels that match no table. Drawn, but nobody can sit there. */
  unmatchedMapLabels: string[]
  /** Tables with no place on the map yet. */
  tablesNotOnMap: string[]
  /** One sentence about the whole plan, or null when nothing is wrong. */
  overallNote: string | null
}

export interface BuildSeatingViewInput {
  tables: SeatingTableRow[]
  guests: SeatingGuestRow[]
  mapElements?: SeatingMapElement[]
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function clean(value: string | null | undefined): string {
  return (value ?? '').trim()
}

/** Match table names the way a person would: case and spacing do not count. */
export function normaliseTableName(name: string | null | undefined): string {
  return clean(name).toLowerCase().replace(/\s+/g, ' ')
}

export function hostName(guest: SeatingGuestRow): string {
  const name = [clean(guest.first_name), clean(guest.last_name)].filter(Boolean).join(' ')
  return name || 'Unnamed guest'
}

function hostSurname(guest: SeatingGuestRow): string {
  const last = clean(guest.last_name)
  if (last) return last
  // Some imports drop the whole name into first_name. Take its last word.
  const parts = clean(guest.first_name).split(/\s+/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : ''
}

/**
 * The plus one on this row, or null.
 *
 * Rule 1: a blank `plus_one_name` never invents a plus one.
 * Rule 2: an explicit flag with no name gives a nameless plus one, shown with
 *         the host's surname. Derived here, never written back.
 */
export function plusOneName(guest: SeatingGuestRow): string | null {
  const named = clean(guest.plus_one_name)
  if (named) return named
  const flagged = guest.has_plus_one === true || guest.plus_one === true
  if (!flagged) return null
  const surname = hostSurname(guest)
  return surname ? `Guest ${surname}` : 'Guest'
}

export function partySize(guest: SeatingGuestRow): number {
  return plusOneName(guest) ? 2 : 1
}

export function toParty(guest: SeatingGuestRow): SeatedParty {
  const host = hostName(guest)
  const plusOne = plusOneName(guest)
  return {
    guestId: guest.id,
    hostName: host,
    plusOneName: plusOne,
    label: plusOne ? `${host} + ${plusOne}` : host,
    size: plusOne ? 2 : 1,
    groupName: clean(guest.group_name) || null,
    rsvpStatus: clean(guest.rsvp_status) || null,
  }
}

// ---------------------------------------------------------------------------
// Capacity, in plain words
// ---------------------------------------------------------------------------

function seats(n: number): string {
  return n === 1 ? '1 seat' : `${n} seats`
}

export function capacityNote(capacity: number, seated: number): string {
  if (capacity <= 0) {
    return seated > 0 ? `${seats(seated)} taken, no seat count set` : 'No seat count set'
  }
  const remaining = capacity - seated
  if (remaining < 0) return `${seats(-remaining)} over capacity`
  if (remaining === 0) return 'Full'
  return `${seats(remaining)} left`
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Fold tables, guests and the floor-plan layout into one view. Pure: give it
 * the same rows and the map and the list render the same thing.
 *
 * Over capacity is reported, never prevented. A couple may squeeze an extra
 * chair in and the plan has to be able to say so.
 */
export function buildSeatingView(input: BuildSeatingViewInput): SeatingView {
  const { tables, guests, mapElements = [] } = input

  // Map element per normalised label, first one wins.
  const elementByName = new Map<string, SeatingMapElement>()
  for (const el of mapElements) {
    const key = normaliseTableName(el.label)
    if (!key) continue
    if (!elementByName.has(key)) elementByName.set(key, el)
  }

  // Parties grouped by the name they were assigned to.
  const partiesByName = new Map<string, SeatedParty[]>()
  const unseated: SeatedParty[] = []
  let totalPeople = 0

  for (const guest of guests) {
    const party = toParty(guest)
    totalPeople += party.size
    const key = normaliseTableName(guest.table_assignment)
    if (!key) {
      unseated.push(party)
      continue
    }
    const list = partiesByName.get(key)
    if (list) list.push(party)
    else partiesByName.set(key, [party])
  }

  const usedNames = new Set<string>()
  const views: SeatingTableView[] = []

  tables.forEach((table, index) => {
    const name = clean(table.table_name)
    const key = normaliseTableName(name)
    usedNames.add(key)
    const parties = partiesByName.get(key) ?? []
    const element = elementByName.get(key) ?? null
    views.push(
      makeTableView({
        tableId: table.id,
        name: name || 'Unnamed table',
        tableType: clean(table.table_type) || null,
        capacity: Math.max(0, table.capacity ?? element?.capacity ?? 0),
        parties,
        mapElementId: element?.id ?? null,
        existsInTables: true,
        sortOrder: table.sort_order ?? index,
      }),
    )
  })

  // Names guests were typed into that no table row matches. They are seated,
  // just nowhere anyone can point at, so they get a row of their own rather
  // than disappearing from both lists.
  const orphanTableNames: string[] = []
  let orphanOrder = views.length
  for (const [key, parties] of partiesByName) {
    if (usedNames.has(key)) continue
    const name = parties.length > 0 ? displayNameFor(key, guests) : key
    orphanTableNames.push(name)
    const element = elementByName.get(key) ?? null
    views.push(
      makeTableView({
        tableId: '',
        name,
        tableType: null,
        capacity: Math.max(0, element?.capacity ?? 0),
        parties,
        mapElementId: element?.id ?? null,
        existsInTables: false,
        sortOrder: orphanOrder++,
      }),
    )
  }

  views.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))

  const unmatchedMapLabels: string[] = []
  for (const el of mapElements) {
    if (el.type === 'block') continue
    const label = clean(el.label)
    if (!label) continue
    if (!usedNames.has(normaliseTableName(label))) unmatchedMapLabels.push(label)
  }

  const tablesNotOnMap = views
    .filter((v) => v.existsInTables && !v.mapElementId)
    .map((v) => v.name)

  const seatedPeople = views.reduce((sum, v) => sum + v.seated, 0)
  const unseatedPeople = unseated.reduce((sum, p) => sum + p.size, 0)
  const capacity = views.reduce((sum, v) => sum + v.capacity, 0)
  const tablesOverCapacity = views.filter((v) => v.isOver).length

  const totals: SeatingTotals = {
    parties: guests.length,
    people: totalPeople,
    seatedParties: guests.length - unseated.length,
    seatedPeople,
    unseatedParties: unseated.length,
    unseatedPeople,
    tables: views.length,
    capacity,
    tablesOverCapacity,
  }

  return {
    tables: views,
    unseated,
    totals,
    orphanTableNames,
    unmatchedMapLabels,
    tablesNotOnMap,
    overallNote: overallNoteFor(totals, orphanTableNames),
  }
}

function makeTableView(args: {
  tableId: string
  name: string
  tableType: string | null
  capacity: number
  parties: SeatedParty[]
  mapElementId: string | null
  existsInTables: boolean
  sortOrder: number
}): SeatingTableView {
  const seated = args.parties.reduce((sum, p) => sum + p.size, 0)
  const remaining = args.capacity - seated
  const isOver = args.capacity > 0 && remaining < 0
  return {
    tableId: args.tableId,
    name: args.name,
    tableType: args.tableType,
    capacity: args.capacity,
    seated,
    remaining,
    overBy: isOver ? -remaining : 0,
    isOver,
    isFull: args.capacity > 0 && remaining === 0,
    existsInTables: args.existsInTables,
    parties: args.parties,
    mapElementId: args.mapElementId,
    capacityNote: capacityNote(args.capacity, seated),
    sortOrder: args.sortOrder,
  }
}

/** Recover the spelling a guest actually typed for a normalised key. */
function displayNameFor(key: string, guests: SeatingGuestRow[]): string {
  for (const g of guests) {
    const raw = clean(g.table_assignment)
    if (raw && normaliseTableName(raw) === key) return raw
  }
  return key
}

function overallNoteFor(totals: SeatingTotals, orphanTableNames: string[]): string | null {
  const parts: string[] = []
  if (totals.tablesOverCapacity > 0) {
    parts.push(
      totals.tablesOverCapacity === 1
        ? '1 table is over capacity'
        : `${totals.tablesOverCapacity} tables are over capacity`,
    )
  }
  if (totals.capacity > 0 && totals.people > totals.capacity) {
    parts.push(`${totals.people} guests but only ${seats(totals.capacity)}`)
  }
  if (orphanTableNames.length > 0) {
    parts.push(
      orphanTableNames.length === 1
        ? `1 guest table name is not in your table list: ${orphanTableNames[0]}`
        : `${orphanTableNames.length} guest table names are not in your table list`,
    )
  }
  if (parts.length === 0) return null
  const sentence = parts.join(', ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.'
}
