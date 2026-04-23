// Apply-migrations: reconcile local supabase/migrations/*.sql with the
// actual schema state on prod, then apply any that are missing.
//
// Why not `supabase db push`: the local supabase_migrations.schema_migrations
// tracking table on this project is empty (migrations have historically
// been applied via the Supabase SQL editor, which doesn't update the
// tracking table). `db push` would try to re-run every migration against
// a DB that already has them, which fails noisily or silently corrupts
// depending on IF-NOT-EXISTS guards.
//
// Instead, this script:
//   1. Parses each local migration for the tables + columns it is
//      intended to add (CREATE TABLE / ADD COLUMN). That's a coarse
//      signal but catches the common cases (86/87/88 all fit).
//   2. Probes prod to see which of those artifacts actually exist.
//   3. Tags each migration as applied / missing / partial / indeterminate.
//   4. With --apply: runs `supabase db query --linked --file <path>` on
//      each missing migration in order, then re-probes to confirm.
//
// Usage:
//   node scripts/apply-migrations.mjs            # report only
//   node scripts/apply-migrations.mjs --apply    # apply the missing ones
//   node scripts/apply-migrations.mjs --since 080   # limit to 080+
//   node scripts/apply-migrations.mjs --file 088_match_queue_signal_pairs.sql  # one file
import { createClient } from '@supabase/supabase-js'
import { readFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const MIGRATIONS_DIR = 'supabase/migrations'
const APPLY = process.argv.includes('--apply')
const SINCE = argValue('--since') // e.g. "080" to skip anything before
const ONE_FILE = argValue('--file') // apply just one migration

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}

// ---------------------------------------------------------------------------
// Parse a migration file for artifacts we can probe
//
// Handles:
//   CREATE TABLE [IF NOT EXISTS] [public.]name (...)   → expect table
//   ALTER TABLE [public.]name ADD COLUMN [IF NOT EXISTS] col ...  → expect column
//
// Ignores CREATE POLICY / CREATE INDEX / CREATE TRIGGER / CREATE FUNCTION —
// those aren't probeable via Supabase REST and are rare enough that a
// per-migration probe list can be added manually if needed.
// ---------------------------------------------------------------------------
function parseArtifacts(sql) {
  const artifacts = []
  const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi
  for (const m of sql.matchAll(createTableRe)) {
    artifacts.push({ kind: 'table', table: m[1] })
  }
  // ALTER TABLE ... ADD COLUMN supports a comma-joined list in one
  // statement; match each ADD COLUMN separately.
  const alterRe = /ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)([\s\S]*?);/gi
  for (const m of sql.matchAll(alterRe)) {
    const table = m[1]
    const body = m[2]
    const colRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s/gi
    for (const c of body.matchAll(colRe)) {
      artifacts.push({ kind: 'column', table, column: c[1] })
    }
  }
  return artifacts
}

// ---------------------------------------------------------------------------
// Probe artifacts against prod via the Supabase REST endpoint
// ---------------------------------------------------------------------------
async function probeArtifact(a) {
  if (a.kind === 'table') {
    const { error } = await sb.from(a.table).select('*').limit(1)
    if (!error) return { ok: true }
    if (error.code === 'PGRST205') return { ok: false, reason: 'table missing' }
    return { ok: true, reason: `probe noise: ${error.message.slice(0, 60)}` } // assume applied
  }
  const { error } = await sb.from(a.table).select(a.column).limit(1)
  if (!error) return { ok: true }
  if (/column "?[^"]+"? does not exist/i.test(error.message)) return { ok: false, reason: 'column missing' }
  if (error.code === 'PGRST205') return { ok: false, reason: 'table missing' }
  return { ok: true, reason: `probe noise: ${error.message.slice(0, 60)}` }
}

// ---------------------------------------------------------------------------
// Status for one migration: applied / missing / partial / indeterminate
// ---------------------------------------------------------------------------
async function statusOf(file) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
  const artifacts = parseArtifacts(sql)
  if (artifacts.length === 0) {
    return { file, status: 'indeterminate', detail: 'no CREATE TABLE / ADD COLUMN found — cannot probe' }
  }
  const results = await Promise.all(artifacts.map(probeArtifact))
  const missing = results.filter((r) => !r.ok).length
  const total = results.length
  if (missing === 0) return { file, status: 'applied', detail: `${total}/${total} artifacts present` }
  if (missing === total) return { file, status: 'missing', detail: `0/${total} artifacts present` }
  return { file, status: 'partial', detail: `${total - missing}/${total} artifacts present` }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const allFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
const files = ONE_FILE
  ? [ONE_FILE]
  : SINCE
    ? allFiles.filter((f) => f.slice(0, 3) >= SINCE)
    : allFiles

console.log(`\nProbing ${files.length} migration file(s)…\n`)

const statuses = []
for (const file of files) {
  const s = await statusOf(file)
  statuses.push(s)
  const icon = s.status === 'applied' ? '✓' : s.status === 'missing' ? '✗' : s.status === 'partial' ? '~' : '?'
  console.log(`  ${icon} ${file.padEnd(50)} ${s.status.padEnd(14)} ${s.detail}`)
}

const toApply = statuses.filter((s) => s.status === 'missing' || s.status === 'partial')

if (toApply.length === 0) {
  console.log('\nAll probed migrations are applied. Nothing to do.')
  process.exit(0)
}

console.log(`\n${toApply.length} migration(s) need applying:`)
for (const s of toApply) console.log(`  - ${s.file}`)

if (!APPLY) {
  console.log('\nRun with --apply to execute them against the linked project.')
  process.exit(0)
}

console.log('\nApplying in order via supabase db query --linked …')
for (const s of toApply) {
  console.log(`\n→ ${s.file}`)
  try {
    const output = execSync(
      `npx supabase db query --linked --file ${join(MIGRATIONS_DIR, s.file)}`,
      { stdio: 'pipe', encoding: 'utf8' }
    )
    console.log('  ok:', output.split('\n').filter((l) => l.trim()).pop()?.slice(0, 80))
  } catch (err) {
    console.error(`  FAILED: ${err.message.split('\n').slice(0, 3).join(' | ').slice(0, 200)}`)
    console.error('  Stopping. Fix the error and rerun.')
    process.exit(1)
  }
}

console.log('\nRe-probing to confirm all applied…')
for (const s of toApply) {
  const after = await statusOf(s.file)
  const icon = after.status === 'applied' ? '✓' : '✗'
  console.log(`  ${icon} ${after.file} → ${after.status} (${after.detail})`)
}
