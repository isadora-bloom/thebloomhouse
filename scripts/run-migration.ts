/**
 * Run a Postgres migration file via the public.exec_sql RPC.
 *
 * Usage:
 *   npx tsx scripts/run-migration.ts supabase/migrations/196_tour_temporal.sql
 *
 * Requires migration 198_exec_sql_rpc.sql to be applied first (one-time
 * paste into the Supabase SQL editor).
 *
 * Behavior:
 *   1. Reads the file.
 *   2. Splits into top-level statements (handles dollar quoting + comments).
 *   3. Runs each statement via supabase.rpc('exec_sql', { sql }).
 *   4. Aborts on first failure, prints the error + the offending statement.
 *   5. Reports per-statement timing and a final summary.
 *
 * Migrations in this repo often wrap their bodies in BEGIN; ... COMMIT;
 * and rely on rollback-on-error. This runner does NOT preserve that
 * transaction grouping — each statement is its own implicit transaction.
 * For idempotent migrations (which all of ours are after 187) this is
 * fine; for one-shot non-idempotent ones, halt-and-fix is safer than
 * partial-rollback anyway.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
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

async function main() {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: npx tsx scripts/run-migration.ts <migration.sql>')
    process.exit(2)
  }
  const abs = resolve(path)
  const sql = readFileSync(abs, 'utf8')
  const statements = splitSqlStatements(sql)
  console.log(`Migration: ${path}`)
  console.log(`Parsed: ${statements.length} top-level statement(s)`)

  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  let okCount = 0
  for (let idx = 0; idx < statements.length; idx++) {
    const stmt = statements[idx]!
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 120) + (stmt.length > 120 ? '...' : '')
    process.stdout.write(`  [${idx + 1}/${statements.length}] ${preview}\n`)
    const t0 = Date.now()
    const { data, error } = await sb.rpc('exec_sql', { sql: stmt })
    const dt = Date.now() - t0

    if (error) {
      console.error(`  ✗ RPC transport failed (${dt}ms): ${error.message}`)
      console.error(`    statement was:\n${stmt}`)
      process.exit(1)
    }
    const result = data as { ok: boolean; error?: string; state?: string; context?: string; note?: string } | null
    if (!result || !result.ok) {
      console.error(`  ✗ SQL failed (${dt}ms): [${result?.state ?? '?'}] ${result?.error ?? 'unknown'}`)
      console.error(`    statement was:\n${stmt}`)
      process.exit(1)
    }
    okCount++
    console.log(`  ✓ ok (${dt}ms)`)
  }

  console.log(`\nDone. ${okCount}/${statements.length} statements applied.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
