// Apply-migrations: reconcile local supabase/migrations/*.sql with the
// actual schema state on prod, then apply any that are missing.
//
// Why not `supabase db push`: this project has three migration files
// that share prefix numbers with other migrations (030_guest_tags,
// 031_table_map_layouts, 032_vendor_portal_fields). The supabase CLI's
// schema_migrations tracking table uses version (the prefix) as the
// primary key, so it can only record ONE migration per version slot.
// `db push` will therefore always list those three as pending even
// though they're verified applied. This script probes actual table /
// column existence instead of trusting the tracking table.
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

  // Auto-parsed: CREATE TABLE + ADD COLUMN (the common case).
  const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi
  for (const m of sql.matchAll(createTableRe)) {
    artifacts.push({ kind: 'table', table: m[1] })
  }
  const alterRe = /ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)([\s\S]*?);/gi
  for (const m of sql.matchAll(alterRe)) {
    const table = m[1]
    const body = m[2]
    const colRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s/gi
    for (const c of body.matchAll(colRe)) {
      artifacts.push({ kind: 'column', table, column: c[1] })
    }
  }

  // Explicit @probe directives for migrations that don't create tables
  // / columns (CHECK widens, policy adds, function rewrites). Formats:
  //   -- @probe: table foo_bar                 → check table exists
  //   -- @probe: column foo_bar.col_name       → check column exists
  //   -- @probe: insert_accepts weddings.source=zola
  //       → INSERT a probe row into the table with col=value, assert
  //         no constraint violation, roll back.
  const probeRe = /--\s*@probe:\s*(.+)$/gmi
  for (const m of sql.matchAll(probeRe)) {
    const directive = m[1].trim()
    const [kind, ...rest] = directive.split(/\s+/)
    const spec = rest.join(' ')
    if (kind === 'table') {
      artifacts.push({ kind: 'table', table: spec })
    } else if (kind === 'column') {
      const [table, column] = spec.split('.')
      if (table && column) artifacts.push({ kind: 'column', table, column })
    } else if (kind === 'insert_accepts') {
      // "weddings.source=zola"
      const eq = spec.indexOf('=')
      if (eq > 0) {
        const [table, column] = spec.slice(0, eq).split('.')
        const value = spec.slice(eq + 1)
        if (table && column) artifacts.push({ kind: 'insert_accepts', table, column, value })
      }
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
  if (a.kind === 'column') {
    const { error } = await sb.from(a.table).select(a.column).limit(1)
    if (!error) return { ok: true }
    if (/column "?[^"]+"? does not exist/i.test(error.message)) return { ok: false, reason: 'column missing' }
    if (error.code === 'PGRST205') return { ok: false, reason: 'table missing' }
    return { ok: true, reason: `probe noise: ${error.message.slice(0, 60)}` }
  }
  if (a.kind === 'insert_accepts') {
    // Try to INSERT a probe row with the specified (column, value).
    // NOT NULL constraints on OTHER columns will usually require fill —
    // for weddings we need venue_id + status. Accept either success or
    // failure-not-due-to-check as "column accepts value".
    // For generality we use a known demo venue_id as filler where
    // venue_id is required.
    const HAW = '22222222-2222-2222-2222-222222222201'
    const payload = { [a.column]: a.value }
    if (a.table === 'weddings') {
      payload.venue_id = HAW
      payload.status = 'inquiry'
      payload.notes = '_apply_migrations_probe'
    }
    try {
      const { data, error } = await sb.from(a.table).insert(payload).select('id').single()
      if (error) {
        const msg = error.message.toLowerCase()
        // Only CHECK violations on the probed column prove "not applied".
        if (msg.includes('check constraint') && msg.includes(a.column)) {
          return { ok: false, reason: `insert rejected: ${error.message.slice(0, 80)}` }
        }
        // Other errors (NOT NULL on unrelated columns, RLS, etc.) don't
        // tell us about the probed CHECK. Treat as inconclusive but
        // lean "applied" so we don't loop re-applying by mistake.
        return { ok: true, reason: `probe noise (${error.code}): ${error.message.slice(0, 60)}` }
      }
      if (data?.id) await sb.from(a.table).delete().eq('id', data.id)
      return { ok: true }
    } catch (err) {
      return { ok: true, reason: `probe exception: ${err.message.slice(0, 60)}` }
    }
  }
  return { ok: true, reason: `unknown kind: ${a.kind}` }
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
