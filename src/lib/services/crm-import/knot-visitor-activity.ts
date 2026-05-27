/**
 * Knot visitor-activity CSV ingester (migration 377).
 *
 * Operator-shared 2026-05-27: The Knot exports a CSV called
 *   `<Venue>-visitor-activities (N).csv`
 * with columns:
 *   Action Taken, Visitor Name, Date of Visit, City, State
 *
 * Sibling adapter `storefront-activity.ts` already lands the SAME CSV
 * shape into `tangential_signals` for funnel-rollup purposes. This new
 * adapter is additive — it lands every row into the dedicated
 * `knot_visitor_activity` table so the dedicated identity matcher
 * (knot-visitor-match.ts) can:
 *
 *   1. Try to bind "Doug L." rows to the people table (first name +
 *      last initial + temporal corroboration).
 *   2. Promote save / message rows for unmatched visitors to GHOST
 *      records via the cascade — visitors who showed real intent but
 *      never sent identifiable contact info.
 *   3. Detect VERIFICATION VISITS: when a couple ALREADY in pipeline
 *      comes back to Knot to view the profile, emit a heat signal
 *      (engagement_events.event_type='knot_verification_visit') that
 *      Bloom had no visibility into before.
 *
 * THE TWO ADAPTERS ARE NOT REDUNDANT:
 *   - storefront-activity.ts → aggregate funnel signals
 *     (tangential_signals; views/saves/messages rollup)
 *   - knot-visitor-activity.ts → per-row identity-bound history
 *     (knot_visitor_activity; supports per-couple journey metrics
 *     and verification-visit detection)
 *
 * Idempotency
 * -----------
 * Per the recurring-CSV doctrine (memory/bloom-recurring-csv-import-
 * doctrine.md), Knot exports are 12-month rolling windows that
 * operators re-upload weekly with ~95% overlap. Every row gets a
 * `row_fingerprint = sha256(venue|name|action|when|city|state)` and
 * `knot_visitor_activity.UNIQUE(venue_id, row_fingerprint)` short-
 * circuits the dup on insert. Re-uploading the same file is a no-op.
 *
 * Service-role keys must NEVER be written into committed code — the
 * caller passes in a SupabaseClient already bound to the right scope.
 */

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCsvRows } from '@/lib/services/brain-dump/csv-shape'

// ---------------------------------------------------------------------------
// Action classification — Knot's free-text "Action Taken" → canonical enum.
// ---------------------------------------------------------------------------

export type KnotAction =
  | 'storefront_view'
  | 'storefront_save'
  | 'message'
  | 'click_to_website'
  | 'click_to_social'
  | 'other'

/**
 * Normalise the raw "Action Taken" string to the migration-377
 * `action_taken` CHECK enum. Order of tests matters — "click to social"
 * contains "click" but must NOT collapse to a bare 'click' bucket.
 *
 * Returns `null` (instead of 'other') ONLY for empty input so the caller
 * can skip the row; any non-empty value that doesn't match a known
 * action lands as 'other' with the raw kept in visitor_name_raw /
 * upstream payload.
 */
export function classifyKnotAction(raw: string | null | undefined): KnotAction | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null

  // Click-to-Website / Click-to-Social FIRST so the generic "click"
  // check below doesn't swallow them.
  if (/\bclick\s*to\s*website\b/.test(trimmed)) return 'click_to_website'
  if (/\bclick\s*to\s*social\b/.test(trimmed)) return 'click_to_social'

  // Messages are the strongest funnel signal short of a booking.
  if (/\bmessage\b/.test(trimmed)) return 'message'

  // Saves (favourite the venue) — second-strongest discovery signal.
  if (/\bsave\b/.test(trimmed)) return 'storefront_save'

  // Plain "Storefront View" — most common, lowest intent.
  if (/\bview\b/.test(trimmed)) return 'storefront_view'

  // Generic Click without a target → treat as website click (the
  // common shape when Knot truncates the verb).
  if (/\bclick\b/.test(trimmed)) return 'click_to_website'

  return 'other'
}

// ---------------------------------------------------------------------------
// Date parsing — Knot uses "MM/DD/YYYY" most commonly, occasionally
// "Mon DD, YYYY" or full ISO. Sanity-check the year so an off-by-100
// CSV row ("0024-04-15") doesn't slip past.
// ---------------------------------------------------------------------------

export function parseKnotDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw.trim()
  if (!text) return null

  // Reject obviously fuzzy answers.
  if (/^(tbd|n\/a|unknown|--)$/i.test(text)) return null

  const d = new Date(text)
  if (Number.isNaN(d.getTime())) return null

  const yr = d.getUTCFullYear()
  if (yr < 2000 || yr > 2100) return null

  return d.toISOString()
}

// ---------------------------------------------------------------------------
// Name parsing — "Doug L." → first='Doug', last_initial='L'. Knot
// redacts the surname to a single letter in CSV exports.
// ---------------------------------------------------------------------------

export interface ParsedVisitorName {
  first_name: string | null
  last_initial: string | null
  raw: string | null
}

export function parseVisitorName(raw: string | null | undefined): ParsedVisitorName {
  if (!raw) return { first_name: null, last_initial: null, raw: null }
  const trimmed = raw.trim()
  if (!trimmed) return { first_name: null, last_initial: null, raw: null }
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { first_name: null, last_initial: null, raw: trimmed }
  if (tokens.length === 1) {
    return { first_name: tokens[0] ?? null, last_initial: null, raw: trimmed }
  }
  const last = (tokens[tokens.length - 1] ?? '').replace(/[^A-Za-z]/g, '')
  return {
    first_name: tokens[0] ?? null,
    last_initial: last ? (last[0]?.toUpperCase() ?? null) : null,
    raw: trimmed,
  }
}

// ---------------------------------------------------------------------------
// Row fingerprint — sha256 of the normalised tuple. UNIQUE per venue.
// Stable across re-uploads of the same row; changes only when the
// underlying data changes (which Knot does not — exports are immutable).
// ---------------------------------------------------------------------------

export function computeRowFingerprint(args: {
  venueId: string
  visitorName: string
  actionTaken: KnotAction
  actionAtIso: string
  city: string | null
  state: string | null
}): string {
  const parts = [
    args.venueId.trim().toLowerCase(),
    args.visitorName.trim().toLowerCase(),
    args.actionTaken,
    args.actionAtIso,
    (args.city ?? '').trim().toLowerCase(),
    (args.state ?? '').trim().toLowerCase(),
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

// ---------------------------------------------------------------------------
// Column detection — case-insensitive, accepts the common variants.
// ---------------------------------------------------------------------------

interface ColumnIndex {
  action: number
  visitor: number
  date: number
  city: number
  state: number
}

function indexColumns(header: string[]): ColumnIndex {
  const find = (variants: RegExp[]): number => {
    for (let i = 0; i < header.length; i++) {
      const h = (header[i] ?? '').trim()
      if (variants.some((re) => re.test(h))) return i
    }
    return -1
  }
  return {
    action: find([/^action\s*taken$/i, /^action$/i, /^activity$/i, /^event$/i]),
    visitor: find([/^visitor\s*name$/i, /^visitor$/i, /^name$/i]),
    date: find([/^date\s*of\s*visit$/i, /^visit\s*date$/i, /^date$/i, /^activity\s*date$/i]),
    city: find([/^city$/i]),
    state: find([/^state$/i, /^region$/i]),
  }
}

// ---------------------------------------------------------------------------
// Parsed row shape (one per CSV row).
// ---------------------------------------------------------------------------

export interface KnotVisitorRow {
  visitor_name: string
  visitor_first_name: string | null
  visitor_last_initial: string | null
  action_taken: KnotAction
  action_at: string                  // ISO timestamp
  city: string | null
  state: string | null
  row_fingerprint: string
}

export interface KnotVisitorParseResult {
  ok: boolean
  rows: KnotVisitorRow[]
  errors: string[]
  warnings: string[]
}

/**
 * Parse a Knot visitor-activity CSV into normalised rows. Pure — no DB
 * side effects. Caller passes the result to `importKnotVisitorActivityCsv`
 * for the commit step (or just walks `rows` directly for tests).
 */
export function parseKnotVisitorActivityCsv(args: {
  venueId: string
  csvText: string
}): KnotVisitorParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  const rows: KnotVisitorRow[] = []

  if (!args.csvText || !args.csvText.trim()) {
    return { ok: false, rows, errors: ['csv content is empty'], warnings }
  }

  const csvRows = parseCsvRows(args.csvText)
  if (csvRows.length < 2) {
    return {
      ok: false,
      rows,
      errors: ['csv must have a header row and at least one data row'],
      warnings,
    }
  }

  const header = csvRows[0]
  const idx = indexColumns(header)
  if (idx.action < 0 || idx.visitor < 0 || idx.date < 0) {
    return {
      ok: false,
      rows,
      errors: [
        'Knot visitor-activity export is missing required column(s): ' +
        'need "Action Taken", "Visitor Name", and "Date of Visit". ' +
        'Re-export the file from your Knot dashboard.',
      ],
      warnings,
    }
  }

  // Dedup within the single upload — Knot sometimes emits the same row
  // twice when an action is logged from two devices in the same window.
  const seenFingerprints = new Set<string>()

  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]
    const get = (i: number): string | null => {
      if (i < 0) return null
      return (data[i] ?? '').trim() || null
    }

    const visitorName = get(idx.visitor)
    if (!visitorName) {
      warnings.push(`row ${r}: skipped — empty Visitor Name`)
      continue
    }

    const actionRaw = get(idx.action)
    const action = classifyKnotAction(actionRaw)
    if (!action) {
      warnings.push(`row ${r}: skipped — empty Action Taken`)
      continue
    }

    const dateRaw = get(idx.date)
    const actionAt = parseKnotDate(dateRaw)
    if (!actionAt) {
      warnings.push(`row ${r}: skipped — could not parse Date of Visit "${dateRaw ?? ''}"`)
      continue
    }

    const name = parseVisitorName(visitorName)
    const city = get(idx.city)
    const state = get(idx.state)

    const fingerprint = computeRowFingerprint({
      venueId: args.venueId,
      visitorName,
      actionTaken: action,
      actionAtIso: actionAt,
      city,
      state,
    })

    if (seenFingerprints.has(fingerprint)) {
      warnings.push(`row ${r}: in-file duplicate skipped`)
      continue
    }
    seenFingerprints.add(fingerprint)

    rows.push({
      visitor_name: visitorName,
      visitor_first_name: name.first_name,
      visitor_last_initial: name.last_initial,
      action_taken: action,
      action_at: actionAt,
      city,
      state,
      row_fingerprint: fingerprint,
    })
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push('no usable visitor-activity rows were found in the file')
  }
  return { ok: errors.length === 0, rows, errors, warnings }
}

// ---------------------------------------------------------------------------
// Commit — insert rows into knot_visitor_activity. Idempotent on
// row_fingerprint via the UNIQUE(venue_id, row_fingerprint) index.
// ---------------------------------------------------------------------------

export interface ImportResult {
  ok: boolean
  totalRows: number
  inserted: number
  skippedDuplicate: number
  parseErrors: string[]
  warnings: string[]
  importBatchId: string | null
  /** IDs of the rows that landed in this commit (or that already
   *  existed under the same fingerprint). Caller passes this to the
   *  matcher sweep. */
  insertedIds: string[]
  /** True when the operator-named canary case (Doug L.) appears in
   *  the batch — flagged so the post-import matcher run can highlight
   *  it. Per the operator's instruction 2026-05-27. */
  containsDougCanary: boolean
}

/**
 * Generate a v4-shaped UUID for the import_batch_id without pulling
 * a new dependency. Standard `crypto.randomUUID()` is available in
 * Node 18+ and Edge — both targets supported.
 */
function newBatchId(): string {
  // randomUUID is on the global crypto in Node 18+ and Edge runtimes.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  // Fallback (Node < 18) — should never hit in this codebase but
  // keeps the type narrow rather than throwing at import time.
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Commit a Knot visitor-activity CSV. Pre-parses + writes (with
 * idempotent upsert-on-conflict semantics via the UNIQUE constraint).
 * Returns a per-batch summary the operator UI renders verbatim.
 *
 * Pass `dryRun:true` to return what would be written without touching
 * the database. The matcher sweep is a separate call
 * (`matchKnotVisitorsToPeople`) — keep this commit step minimal so
 * a long match sweep can be retried independently of the import write.
 */
export async function importKnotVisitorActivityCsv(args: {
  venueId: string
  csvText: string
  supabase: SupabaseClient
  dryRun?: boolean
}): Promise<ImportResult> {
  const parsed = parseKnotVisitorActivityCsv({
    venueId: args.venueId,
    csvText: args.csvText,
  })

  const result: ImportResult = {
    ok: parsed.ok,
    totalRows: parsed.rows.length,
    inserted: 0,
    skippedDuplicate: 0,
    parseErrors: [...parsed.errors],
    warnings: [...parsed.warnings],
    importBatchId: null,
    insertedIds: [],
    containsDougCanary: parsed.rows.some(
      (r) =>
        r.visitor_first_name?.toLowerCase() === 'doug' &&
        r.visitor_last_initial?.toUpperCase() === 'L',
    ),
  }

  if (!parsed.ok || parsed.rows.length === 0) return result

  const batchId = newBatchId()
  result.importBatchId = batchId

  if (args.dryRun) {
    // Best-effort dedup peek — count how many of the proposed
    // fingerprints already exist so the operator sees the diff.
    const fingerprints = parsed.rows.map((r) => r.row_fingerprint)
    const { data: existing } = await args.supabase
      .from('knot_visitor_activity')
      .select('row_fingerprint')
      .eq('venue_id', args.venueId)
      .in('row_fingerprint', fingerprints)
    const existingSet = new Set((existing ?? []).map((r) => r.row_fingerprint as string))
    result.skippedDuplicate = parsed.rows.filter((r) => existingSet.has(r.row_fingerprint)).length
    result.inserted = parsed.rows.length - result.skippedDuplicate
    return result
  }

  // Bulk insert. ON CONFLICT (venue_id, row_fingerprint) DO NOTHING
  // via the dedicated UNIQUE constraint — supabase-js exposes this
  // through `.upsert({ onConflict, ignoreDuplicates: true })` and
  // returns the rows that were INSERTED (Postgres RETURNING semantics
  // skip the no-ops). The conflict skip is silent and correct: re-
  // upload of the same CSV must be a no-op.
  const rowsToInsert = parsed.rows.map((r) => ({
    venue_id: args.venueId,
    visitor_name: r.visitor_name,
    visitor_first_name: r.visitor_first_name,
    visitor_last_initial: r.visitor_last_initial,
    action_taken: r.action_taken,
    action_at: r.action_at,
    city: r.city,
    state: r.state,
    row_fingerprint: r.row_fingerprint,
    import_batch_id: batchId,
  }))

  // Chunk inserts so a 5,000-row historical backfill does not blow
  // a single statement (Postgres default limits + Vercel function
  // streaming windows).
  const CHUNK = 500
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const chunk = rowsToInsert.slice(i, i + CHUNK)
    const { data, error } = await args.supabase
      .from('knot_visitor_activity')
      .upsert(chunk, {
        onConflict: 'venue_id,row_fingerprint',
        ignoreDuplicates: true,
      })
      .select('id, row_fingerprint')
    if (error) {
      result.ok = false
      result.parseErrors.push(`insert chunk ${i / CHUNK}: ${error.message}`)
      continue
    }
    const insertedFingerprints = new Set((data ?? []).map((d) => d.row_fingerprint as string))
    result.inserted += insertedFingerprints.size
    result.skippedDuplicate += chunk.length - insertedFingerprints.size
    for (const d of data ?? []) {
      const id = (d as { id?: string }).id
      if (id) result.insertedIds.push(id)
    }
  }

  return result
}
