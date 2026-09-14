#!/usr/bin/env node
/**
 * Guard: the generated cascade file matches the live schema.
 *
 * Step 8 / G7 (2026-05-13, bloom-identity-resolution-doctrine.md),
 * rewritten by W60 (2026-09-14).
 *
 * What changed and why
 * --------------------
 * This guard used to parse a hand-written list of reassign('table') calls
 * out of mergeWeddings and diff it against pg_constraint. The hand-list
 * lost: 35 tables listed, nine of them long dropped, and 75 tables with a
 * wedding_id foreign key that no merge ever touched. mergeWeddings now
 * iterates src/lib/services/identity/wedding-fk-tables.generated.json,
 * written from the live schema by scripts/gen-wedding-fk-tables.ts, so
 * this guard's job is the one diff that still matters: does the committed
 * file still describe the database?
 *
 * Sources, both read-only:
 *   - rpc('_list_wedding_fk_columns')  (migration 334) for FK columns
 *   - GET /rest/v1/  (the PostgREST OpenAPI document) for every relation
 *     with a wedding_id column, FK or not
 *
 * Behaviour
 * ---------
 *   - in the schema, missing from the file: a merge would orphan those
 *     rows. Exit 1.
 *   - in the file, gone from the schema: stale. Warning, exit 0 — a
 *     PostgREST update against a missing table is a no-op, so it costs a
 *     wasted request, not correctness.
 *   - in the file with a `pending_migration` and absent live: expected,
 *     not drift. The migration is written but not applied to this
 *     database; the merge skips the table and records the skip. Reported
 *     so the gap is visible. The reverse (pending, but the table is live
 *     now) is a nudge to regenerate.
 *   - the file's per-table strategies are reported so a human reading CI
 *     output can see what a merge will actually do.
 *
 * Usage
 * -----
 *   node scripts/check-merge-weddings-cascade.mjs
 *
 * Needs .env.local, so it is NOT in CI. The CI-safe half is
 * scripts/check-wedding-fk-tables-fresh.mjs.
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const GENERATED = 'src/lib/services/identity/wedding-fk-tables.generated.json'

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

/**
 * Close the HTTP keep-alive sockets and the realtime client before the
 * process ends, then let node exit on its own.
 *
 * Why: calling process.exit() while undici still holds a TLS socket
 * aborted this script on Windows with
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
 * after it had already printed its verdict — a green run that looked like
 * a crash. Setting exitCode and returning avoids tearing libuv handles
 * down underneath themselves.
 */
async function finish(code) {
  try {
    sb.realtime?.disconnect?.()
  } catch {
    // no realtime connection was opened; nothing to close
  }
  try {
    const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')]
    if (dispatcher?.close) await dispatcher.close()
  } catch {
    // older runtime without the global dispatcher symbol
  }
  process.exitCode = code
}

// -----------------------------------------------------------------------
// Live schema
// -----------------------------------------------------------------------
async function fetchFkColumns() {
  const { data, error } = await sb.rpc('_list_wedding_fk_columns')
  if (error) {
    console.error('rpc _list_wedding_fk_columns failed:', error.message)
    console.error('  migration 334 may not be applied. Apply')
    console.error('  supabase/migrations/334_list_wedding_fk_columns.sql in Studio.')
    return null
  }
  if (!Array.isArray(data)) {
    console.error('unexpected rpc shape:', typeof data)
    return null
  }
  return data // [{ table_name, column_name }]
}

async function fetchWeddingIdRelations() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  if (!res.ok) {
    console.error('OpenAPI fetch failed:', res.status)
    return null
  }
  const doc = await res.json()
  const out = []
  for (const [name, def] of Object.entries(doc.definitions ?? {})) {
    if (def?.properties?.wedding_id) out.push(name)
  }
  return out
}

// -----------------------------------------------------------------------
// Diff + report
// -----------------------------------------------------------------------
async function main() {
  let doc
  try {
    doc = JSON.parse(readFileSync(GENERATED, 'utf8'))
  } catch (err) {
    console.error(`cannot read ${GENERATED}: ${err.message}`)
    console.error('  Generate it: npx tsx scripts/gen-wedding-fk-tables.ts')
    return finish(2)
  }
  const fileKeys = new Set((doc.tables ?? []).map((t) => `${t.table}.${t.column}`))

  const fkRows = await fetchFkColumns()
  if (!fkRows) return finish(2)
  const relations = await fetchWeddingIdRelations()
  if (!relations) return finish(2)

  const schemaKeys = new Set()
  for (const { table_name, column_name } of fkRows) schemaKeys.add(`${table_name}.${column_name}`)
  for (const t of relations) schemaKeys.add(`${t}.wedding_id`)

  // A pending entry describes a migration on disk that this database has
  // not had applied yet. Absent live is the expected state for one, so it
  // is reported, not counted as stale. The reverse — pending but present —
  // means the migration landed and the file wants regenerating.
  const pendingByKey = new Map()
  for (const t of doc.tables ?? []) {
    if (t.pending_migration) pendingByKey.set(`${t.table}.${t.column}`, t.pending_migration)
  }

  const missing = [...schemaKeys].filter((k) => !fileKeys.has(k)).sort()
  const stale = [...fileKeys].filter((k) => !schemaKeys.has(k) && !pendingByKey.has(k)).sort()
  const pendingWaiting = [...pendingByKey.keys()].filter((k) => !schemaKeys.has(k)).sort()
  const pendingLanded = [...pendingByKey.keys()].filter((k) => schemaKeys.has(k)).sort()

  const counts = {}
  for (const t of doc.tables ?? []) counts[t.strategy] = (counts[t.strategy] ?? 0) + 1

  console.log(`generated file:   ${fileKeys.size} wedding-keyed columns (watermark migration ${doc.migration_watermark})`)
  console.log(`live schema:      ${schemaKeys.size} wedding-keyed columns`)
  for (const [s, n] of Object.entries(counts).sort()) console.log(`  ${s.padEnd(22)} ${n}`)
  if (pendingWaiting.length > 0) {
    console.log('')
    console.log(`${pendingWaiting.length} pending, waiting on a migration this database has not had applied:`)
    for (const k of pendingWaiting) console.log(`    - ${k.padEnd(40)} ${pendingByKey.get(k)}`)
    console.log('  Expected, not drift. The merge skips them and records the skip.')
  }
  console.log('')

  if (missing.length > 0) {
    console.error(`✗ DRIFT: ${missing.length} wedding-keyed column(s) in the schema are NOT in the cascade file:`)
    for (const k of missing) console.error(`    - ${k}`)
    console.error('')
    console.error('  A merge leaves those rows on the losing wedding.')
    console.error('  Fix: npx tsx scripts/gen-wedding-fk-tables.ts   (then commit the file)')
    if (stale.length > 0) {
      console.error('')
      console.error(`  (Also ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}: ${stale.join(', ')})`)
    }
    return finish(1)
  }

  if (stale.length > 0) {
    console.warn(`⚠  ${stale.length} entr${stale.length === 1 ? 'y' : 'ies'} in the file that the schema no longer has:`)
    for (const k of stale) console.warn(`    - ${k}`)
    console.warn('  Not a failure: an update against a missing table is a no-op.')
    console.warn('  Regenerate to tidy: npx tsx scripts/gen-wedding-fk-tables.ts')
  }

  if (pendingLanded.length > 0) {
    console.warn(`⚠  ${pendingLanded.length} pending entr${pendingLanded.length === 1 ? 'y is' : 'ies are'} now live:`)
    for (const k of pendingLanded) console.warn(`    - ${k.padEnd(40)} ${pendingByKey.get(k)}`)
    console.warn('  The migration landed. Regenerate so the strategy comes from the schema:')
    console.warn('  npx tsx scripts/gen-wedding-fk-tables.ts')
  }

  console.log('✓ cascade file matches the live schema')
  return finish(0)
}

main().catch(async (err) => {
  console.error('check-merge-weddings-cascade crashed:', err?.message ?? err)
  await finish(2)
})
