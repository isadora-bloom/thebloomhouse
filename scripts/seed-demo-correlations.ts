/**
 * seed-demo-correlations.ts — Stream RRR (#84 + #98)
 *
 * Closes the YC-demo blocker on /intel/macro-correlations: the page
 * shipped EMPTY because intelligence_insights had zero correlation /
 * correlation_narration rows for the demo venues, and
 * external_calendar_events was un-populated until the daily cron fired
 * at 04:00 UTC.
 *
 * What it does
 * ------------
 *  1. Probes the live Supabase project for the 4 Crestwood Collection
 *     demo venue IDs by name (Hawthorne Manor, Crestwood Farm, The
 *     Glass House, Rose Hill Gardens). Sanity-checks them against the
 *     hardcoded UUIDs in src/lib/api/auth-helpers.ts (DEMO_VENUE_ALLOWLIST).
 *  2. Reads scripts/seed-demo-correlations.sql, splits into top-level
 *     statements, and runs each via the public.exec_sql RPC (service
 *     role required — see migration 198). Idempotent — every block
 *     uses ON CONFLICT DO NOTHING against the canonical unique
 *     indexes (uq_intelligence_insights_cache_key, uq_ece_scope_title_start).
 *  3. Reports row counts before and after for both tables, scoped to
 *     the 4 demo venue IDs (insights) and the demo year (calendar).
 *  4. Verifies a sample listExistingNarrations-shaped query returns
 *     rows for Hawthorne (the demo cookie's hard-pinned venue per
 *     DEMO_VENUE_ID).
 *
 * Usage
 * -----
 *   npx tsx scripts/seed-demo-correlations.ts
 *
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY. Migration 198_exec_sql_rpc.sql must be
 * applied to the live project first.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { splitSqlStatements } from './lib/sql-split.js'

// Mirror DEMO_VENUE_ALLOWLIST from src/lib/api/auth-helpers.ts. Hardcoded
// here so the runner can sanity-check the live probe matches the code path
// the demo cookie uses.
const EXPECTED_DEMO_VENUES = [
  { uuid: '22222222-2222-2222-2222-222222222201', name: 'Hawthorne Manor' },
  { uuid: '22222222-2222-2222-2222-222222222202', name: 'Crestwood Farm' },
  { uuid: '22222222-2222-2222-2222-222222222203', name: 'The Glass House' },
  { uuid: '22222222-2222-2222-2222-222222222204', name: 'Rose Hill Gardens' },
] as const

const DEMO_YEAR_START = '2026-01-01'

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // .env.local optional — shell env may already have the values
  }
  return env
}

interface VenueRow {
  id: string
  name: string
}

async function probeDemoVenues(sb: SupabaseClient): Promise<VenueRow[]> {
  const names = EXPECTED_DEMO_VENUES.map((v) => v.name)
  const { data, error } = await sb
    .from('venues')
    .select('id, name')
    .in('name', names)
    .order('name', { ascending: true })

  if (error) {
    throw new Error(`Failed to probe venues: ${error.message}`)
  }

  const rows = (data ?? []) as VenueRow[]
  if (rows.length !== EXPECTED_DEMO_VENUES.length) {
    const missing = names.filter((n) => !rows.some((r) => r.name === n))
    throw new Error(
      `Expected ${EXPECTED_DEMO_VENUES.length} demo venues, found ${rows.length}. ` +
        `Missing: ${missing.join(', ')}`,
    )
  }

  // Sanity-check UUIDs match DEMO_VENUE_ALLOWLIST.
  for (const row of rows) {
    const expected = EXPECTED_DEMO_VENUES.find((v) => v.name === row.name)
    if (!expected) continue
    if (row.id !== expected.uuid) {
      console.warn(
        `  ⚠ ${row.name} UUID drift: db=${row.id} vs code=${expected.uuid}. ` +
          `The seed SQL hardcodes the code-side UUID — DB rows may not be reachable.`,
      )
    }
  }
  return rows
}

async function countCorrelationInsights(sb: SupabaseClient, venueIds: string[]): Promise<number> {
  const { count, error } = await sb
    .from('intelligence_insights')
    .select('id', { count: 'exact', head: true })
    .in('venue_id', venueIds)
    .in('insight_type', ['correlation', 'correlation_narration'])
  if (error) throw new Error(`Count correlation insights failed: ${error.message}`)
  return count ?? 0
}

async function countDemoCalendarEvents(sb: SupabaseClient): Promise<number> {
  const { count, error } = await sb
    .from('external_calendar_events')
    .select('id', { count: 'exact', head: true })
    .gte('start_date', DEMO_YEAR_START)
  if (error) throw new Error(`Count calendar events failed: ${error.message}`)
  return count ?? 0
}

async function verifyNarrationReadPath(sb: SupabaseClient, venueId: string): Promise<number> {
  // Mirrors listExistingNarrations() in src/lib/services/insights/correlation-narration.ts
  // — the exact query path /api/intel/macro-correlations uses.
  const { data, error } = await sb
    .from('intelligence_insights')
    .select('id, title, body, action, confidence, data_points, created_at, context_id, surface_priority')
    .eq('venue_id', venueId)
    .eq('insight_type', 'correlation_narration')
    .neq('status', 'expired')
    .neq('status', 'dismissed')
    .order('surface_priority', { ascending: false, nullsFirst: false })
    .limit(20)
  if (error) throw new Error(`Verify read path failed: ${error.message}`)
  return (data ?? []).length
}

async function runSeedSql(sb: SupabaseClient, sqlPath: string): Promise<{ ok: number; total: number }> {
  const sql = readFileSync(resolve(sqlPath), 'utf8')
  const all = splitSqlStatements(sql)
  // exec_sql RPC runs PL/pgSQL EXECUTE which rejects transaction-control
  // statements (SQLSTATE 0A000). Strip BEGIN/COMMIT — each statement is
  // its own implicit transaction. Idempotent ON CONFLICT clauses make
  // this safe.
  const TX_CONTROL_RE = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|END)\b/i
  const statements = all.filter((s) => !TX_CONTROL_RE.test(s))
  const skipped = all.length - statements.length
  console.log(`Parsed ${statements.length} statement(s) from ${sqlPath}` + (skipped ? ` (${skipped} BEGIN/COMMIT skipped)` : ''))

  let ok = 0
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 100) + (stmt.length > 100 ? '...' : '')
    const t0 = Date.now()
    const { data, error } = await sb.rpc('exec_sql', { sql: stmt })
    const dt = Date.now() - t0
    if (error) {
      console.error(`  [${i + 1}/${statements.length}] ✗ RPC transport failed (${dt}ms): ${error.message}`)
      console.error(`    statement: ${preview}`)
      throw error
    }
    const result = data as { ok: boolean; error?: string; state?: string } | null
    if (!result || !result.ok) {
      console.error(`  [${i + 1}/${statements.length}] ✗ SQL failed (${dt}ms): [${result?.state ?? '?'}] ${result?.error ?? 'unknown'}`)
      console.error(`    statement: ${preview}`)
      throw new Error(`SQL exec failed: ${result?.error ?? 'unknown'}`)
    }
    ok++
    console.log(`  [${i + 1}/${statements.length}] ✓ ok (${dt}ms) — ${preview}`)
  }
  return { ok, total: statements.length }
}

async function main(): Promise<void> {
  const env = loadEnv()
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env')
    process.exit(2)
  }
  const sb = createClient(url, serviceKey, { auth: { persistSession: false } })

  console.log('Stream RRR — seed demo correlations + calendar events')
  console.log(`Target: ${url}\n`)

  // 1. Probe demo venues.
  console.log('1. Probing demo venue IDs by name...')
  const venues = await probeDemoVenues(sb)
  for (const v of venues) {
    console.log(`   ✓ ${v.name.padEnd(20)} ${v.id}`)
  }
  const venueIds = venues.map((v) => v.id)
  // Also include the hardcoded code-side IDs in case of drift — the seed
  // SQL inserts against the code-side UUIDs.
  const allInsightVenueIds = Array.from(new Set([...venueIds, ...EXPECTED_DEMO_VENUES.map((v) => v.uuid)]))

  // 2. Pre-counts.
  console.log('\n2. Row counts BEFORE seeding:')
  const insightsBefore = await countCorrelationInsights(sb, allInsightVenueIds)
  const calendarBefore = await countDemoCalendarEvents(sb)
  console.log(`   intelligence_insights (correlation + narration, demo venues): ${insightsBefore}`)
  console.log(`   external_calendar_events (start_date >= ${DEMO_YEAR_START}): ${calendarBefore}`)

  // 3. Run the seed SQL.
  console.log('\n3. Running scripts/seed-demo-correlations.sql via exec_sql RPC...')
  const { ok, total } = await runSeedSql(sb, 'scripts/seed-demo-correlations.sql')
  console.log(`   Applied ${ok}/${total} statements.`)

  // 4. Post-counts.
  console.log('\n4. Row counts AFTER seeding:')
  const insightsAfter = await countCorrelationInsights(sb, allInsightVenueIds)
  const calendarAfter = await countDemoCalendarEvents(sb)
  console.log(`   intelligence_insights (correlation + narration, demo venues): ${insightsAfter} (Δ +${insightsAfter - insightsBefore})`)
  console.log(`   external_calendar_events (start_date >= ${DEMO_YEAR_START}): ${calendarAfter} (Δ +${calendarAfter - calendarBefore})`)

  // 5. Verify the actual demo read path returns rows.
  console.log('\n5. Verifying /intel/macro-correlations read path (Hawthorne Manor, the demo-cookie pin):')
  const hawthorne = venues.find((v) => v.name === 'Hawthorne Manor')!
  const narrationCount = await verifyNarrationReadPath(sb, hawthorne.id)
  console.log(`   listExistingNarrations(${hawthorne.id}) → ${narrationCount} rows`)
  if (narrationCount === 0) {
    console.warn('   ⚠ Demo page will still render empty — investigate.')
  } else {
    console.log('   ✓ Demo page will render correlations.')
  }

  // 6. Verify each of the other demo venues has at least 1.
  console.log('\n6. Verifying every demo venue has ≥1 narration:')
  for (const v of venues) {
    const n = await verifyNarrationReadPath(sb, v.id)
    const mark = n > 0 ? '✓' : '✗'
    console.log(`   ${mark} ${v.name.padEnd(20)} → ${n} narration row(s)`)
  }

  console.log('\nDone.')
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e)
  process.exit(1)
})
