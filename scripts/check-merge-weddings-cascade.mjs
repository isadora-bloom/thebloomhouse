#!/usr/bin/env node
/**
 * Guard: mergeWeddings cascade list must match the schema.
 *
 * Step 8 / G7 (2026-05-13, bloom-identity-resolution-doctrine.md).
 *
 * Reads every FK column targeting weddings.id from pg_constraint (via
 * the _list_wedding_fk_columns RPC, migration 334) and diffs against
 * the hand-maintained reassign(...) list inside
 * src/lib/services/identity/resolver.ts mergeWeddings().
 *
 * Behaviour
 * ---------
 * - SCHEMA - HAND_LIST: schema has FK columns mergeWeddings doesn't
 *   reassign. Loud failure — a merge will orphan rows. Exit 1.
 *
 * - HAND_LIST - SCHEMA: mergeWeddings reassigns columns that no longer
 *   exist (table dropped or column renamed). Warning only — PostgREST
 *   returns rowcount=0 on a missing column, so this is wasted work but
 *   not incorrect. Exit 0 with a notice.
 *
 * - Tables covered by the migration-202 attach trigger
 *   (attribution_events / wedding_touchpoints / candidate_identities)
 *   are allow-listed: they live in the schema FK list but don't need
 *   an explicit reassign call because the trigger re-points them when
 *   the duplicate is tombstoned.
 *
 * Usage
 * -----
 *   node scripts/check-merge-weddings-cascade.mjs
 *
 * Exits 0 on success, 1 on drift. Wire into CI alongside
 * check-no-direct-wedding-insert.mjs.
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// -----------------------------------------------------------------------
// Env loader — mirrors check-mig-283.mjs / inspect-couple-identity-profile.mjs
// -----------------------------------------------------------------------
const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[m[1]] = v
}
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(2)
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// -----------------------------------------------------------------------
// Allow-list: covered by migration-202 attach trigger on weddings.merged_into_id
// -----------------------------------------------------------------------
const TRIGGER_COVERED = new Set([
  'attribution_events',
  'wedding_touchpoints',
  'candidate_identities',
])

// -----------------------------------------------------------------------
// Parse the hand-list out of resolver.ts mergeWeddings.
// Looks for `await reassign('table'[, 'column'])` between `function mergeWeddings`
// and the next `export async function` / `function ` at column 0.
// -----------------------------------------------------------------------
function parseHandList() {
  const path = 'src/lib/services/identity/resolver.ts'
  const src = readFileSync(path, 'utf8')
  const start = src.indexOf('export async function mergeWeddings')
  if (start < 0) {
    console.error(`could not find mergeWeddings in ${path}`)
    process.exit(2)
  }
  // Find function body end: closing brace of mergeWeddings. Cheap heuristic:
  // next `\nexport ` or `\n}` at indent 0 that follows a `return ` block.
  const tail = src.slice(start)
  const endMarker = tail.search(/\n\}\s*\n(?:export |\/\*|\/\/|$)/)
  const body = endMarker > 0 ? tail.slice(0, endMarker) : tail

  const out = new Set()
  const re = /await\s+reassign\(\s*['"]([a-zA-Z0-9_]+)['"]/g
  for (const m of body.matchAll(re)) {
    out.add(m[1])
  }
  return out
}

// -----------------------------------------------------------------------
// Pull FK list from pg_constraint via RPC.
// -----------------------------------------------------------------------
async function fetchSchemaList() {
  const { data, error } = await sb.rpc('_list_wedding_fk_columns')
  if (error) {
    console.error('rpc _list_wedding_fk_columns failed:', error.message)
    console.error('  migration 334 may not be applied. Apply')
    console.error('  supabase/migrations/334_list_wedding_fk_columns.sql in Studio.')
    process.exit(2)
  }
  if (!Array.isArray(data)) {
    console.error('unexpected rpc shape:', typeof data)
    process.exit(2)
  }
  return data // [{ table_name, column_name }]
}

// -----------------------------------------------------------------------
// Diff + report
// -----------------------------------------------------------------------
async function main() {
  const handList = parseHandList()
  const schemaRows = await fetchSchemaList()

  // Group schema rows: table -> Set(columns)
  const schemaByTable = new Map()
  for (const { table_name, column_name } of schemaRows) {
    if (!schemaByTable.has(table_name)) schemaByTable.set(table_name, new Set())
    schemaByTable.get(table_name).add(column_name)
  }

  // Missing from hand-list (schema says FK exists, mergeWeddings doesn't reassign).
  const missing = []
  for (const [table, cols] of schemaByTable.entries()) {
    if (TRIGGER_COVERED.has(table)) continue
    if (cols.has('wedding_id') && !handList.has(table)) {
      missing.push(table)
    }
  }

  // Stale entries (hand-list mentions a table not in schema).
  const stale = []
  for (const table of handList) {
    if (!schemaByTable.has(table)) stale.push(table)
  }

  // Report.
  console.log(`mergeWeddings hand-list: ${handList.size} tables`)
  console.log(`schema FK columns:        ${schemaRows.length} rows across ${schemaByTable.size} tables`)
  console.log(`trigger-covered (skipped): ${[...TRIGGER_COVERED].join(', ')}`)
  console.log('')

  if (missing.length > 0) {
    console.error(`✗ DRIFT: ${missing.length} table(s) have wedding_id FK but mergeWeddings does NOT reassign:`)
    for (const t of missing) console.error(`    - ${t}`)
    console.error('')
    console.error('  Fix: add `await reassign(\'<table>\')` to mergeWeddings in')
    console.error('  src/lib/services/identity/resolver.ts, OR if the table is')
    console.error('  covered by an attach trigger, add it to TRIGGER_COVERED here.')
    if (stale.length > 0) {
      console.error('')
      console.error(`  (Also: ${stale.length} stale entries in hand-list: ${stale.join(', ')})`)
    }
    process.exit(1)
  }

  if (stale.length > 0) {
    console.warn(`⚠  ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} in hand-list (table no longer exists):`)
    for (const t of stale) console.warn(`    - ${t}`)
    console.warn('  Not a failure: PostgREST returns rowcount=0 on missing tables.')
    console.warn('  Remove from mergeWeddings to keep the file accurate.')
  }

  console.log('✓ mergeWeddings cascade list matches schema')
}

main().catch((err) => {
  console.error('check-merge-weddings-cascade crashed:', err?.message ?? err)
  process.exit(2)
})
