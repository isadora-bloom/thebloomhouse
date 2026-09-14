/**
 * Seating chart import service.
 * Parses an xlsx/csv file uploaded by a couple into a structured preview,
 * then commits tables + guests + allergy records to the DB.
 */

import * as XLSX from 'xlsx'
import { callAIJson } from '@/lib/ai/client'
import { createServiceClient } from '@/lib/supabase/service'
import { writeOrLog } from '@/lib/db/write-or-log'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportedGuest {
  full_name: string
  first_name: string
  last_name: string | null
  relationship: string | null
  coordinator_notes: string | null
  dietary_restrictions: string | null
  rsvp_status: 'attending' | 'pending' | 'maybe' | 'declined' | null
  seat_number: number | null
}

export interface ImportedTable {
  table_name: string
  table_type: 'round' | 'rectangular' | 'head' | 'sweetheart' | 'farm' | 'cocktail'
  capacity: number
  notes: string | null
  guests: ImportedGuest[]
}

export interface ParsedSeatingChart {
  tables: ImportedTable[]
  global_notes: string | null
  total_guests: number
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Parse xlsx/csv buffer → ParsedSeatingChart
// ---------------------------------------------------------------------------

export async function parseSeatingFile(buffer: Buffer, filename: string): Promise<ParsedSeatingChart> {
  void filename  // used by callers for MIME validation; xlsx.read handles format detection
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })

  // Find the most data-rich sheet (exclude obvious notes-only sheets)
  const dataSheet = findDataSheet(workbook)
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(dataSheet, {
    header: 1,
    defval: null,
    blankrows: false,
  }) as unknown[][]

  if (rawRows.length < 2) {
    throw new Error('Spreadsheet appears empty — needs at least a header row and one data row.')
  }

  // Extract header row (first non-empty row)
  const headerRow = rawRows[0] as (string | null)[]
  const dataRows = rawRows.slice(1)

  // Use Claude Haiku to map column indices to our known fields
  const colMap = await detectColumns(headerRow, dataRows.slice(0, 3))

  // Also look for a "Notes" sheet for global notes
  const globalNotes = extractGlobalNotes(workbook, dataSheet)

  // Build tables map from data rows
  return buildChart(dataRows, colMap, globalNotes)
}

// ---------------------------------------------------------------------------
// Find the main data sheet (most rows wins; skip obvious meta sheets)
// ---------------------------------------------------------------------------

function findDataSheet(wb: XLSX.WorkBook): XLSX.WorkSheet {
  if (wb.SheetNames.length === 1) return wb.Sheets[wb.SheetNames[0]]

  const SKIP = /notes?|legend|key|instructions?|readme|about|meta/i
  const candidates = wb.SheetNames.filter((n) => !SKIP.test(n))
  const names = candidates.length > 0 ? candidates : wb.SheetNames

  let best = wb.Sheets[names[0]]
  let bestRows = 0
  for (const name of names) {
    const ws = wb.Sheets[name]
    const ref = ws['!ref']
    if (!ref) continue
    const range = XLSX.utils.decode_range(ref)
    if (range.e.r > bestRows) {
      bestRows = range.e.r
      best = ws
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Extract global notes from a "Notes" sheet if present
// ---------------------------------------------------------------------------

function extractGlobalNotes(wb: XLSX.WorkBook, mainSheet: XLSX.WorkSheet): string | null {
  const notesSheetName = wb.SheetNames.find((n) => /notes?/i.test(n))
  if (!notesSheetName) return null
  const ws = wb.Sheets[notesSheetName]
  if (ws === mainSheet) return null

  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    blankrows: false,
  }) as unknown[][]

  const lines: string[] = []
  for (const row of rows) {
    const vals = (row as unknown[]).filter((v) => v !== null && v !== undefined && String(v).trim())
    if (vals.length > 0) lines.push(String(vals[0]).trim())
  }
  return lines.length > 0 ? lines.join('\n') : null
}

// ---------------------------------------------------------------------------
// Column detection via Claude Haiku
// ---------------------------------------------------------------------------

interface ColumnMap {
  table: number | null
  seat: number | null
  name: number | null
  relationship: number | null
  notes: number | null
  allergies: number | null
  table_notes: number | null
  rsvp: number | null
}

async function detectColumns(
  headers: (string | null)[],
  sampleRows: unknown[][],
): Promise<ColumnMap> {
  const headerStr = headers.map((h, i) => `${i}: "${h ?? ''}"`).join(', ')
  const sampleStr = sampleRows
    .map((row, ri) =>
      `Row ${ri + 1}: [${(row as unknown[]).map((v) => JSON.stringify(v ?? null)).join(', ')}]`,
    )
    .join('\n')

  const result = await callAIJson<ColumnMap>({
    systemPrompt: 'You are mapping spreadsheet columns for a wedding seating chart import. Return only JSON.',
    userPrompt: `Headers (index: name): ${headerStr}

Sample data rows:
${sampleStr}

Return a JSON object mapping each logical field to its 0-based column index (null if not present):
- table: the column containing the table name/number
- seat: the seat number within the table
- name: the guest's full name
- relationship: who they are (relationship to couple, role, etc.)
- notes: per-guest notes or special instructions for coordinators
- allergies: dietary restrictions or allergies
- table_notes: a per-table summary or description (often only on the first guest row of each table)
- rsvp: RSVP or attendance status

Only return the JSON object, no explanation.`,
    promptVersion: 'seating-import-col-detect-v1',
    tier: 'haiku',
  })

  return result ?? {
    table: null, seat: null, name: null, relationship: null,
    notes: null, allergies: null, table_notes: null, rsvp: null,
  }
}

// ---------------------------------------------------------------------------
// Build chart from rows + column map
// ---------------------------------------------------------------------------

function buildChart(
  rows: unknown[][],
  colMap: ColumnMap,
  globalNotes: string | null,
): ParsedSeatingChart {
  if (colMap.table === null || colMap.name === null) {
    throw new Error(
      'Could not identify the table name or guest name columns. ' +
      'Make sure your spreadsheet has clear column headers.',
    )
  }

  const tablesMap = new Map<string, ImportedTable>()
  const warnings: string[] = []
  let totalGuests = 0

  for (const row of rows) {
    const cells = row as unknown[]
    const rawTable = safeStr(cells[colMap.table!])
    const rawName = colMap.name !== null ? safeStr(cells[colMap.name]) : null

    if (!rawName) continue  // skip rows without a guest name

    const tableName = rawTable || 'Unassigned'

    if (!tablesMap.has(tableName)) {
      tablesMap.set(tableName, {
        table_name: tableName,
        table_type: inferTableType(tableName),
        capacity: 0,
        notes: null,
        guests: [],
      })
    }

    const table = tablesMap.get(tableName)!

    // Per-table summary: only read it once (first guest row of each table)
    if (colMap.table_notes !== null && table.guests.length === 0) {
      const tn = safeStr(cells[colMap.table_notes])
      if (tn) table.notes = tn
    }

    const { first_name, last_name } = splitName(rawName)
    const relationship = colMap.relationship !== null ? safeStr(cells[colMap.relationship]) : null
    const coordNotes = colMap.notes !== null ? safeStr(cells[colMap.notes]) : null
    const dietary = colMap.allergies !== null ? safeStr(cells[colMap.allergies]) : null
    const rawRsvp = colMap.rsvp !== null ? safeStr(cells[colMap.rsvp]) : null
    const rsvpStatus = parseRsvp(rawRsvp)
    const seatNum = colMap.seat !== null ? safeNum(cells[colMap.seat]) : null

    table.guests.push({
      full_name: rawName,
      first_name,
      last_name,
      relationship,
      coordinator_notes: coordNotes,
      dietary_restrictions: dietary,
      rsvp_status: rsvpStatus,
      seat_number: seatNum,
    })
    table.capacity = Math.max(table.capacity, table.guests.length)
    totalGuests++
  }

  // Sweep: round up capacity to the nearest multiple of 2 so there's breathing room
  for (const table of tablesMap.values()) {
    if (table.table_type !== 'sweetheart') {
      table.capacity = Math.max(table.guests.length, table.capacity)
    }
  }

  return {
    tables: Array.from(tablesMap.values()),
    global_notes: globalNotes,
    total_guests: totalGuests,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Shape validation for the commit payload
// ---------------------------------------------------------------------------

/**
 * S5 (2026-09-14 security audit, item 11).
 *
 * The commit step takes the chart back from the browser as a JSON string
 * and used to `JSON.parse` it and cast straight to ParsedSeatingChart. A
 * cast is not a check: the couple's own form post decided what got
 * written, how many rows got written, and what type every field was. A
 * chart with 200,000 tables is a database-filling DoS that needs no
 * exploit at all, just a loop in the console; a table_name that is an
 * object rather than a string reaches the query builder as one.
 *
 * So the payload is parsed properly here, with caps that are an order of
 * magnitude past any real wedding. Numbers are clamped rather than
 * rejected, strings are trimmed and bounded, unknown fields are dropped.
 * What comes out is a ParsedSeatingChart the commit path can trust.
 */

/** A very large wedding is 60 tables. Two hundred is not a real chart. */
export const MAX_IMPORT_TABLES = 200
/** A very large table is 14. A hundred is not a real table. */
export const MAX_GUESTS_PER_TABLE = 100
/** Across the whole chart. */
export const MAX_IMPORT_GUESTS = 3000
const MAX_NAME_CHARS = 200
const MAX_NOTE_CHARS = 2000

export class SeatingChartShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeatingChartShapeError'
  }
}

const TABLE_TYPES: ReadonlySet<string> = new Set([
  'round',
  'rectangular',
  'head',
  'sweetheart',
  'farm',
  'cocktail',
])

const RSVP_STATUSES: ReadonlySet<string> = new Set([
  'attending',
  'pending',
  'maybe',
  'declined',
])

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (!t) return null
  return t.slice(0, max)
}

function int(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, Math.round(n)))
}

export function validateParsedSeatingChart(raw: unknown): ParsedSeatingChart {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SeatingChartShapeError('chart must be an object')
  }
  const input = raw as Record<string, unknown>

  if (!Array.isArray(input.tables)) {
    throw new SeatingChartShapeError('chart.tables must be an array')
  }
  if (input.tables.length > MAX_IMPORT_TABLES) {
    throw new SeatingChartShapeError(
      `That chart has ${input.tables.length} tables; the limit is ${MAX_IMPORT_TABLES}.`,
    )
  }

  const tables: ImportedTable[] = []
  let totalGuests = 0

  for (const rawTable of input.tables) {
    if (!rawTable || typeof rawTable !== 'object' || Array.isArray(rawTable)) {
      throw new SeatingChartShapeError('every table must be an object')
    }
    const t = rawTable as Record<string, unknown>

    const tableName = str(t.table_name, MAX_NAME_CHARS)
    if (!tableName) {
      throw new SeatingChartShapeError('every table needs a name')
    }

    const rawGuests = Array.isArray(t.guests) ? t.guests : []
    if (rawGuests.length > MAX_GUESTS_PER_TABLE) {
      throw new SeatingChartShapeError(
        `"${tableName}" has ${rawGuests.length} guests; the limit per table is ${MAX_GUESTS_PER_TABLE}.`,
      )
    }

    const guests: ImportedGuest[] = []
    for (const rawGuest of rawGuests) {
      if (!rawGuest || typeof rawGuest !== 'object' || Array.isArray(rawGuest)) {
        throw new SeatingChartShapeError('every guest must be an object')
      }
      const g = rawGuest as Record<string, unknown>
      const fullName = str(g.full_name, MAX_NAME_CHARS)
      const firstName = str(g.first_name, MAX_NAME_CHARS) ?? fullName
      if (!fullName || !firstName) {
        throw new SeatingChartShapeError('every guest needs a name')
      }
      const rsvp = str(g.rsvp_status, 32)
      guests.push({
        full_name: fullName,
        first_name: firstName,
        last_name: str(g.last_name, MAX_NAME_CHARS),
        relationship: str(g.relationship, MAX_NAME_CHARS),
        coordinator_notes: str(g.coordinator_notes, MAX_NOTE_CHARS),
        dietary_restrictions: str(g.dietary_restrictions, MAX_NOTE_CHARS),
        rsvp_status:
          rsvp && RSVP_STATUSES.has(rsvp)
            ? (rsvp as ImportedGuest['rsvp_status'])
            : null,
        seat_number: int(g.seat_number, 0, MAX_GUESTS_PER_TABLE),
      })
    }

    totalGuests += guests.length
    if (totalGuests > MAX_IMPORT_GUESTS) {
      throw new SeatingChartShapeError(
        `That chart has more than ${MAX_IMPORT_GUESTS} guests, which is past what this import handles.`,
      )
    }

    const tableType = str(t.table_type, 32)
    tables.push({
      table_name: tableName,
      table_type:
        tableType && TABLE_TYPES.has(tableType)
          ? (tableType as ImportedTable['table_type'])
          : 'round',
      capacity: int(t.capacity, 0, MAX_GUESTS_PER_TABLE) ?? guests.length,
      notes: str(t.notes, MAX_NOTE_CHARS),
      guests,
    })
  }

  const warnings = Array.isArray(input.warnings)
    ? input.warnings
        .map((w) => str(w, MAX_NOTE_CHARS))
        .filter((w): w is string => w !== null)
        .slice(0, 100)
    : []

  return {
    tables,
    global_notes: str(input.global_notes, MAX_NOTE_CHARS * 5),
    total_guests: totalGuests,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Commit parsed chart to DB
// ---------------------------------------------------------------------------

export interface CommitOptions {
  venueId: string
  weddingId: string
  chart: ParsedSeatingChart
  replaceExisting: boolean
}

export interface CommitResult {
  tablesCreated: number
  guestsCreated: number
  guestsUpdated: number
  allergiesCreated: number
}

export async function commitSeatingChart(opts: CommitOptions): Promise<CommitResult> {
  const { venueId, weddingId, chart, replaceExisting } = opts
  const supabase = createServiceClient()

  // Optionally wipe existing seating_tables for this wedding
  if (replaceExisting) {
    // Unassign all guests first (FK to seating_tables not needed, but clear table_assignment)
    await supabase
      .from('guest_list')
      .update({ table_assignment: null })
      .eq('wedding_id', weddingId)

    await supabase.from('seating_tables').delete().eq('wedding_id', weddingId)
  }

  // Fetch existing guests for name-matching
  const { data: existingGuests } = await supabase
    .from('guest_list')
    .select('id, first_name, last_name')
    .eq('wedding_id', weddingId)

  const guestIndex = new Map<string, string>()  // name key → id
  for (const g of existingGuests ?? []) {
    const key = nameKey(g.first_name ?? '', g.last_name ?? '')
    guestIndex.set(key, g.id)
  }

  let tablesCreated = 0
  let guestsCreated = 0
  let guestsUpdated = 0
  let allergiesCreated = 0

  let sortOrder = 0
  for (const table of chart.tables) {
    // Upsert seating_table (match by table_name+wedding_id)
    const { data: existingTable } = await supabase
      .from('seating_tables')
      .select('id')
      .eq('wedding_id', weddingId)
      .eq('table_name', table.table_name)
      .maybeSingle()

    let tableId: string
    if (existingTable) {
      await supabase
        .from('seating_tables')
        .update({
          table_type: table.table_type,
          capacity: table.capacity,
          notes: table.notes,
          sort_order: sortOrder,
        })
        .eq('id', existingTable.id)
      tableId = existingTable.id
    } else {
      const { data: newTable, error } = await supabase
        .from('seating_tables')
        .insert({
          venue_id: venueId,
          wedding_id: weddingId,
          table_name: table.table_name,
          table_type: table.table_type,
          capacity: table.capacity,
          notes: table.notes,
          sort_order: sortOrder,
          x_position: 0,
          y_position: 0,
          rotation: 0,
        })
        .select('id')
        .single()
      if (error) throw new Error(`Failed to create table "${table.table_name}": ${error.message}`)
      tableId = newTable.id
      tablesCreated++
    }
    sortOrder++
    void tableId  // used in future when we need seating_assignments

    // Upsert guests
    for (const guest of table.guests) {
      const key = nameKey(guest.first_name, guest.last_name ?? '')
      const existingId = guestIndex.get(key)

      const guestPayload = {
        first_name: guest.first_name,
        last_name: guest.last_name,
        group_name: guest.relationship,
        care_notes: guest.coordinator_notes,
        dietary_restrictions: guest.dietary_restrictions,
        rsvp_status: guest.rsvp_status ?? 'pending',
        table_assignment: table.table_name,
        updated_at: new Date().toISOString(),
      }

      let guestId: string
      if (existingId) {
        await supabase.from('guest_list').update(guestPayload).eq('id', existingId)
        guestId = existingId
        guestsUpdated++
      } else {
        const { data: newGuest, error } = await supabase
          .from('guest_list')
          .insert({
            venue_id: venueId,
            wedding_id: weddingId,
            ...guestPayload,
          })
          .select('id')
          .single()
        if (error) throw new Error(`Failed to create guest "${guest.full_name}": ${error.message}`)
        guestId = newGuest.id
        guestIndex.set(key, guestId)
        guestsCreated++
      }

      // Create allergy_registry entry if dietary info present
      if (guest.dietary_restrictions) {
        const { data: existingAllergy } = await supabase
          .from('allergy_registry')
          .select('id')
          .eq('wedding_id', weddingId)
          .eq('guest_name', guest.full_name)
          .maybeSingle()

        if (!existingAllergy) {
          const { error } = await writeOrLog(
            supabase.from('allergy_registry').insert({
              venue_id: venueId,
              wedding_id: weddingId,
              guest_name: guest.full_name,
              guest_id: guestId,
              allergy_type: guest.dietary_restrictions,
              severity: 'moderate',
              notes: null,
              is_important: false,
            }),
            { op: 'allergy_registry.insert', venueId, actor: 'seating_import' },
          )
          if (error) throw new Error(`Failed to create allergy entry for "${guest.full_name}": ${error.message}`)
          allergiesCreated++
        }
      }
    }
  }

  // Global notes from the spreadsheet's Notes sheet are shown in the preview
  // dialog for the couple to read — no separate persistence needed.

  return { tablesCreated, guestsCreated, guestsUpdated, allergiesCreated }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s || null
}

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

function nameKey(first: string, last: string): string {
  return `${(first || '').toLowerCase().trim()}|${(last || '').toLowerCase().trim()}`
}

function splitName(fullName: string): { first_name: string; last_name: string | null } {
  // Strip hashtag labels like "#HUBBY" or "#WIFEY"
  const cleaned = fullName.replace(/#\S+/g, '').trim()
  const parts = cleaned.split(/\s+/)
  if (parts.length === 1) return { first_name: parts[0], last_name: null }
  const last = parts[parts.length - 1]
  const first = parts.slice(0, -1).join(' ')
  return { first_name: first, last_name: last }
}

function inferTableType(name: string): ImportedTable['table_type'] {
  const lower = name.toLowerCase()
  if (lower.includes('sweet') || lower.includes('bride') || lower.includes('groom')) return 'sweetheart'
  if (lower.includes('head')) return 'head'
  if (lower.includes('farm')) return 'farm'
  if (lower.includes('cocktail') || lower.includes('high top')) return 'cocktail'
  if (lower.includes('rect') || lower.includes('long')) return 'rectangular'
  return 'round'
}

function parseRsvp(raw: string | null): ImportedGuest['rsvp_status'] {
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (lower.includes('going') || lower.includes('attend') || lower.includes('yes') || lower.includes('confirmed')) return 'attending'
  if (lower.includes('decline') || lower.includes('no') || lower.includes('not coming')) return 'declined'
  if (lower.includes('maybe') || lower.includes('unsure') || lower.includes('likely')) return 'maybe'
  return 'pending'
}
