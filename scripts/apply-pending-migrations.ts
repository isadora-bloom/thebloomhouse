/**
 * Apply all pending migrations in order via the public.exec_sql RPC.
 *
 * Probes status by re-using scripts/rixey-load/59-migration-status.ts logic
 * inline (so this script is self-contained), then runs each unapplied
 * migration via scripts/run-migration.ts's machinery.
 *
 * Requires migration 198_exec_sql_rpc.sql to be applied first (one-time
 * paste into the Supabase SQL editor).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { splitSqlStatements } from './lib/sql-split.js'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

interface Probe {
  migration: string
  file: string
  describe: string
  isApplied: (sb: SupabaseClient) => Promise<boolean>
}

const probes: Probe[] = [
  {
    migration: '190',
    file: 'supabase/migrations/190_weather_data_extension.sql',
    describe: 'weather_data extension columns',
    isApplied: async (sb) => {
      const { error } = await sb.from('weather_data').select('region, severity_score').limit(1)
      if (!error) return true
      return !/column .* does not exist/i.test(error.message)
    },
  },
  {
    migration: '195',
    file: 'supabase/migrations/195_venue_signature_fields.sql',
    describe: 'venues signature fields',
    isApplied: async (sb) => {
      const { error } = await sb.from('venues').select('ai_role_title').limit(1)
      if (!error) return true
      return !/column .* does not exist/i.test(error.message)
    },
  },
  {
    migration: '196',
    file: 'supabase/migrations/196_tour_temporal.sql',
    describe: 'tours.couple_display_name + trigger + index',
    isApplied: async (sb) => {
      const { error } = await sb.from('tours').select('couple_display_name').limit(1)
      if (!error) return true
      return !/column .* does not exist/i.test(error.message)
    },
  },
]

async function ensureRpcAvailable(sb: SupabaseClient): Promise<void> {
  // Probe by calling exec_sql with a no-op SELECT.
  const { data, error } = await sb.rpc('exec_sql', { sql: 'SELECT 1' })
  if (error) {
    console.error('✗ exec_sql RPC is NOT available.')
    console.error(`  RPC error: ${error.message}`)
    console.error('  Fix: paste supabase/migrations/198_exec_sql_rpc.sql into the Supabase SQL editor and run.')
    console.error('  https://supabase.com/dashboard/project/jsxxgwprxuqgcauzlxcb/sql/new')
    process.exit(1)
  }
  const r = data as { ok: boolean; error?: string }
  if (!r.ok) {
    console.error(`✗ exec_sql probe failed: ${r.error ?? 'unknown'}`)
    process.exit(1)
  }
  console.log('✓ exec_sql RPC available')
}

// PL/pgSQL EXECUTE rejects transaction-control statements ("EXECUTE of
// transaction commands is not implemented", SQLSTATE 0A000). Strip them.
// Each EXECUTE in exec_sql already runs as an implicit single-statement
// transaction, and migration files in this repo are idempotent — losing
// the BEGIN/COMMIT grouping doesn't change correctness.
const TX_CONTROL_RE = /^(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|END)\b/i

/** Strip leading whitespace + line/block comments. The TX-control regex
 *  matches against this so a chunk like "-- header\nBEGIN" is recognized. */
function stripLeadingNoise(s: string): string {
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (/\s/.test(c)) { i++; continue }
    if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (c === '/' && s[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < s.length && depth > 0) {
        if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; continue }
        if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; continue }
        i++
      }
      continue
    }
    break
  }
  return s.slice(i)
}

async function applyFile(sb: SupabaseClient, file: string): Promise<void> {
  const sql = readFileSync(resolve(file), 'utf8')
  const allStatements = splitSqlStatements(sql)
  const statements = allStatements.filter((s) => !TX_CONTROL_RE.test(stripLeadingNoise(s)))
  const skipped = allStatements.length - statements.length
  console.log(`  → ${statements.length} statement(s)${skipped > 0 ? ` (${skipped} BEGIN/COMMIT skipped — exec_sql runs each as its own tx)` : ''}`)
  for (let idx = 0; idx < statements.length; idx++) {
    const stmt = statements[idx]!
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 100) + (stmt.length > 100 ? '...' : '')
    const { data, error } = await sb.rpc('exec_sql', { sql: stmt })
    if (error) {
      console.error(`    ✗ [${idx + 1}/${statements.length}] RPC failed: ${error.message}`)
      console.error(`      statement: ${preview}`)
      process.exit(1)
    }
    const r = data as { ok: boolean; error?: string; state?: string }
    if (!r.ok) {
      console.error(`    ✗ [${idx + 1}/${statements.length}] [${r.state}] ${r.error}`)
      console.error(`      statement: ${preview}`)
      process.exit(1)
    }
    console.log(`    ✓ [${idx + 1}/${statements.length}] ${preview}`)
  }
}

async function main() {
  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  await ensureRpcAvailable(sb)

  console.log('\nProbing migration status...')
  const pending: Probe[] = []
  for (const p of probes) {
    const applied = await p.isApplied(sb)
    if (applied) {
      console.log(`✓ ${p.migration}  ${p.describe}`)
    } else {
      console.log(`✗ ${p.migration}  ${p.describe}  ← will apply`)
      pending.push(p)
    }
  }

  if (pending.length === 0) {
    console.log('\nNothing pending. All probed migrations are applied.')
    return
  }

  console.log(`\nApplying ${pending.length} pending migration(s)...\n`)
  for (const p of pending) {
    console.log(`▶ ${p.migration}  ${p.file}`)
    await applyFile(sb, p.file)
    console.log()
  }

  console.log('Done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
