/**
 * Generate src/lib/services/identity/wedding-fk-tables.generated.json.
 *
 * W60 (2026-09-14). Replaces the hand-written cascade list inside
 * mergeWeddings, which had drifted badly: 35 hand-listed tables, nine of
 * them pointing at tables that no longer exist, and 75 tables with a
 * wedding_id foreign key that no merge ever touched. Every one of those
 * 75 kept its rows on the losing wedding after a merge.
 *
 * A hand-list cannot be kept honest. This script asks the database
 * instead, and mergeWeddings iterates what it writes.
 *
 * READ ONLY. Two reads, no writes:
 *   1. rpc('_list_wedding_fk_columns')  — migration 334. Every FK column
 *      in schema public that targets weddings.id.
 *   2. GET /rest/v1/  — the PostgREST OpenAPI document. Gives every
 *      exposed relation, its columns, its primary key, and whether it
 *      accepts a PATCH (a view does not, so a view must never be part of
 *      the cascade).
 * Unique constraints are not in either source, so they come from a scan
 * of supabase/migrations/*.sql — the same approach
 * scripts/check-on-conflict-constraints.mjs already uses.
 *
 * The same scan also catches the third case: a migration on disk that adds
 * a wedding_id column and has not been applied to this database yet. The
 * live schema cannot show it, but the table is a commitment the moment the
 * migration is written, so it goes in the file marked pending_migration and
 * mergeWeddings skips it cleanly until it lands.
 *
 * Usage
 * -----
 *   npx tsx scripts/gen-wedding-fk-tables.ts            # writes the file
 *   npx tsx scripts/gen-wedding-fk-tables.ts --print    # stdout only
 *   npx tsx scripts/gen-wedding-fk-tables.ts --out <p>  # somewhere else
 *
 * Connection: .env.local, same loader as
 * scripts/check-merge-weddings-cascade.mjs. That file points at
 * production, which is safe here because nothing below writes.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const OUT_DEFAULT = 'src/lib/services/identity/wedding-fk-tables.generated.json'
const MIGRATION_DIR = 'supabase/migrations'

// ---------------------------------------------------------------------------
// Strategy vocabulary. Every table gets exactly one, with a reason.
// ---------------------------------------------------------------------------
export type MergeStrategy =
  /** Plain UPDATE table SET <column> = winner WHERE <column> = loser. */
  | 'reassign'
  /**
   * The table holds at most one row per wedding (a unique constraint on
   * wedding_id alone, or on wedding_id plus a key). The winner's row
   * wins; a loser row moves only where the winner has no row on the same
   * key. A loser row that would collide stays where it is and is named in
   * the merge audit, so it is never silently dropped.
   */
  | 'merge_one_per_wedding'
  /** Migration 202's attach trigger re-points these on the tombstone. */
  | 'trigger_covered'
  /** `_archived_*`: frozen snapshots. Recorded, never touched. */
  | 'skip_archived'
  /** A view has no rows of its own. */
  | 'skip_view'
  /** A record of a past merge or recovery. Rewriting it falsifies history. */
  | 'skip_history'
  /** weddings' own self-referencing columns. The tombstone owns those. */
  | 'skip_self_reference'

export interface WeddingFkTable {
  table: string
  column: string
  strategy: MergeStrategy
  reason: string
  /** Primary key column, when the relation has a single-column one. */
  pk: string | null
  /** Non-wedding columns of the unique key, for collision detection. */
  key_columns?: string[]
  /** Where the unique constraint came from. */
  unique_source?: string
  /** A partial unique index only bites inside its predicate. */
  unique_partial?: boolean
  /** false when the column has no declared FK (kept for completeness). */
  has_fk: boolean
  /**
   * Set when the column exists only in a migration on disk that has not
   * been applied to the database this file was generated from. The table
   * is in the cascade from the day the migration is written, and
   * mergeWeddings skips it cleanly (PGRST205) until it is applied.
   */
  pending_migration?: string
}

// Migration 202: the attach trigger on weddings.merged_into_id re-points
// these three on the NULL -> non-NULL transition, so the merge must not
// also move them by hand (it would double-count, and the trigger's
// reverted_at / deleted_at filters are deliberate).
const TRIGGER_COVERED: ReadonlyArray<[string, string]> = [
  ['attribution_events', 'wedding_id'],
  ['wedding_touchpoints', 'wedding_id'],
  ['candidate_identities', 'resolved_wedding_id'],
]

// Rows that record a past merge or a past recovery. The wedding ids in
// them are the subject of the record, not an owner pointer: rewriting
// them would make the audit trail lie about what happened.
const HISTORY_COLUMNS: ReadonlyArray<[string, string]> = [
  ['merge_reattachment_log', 'loser_wedding_id'],
  ['merge_reattachment_log', 'winner_wedding_id'],
  ['booked_data_recovery_log', 'wedding_id'],
  ['booked_data_recovery_log', 'duplicate_wedding_id'],
]

// Unique keys the migration scan cannot find, because the column is not
// called wedding_id. couples has a unique index on
// (venue_id, source_wedding_id) from migration 346, and one mirror couple
// per wedding is the invariant mirror-couple.ts relies on. When the winner
// already has a mirror couple, the right repair is merge_couples
// (migration 379), not a column rewrite.
const CONVENTION_UNIQUE: Record<string, { key: string[]; source: string }> = {
  'couples.source_wedding_id': {
    key: ['venue_id'],
    source: '346_identity_first_phase_a.sql (unique on venue_id, source_wedding_id)',
  },
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    let v = m[2]!
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    env[m[1]!] = v
  }
  return env
}

// ---------------------------------------------------------------------------
// Source 1: FK columns targeting weddings.id (migration 334).
// ---------------------------------------------------------------------------
interface FkRow {
  table_name: string
  column_name: string
}

// ---------------------------------------------------------------------------
// Source 2: the PostgREST OpenAPI document.
// ---------------------------------------------------------------------------
interface OpenApiRelation {
  columns: string[]
  pk: string | null
  updatable: boolean
}

function parseOpenApi(doc: {
  definitions?: Record<string, { properties?: Record<string, { description?: string }> }>
  paths?: Record<string, Record<string, unknown>>
}): Map<string, OpenApiRelation> {
  const out = new Map<string, OpenApiRelation>()
  for (const [name, def] of Object.entries(doc.definitions ?? {})) {
    const props = def.properties ?? {}
    const pk =
      Object.entries(props).find(([, v]) => /Primary Key/i.test(v.description ?? ''))?.[0] ?? null
    const verbs = Object.keys(doc.paths?.[`/${name}`] ?? {})
    out.set(name, {
      columns: Object.keys(props),
      pk,
      updatable: verbs.includes('patch'),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Source 3: unique constraints mentioning wedding_id, from the migrations.
// ---------------------------------------------------------------------------
interface UniqueHit {
  table: string
  cols: string[]
  source: string
  partial: boolean
}

function scanUniqueConstraints(): Map<string, UniqueHit> {
  // Later migrations win: the newest definition of a table's unique key is
  // the one in force.
  const out = new Map<string, UniqueHit>()
  const files = readdirSync(MIGRATION_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const record = (table: string, cols: string[], source: string, partial: boolean) => {
    if (!cols.includes('wedding_id')) return
    out.set(table, { table, cols, source, partial })
  }
  for (const f of files) {
    const sql = readFileSync(join(MIGRATION_DIR, f), 'utf8')

    const idxRe =
      /create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?[a-z0-9_]+\s+on\s+(?:public\.)?([a-z0-9_]+)\s*\(([^)]*)\)([^;]*)/gi
    for (const m of sql.matchAll(idxRe)) {
      record(m[1]!.toLowerCase(), splitCols(m[2]!), f, /\bwhere\b/i.test(m[3] ?? ''))
    }

    const conRe =
      /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z0-9_]+)[\s\S]{0,80}?add\s+constraint\s+[a-z0-9_]+\s+unique\s*\(([^)]*)\)/gi
    for (const m of sql.matchAll(conRe)) {
      record(m[1]!.toLowerCase(), splitCols(m[2]!), f, false)
    }

    const ctRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\n\)\s*;/gi
    for (const m of sql.matchAll(ctRe)) {
      const table = m[1]!.toLowerCase()
      const body = m[2]!
      for (const u of body.matchAll(/\bunique\s*\(([^)]*)\)/gi)) {
        record(table, splitCols(u[1]!), f, false)
      }
      if (/^\s*wedding_id\s+[a-z0-9_ ]*\bunique\b/im.test(body)) {
        record(table, ['wedding_id'], f, false)
      }
    }
  }
  return out
}

/**
 * Views defined anywhere in the migrations. PostgREST offers PATCH on a
 * simple auto-updatable view, so "does it accept a PATCH" is not enough
 * on its own — and an UPDATE through a view writes the base table, which
 * during a merge would double-move rows the trigger already handles.
 */
function scanViews(): Set<string> {
  const out = new Set<string>()
  for (const f of readdirSync(MIGRATION_DIR).filter((n) => n.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATION_DIR, f), 'utf8')
    const re = /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi
    for (const m of sql.matchAll(re)) out.add(m[1]!.toLowerCase())
  }
  return out
}

function splitCols(raw: string): string[] {
  return raw
    .split(',')
    .map((c) => c.trim().replace(/"/g, '').split(/\s/)[0]!.toLowerCase())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Source 4: migrations on disk that add a wedding_id column but have not
// reached the database yet.
//
// Why this exists: the generator reads the live schema, so a migration
// written today and applied next week is invisible to it — and the file
// would then be silently short a table for as long as that gap lasts
// (found 2026-09-14: W50's 406_commitment_reconciliation). A migration on
// disk is a commitment, so it belongs in the cascade from the day it is
// written, marked pending until it lands.
//
// The hard part is telling "not applied yet" from "created years ago and
// long since dropped" — both are "on disk, missing live". Two signals,
// and a table must pass both:
//   - it is introduced by a migration numbered ABOVE the live watermark
//     (the newest migration that introduces a wedding_id table which does
//     exist live), so anything older that has gone missing is history
//   - no migration on disk drops it
// Anything that fails only the first test is reported as a note, never as
// a silent omission.
// ---------------------------------------------------------------------------
interface IntroducedColumn {
  table: string
  file: string
  n: number
  hasFk: boolean
  pk: string | null
}

function scanIntroducedWeddingIdColumns(): Map<string, IntroducedColumn> {
  const out = new Map<string, IntroducedColumn>()
  const files = readdirSync(MIGRATION_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) {
    const n = Number((f.match(/^(\d+)_/) ?? [])[1] ?? NaN)
    if (!Number.isFinite(n)) continue
    const sql = readFileSync(join(MIGRATION_DIR, f), 'utf8')

    const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\n\)\s*;/gi
    for (const m of sql.matchAll(createTable)) {
      const table = m[1]!.toLowerCase()
      const body = m[2]!
      const line = body.split('\n').find((l) => /^\s*wedding_id\b/i.test(l))
      if (!line) continue
      if (out.has(table)) continue
      const pkLine = body.split('\n').find((l) => /\bprimary\s+key\b/i.test(l) && /^\s*[a-z0-9_]+\s/i.test(l))
      const pk = pkLine ? (pkLine.trim().split(/\s/)[0] ?? null) : null
      out.set(table, { table, file: f, n, hasFk: /references/i.test(line), pk })
    }

    const addColumn =
      /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z0-9_]+)([\s\S]{0,160}?)add\s+column\s+(?:if\s+not\s+exists\s+)?wedding_id\b([^;,\n]*)/gi
    for (const m of sql.matchAll(addColumn)) {
      const table = m[1]!.toLowerCase()
      if (out.has(table)) continue
      out.set(table, { table, file: f, n, hasFk: /references/i.test(m[3] ?? ''), pk: 'id' })
    }
  }
  return out
}

function scanDroppedTables(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of readdirSync(MIGRATION_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATION_DIR, f), 'utf8')
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi)) {
      out.set(m[1]!.toLowerCase(), f)
    }
  }
  return out
}

function migrationWatermark(): number {
  let max = 0
  for (const f of readdirSync(MIGRATION_DIR)) {
    const m = f.match(/^(\d+)_/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
function classify(
  table: string,
  column: string,
  rel: OpenApiRelation | undefined,
  uniques: Map<string, UniqueHit>,
  views: Set<string>,
  hasFk: boolean,
): WeddingFkTable {
  const pk = rel?.pk ?? null
  const base: Omit<WeddingFkTable, 'strategy' | 'reason'> = { table, column, pk, has_fk: hasFk }

  if (views.has(table) || (rel && !rel.updatable)) {
    return { ...base, strategy: 'skip_view', reason: 'a view, it has no rows of its own' }
  }
  if (table.startsWith('_archived')) {
    return { ...base, strategy: 'skip_archived', reason: 'frozen pre-wipe snapshot, recorded but never rewritten' }
  }
  if (table === 'weddings') {
    return {
      ...base,
      strategy: 'skip_self_reference',
      reason: 'weddings points at itself here; the tombstone UPDATE owns merged_into_id',
    }
  }
  if (TRIGGER_COVERED.some(([t, c]) => t === table && c === column)) {
    return {
      ...base,
      strategy: 'trigger_covered',
      reason: 'migration 202 attach trigger re-points this on the tombstone UPDATE',
    }
  }
  if (HISTORY_COLUMNS.some(([t, c]) => t === table && c === column)) {
    return {
      ...base,
      strategy: 'skip_history',
      reason: 'a record of a past merge or recovery; rewriting it would falsify the audit trail',
    }
  }

  const convention = CONVENTION_UNIQUE[`${table}.${column}`]
  if (convention) {
    return {
      ...base,
      strategy: 'merge_one_per_wedding',
      reason: 'one row per wedding; a second row on the winner needs a spine merge, not a column rewrite',
      key_columns: convention.key,
      unique_source: convention.source,
      unique_partial: false,
    }
  }

  const uniq = column === 'wedding_id' ? uniques.get(table) : undefined
  if (uniq && pk) {
    return {
      ...base,
      strategy: 'merge_one_per_wedding',
      reason:
        `${uniq.partial ? 'partial unique' : 'unique'} on (${uniq.cols.join(', ')}), ` +
        "so the winner's row wins and a colliding loser row stays put and is audited",
      key_columns: uniq.cols.filter((c) => c !== 'wedding_id'),
      unique_source: uniq.source,
      unique_partial: uniq.partial,
    }
  }
  if (uniq && !pk) {
    return {
      ...base,
      strategy: 'reassign',
      reason: `unique on (${uniq.cols.join(', ')}) but no single-column primary key to move rows by, so a collision can only be reported, not worked around`,
    }
  }

  return { ...base, strategy: 'reassign', reason: 'plain owner column, every row follows the wedding' }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)
  const printOnly = args.includes('--print')
  const outIdx = args.indexOf('--out')
  const out = outIdx > -1 ? args[outIdx + 1]! : OUT_DEFAULT

  const env = loadEnv()
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(2)
  }

  const sb = createClient(url, key, { auth: { persistSession: false } })
  const { data, error } = await sb.rpc('_list_wedding_fk_columns')
  if (error) {
    console.error('rpc _list_wedding_fk_columns failed:', error.message)
    console.error('  migration 334 may not be applied.')
    process.exit(2)
  }
  const fkRows = (data ?? []) as FkRow[]

  const oaRes = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  if (!oaRes.ok) {
    console.error('OpenAPI fetch failed:', oaRes.status)
    process.exit(2)
  }
  const relations = parseOpenApi(await oaRes.json())
  const uniques = scanUniqueConstraints()
  const views = scanViews()

  // Union: every FK column targeting weddings.id, plus every relation with
  // a wedding_id column that has no declared FK (views, and any table that
  // lost its constraint). Neither source alone is complete.
  const seen = new Set<string>()
  const rows: WeddingFkTable[] = []
  const push = (table: string, column: string, hasFk: boolean) => {
    const k = `${table}.${column}`
    if (seen.has(k)) return
    seen.add(k)
    rows.push(classify(table, column, relations.get(table), uniques, views, hasFk))
  }
  for (const r of fkRows) push(r.table_name, r.column_name, true)
  for (const [name, rel] of relations) {
    if (rel.columns.includes('wedding_id')) push(name, 'wedding_id', false)
  }

  // Pending: on disk, not in the database yet. See the section header above
  // for how "not applied yet" is told apart from "dropped long ago".
  const introduced = scanIntroducedWeddingIdColumns()
  const dropped = scanDroppedTables()
  const liveTables = new Set(rows.filter((r) => r.column === 'wedding_id').map((r) => r.table))
  let liveWatermark = 0
  for (const info of introduced.values()) {
    if (liveTables.has(info.table)) liveWatermark = Math.max(liveWatermark, info.n)
  }
  const pending: WeddingFkTable[] = []
  const notes: string[] = []
  for (const info of [...introduced.values()].sort((a, b) => a.n - b.n)) {
    if (liveTables.has(info.table)) continue
    const dropFile = dropped.get(info.table)
    if (dropFile) continue // dropped on disk; history, not a gap
    if (info.n <= liveWatermark) {
      notes.push(
        `${info.table} (${info.file}) is gone from the live schema with no DROP on disk; ` +
          'older than the live watermark, so treated as history, not as pending',
      )
      continue
    }
    const uniq = uniques.get(info.table)
    const entry: WeddingFkTable = uniq
      ? {
          table: info.table,
          column: 'wedding_id',
          strategy: 'merge_one_per_wedding',
          reason:
            `not applied to this database yet (${info.file}); ` +
            `${uniq.partial ? 'partial unique' : 'unique'} on (${uniq.cols.join(', ')}), ` +
            "so the winner's row wins and a colliding loser row stays put and is audited",
          pk: info.pk,
          key_columns: uniq.cols.filter((c) => c !== 'wedding_id'),
          unique_source: uniq.source,
          unique_partial: uniq.partial,
          has_fk: info.hasFk,
          pending_migration: info.file,
        }
      : {
          table: info.table,
          column: 'wedding_id',
          strategy: 'reassign',
          reason: `not applied to this database yet (${info.file}); plain owner column, every row follows the wedding`,
          pk: info.pk,
          has_fk: info.hasFk,
          pending_migration: info.file,
        }
    pending.push(entry)
    rows.push(entry)
  }

  rows.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column))

  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.strategy] = (counts[r.strategy] ?? 0) + 1

  const doc = {
    $comment:
      'GENERATED by scripts/gen-wedding-fk-tables.ts from the live schema, plus any migration on ' +
      'disk that adds a wedding_id column and has not been applied yet (pending_migration). ' +
      'Do not hand-edit. mergeWeddings (src/lib/services/identity/resolver.ts) iterates this file; ' +
      'scripts/check-merge-weddings-cascade.mjs diffs it against the database and ' +
      'scripts/check-wedding-fk-tables-fresh.mjs fails CI when a newer migration adds a wedding_id column.',
    generated_at: new Date().toISOString().slice(0, 10),
    generator: 'scripts/gen-wedding-fk-tables.ts',
    /** Newest migration on disk when this ran. The freshness guard's line. */
    migration_watermark: migrationWatermark(),
    /** Newest migration introducing a wedding_id table that the database has. */
    live_watermark: liveWatermark,
    pending_count: pending.length,
    notes,
    counts,
    tables: rows,
  }

  const json = JSON.stringify(doc, null, 2) + '\n'
  if (printOnly) {
    console.log(json)
  } else {
    writeFileSync(out, json)
    console.log(`wrote ${out}`)
  }
  console.log(
    `${rows.length} wedding-keyed columns; watermark migration ${doc.migration_watermark}, ` +
      `live watermark ${liveWatermark}`,
  )
  for (const [s, n] of Object.entries(counts).sort()) console.log(`  ${s.padEnd(22)} ${n}`)
  if (pending.length > 0) {
    console.log(`\n${pending.length} pending (on disk, not in this database yet):`)
    for (const p of pending) console.log(`  ${p.table.padEnd(34)} ${p.strategy.padEnd(22)} ${p.pending_migration}`)
  }
  for (const n of notes) console.log(`note: ${n}`)
}

main().catch((err) => {
  console.error('gen-wedding-fk-tables crashed:', err instanceof Error ? err.message : err)
  process.exit(2)
})
