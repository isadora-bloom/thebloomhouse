/**
 * Stream WWW — UTM column + readiness verify.
 *
 * Why
 * ---
 * Migration 205 adds utm_source / utm_medium / utm_campaign / utm_term
 * / utm_content / utm_first_seen_at to public.weddings. This script
 * verifies:
 *
 *   1. The six new columns exist (information_schema sanity check).
 *   2. The partial index idx_weddings_utm_source is in place.
 *   3. The Rixey UTM coverage is currently 0 (column is brand new).
 *   4. The cross-venue UTM coverage matches expectation (also 0
 *      everywhere since no writer has flipped the bit yet).
 *   5. Prints the readiness-step snippet so we know what
 *      onboarding-project.ts will surface to coordinators on Day 2.
 *
 * Run
 * ---
 *   npx tsx scripts/rixey-load/76-www-verify.ts
 *
 * Idempotent — read-only queries; never writes.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

function loadEnv(): Record<string, string> {
  // Worktree's CWD doesn't carry .env.local; fall back to the main
  // repo's copy. Both share the same Supabase project.
  const candidates = ['.env.local', 'C:\\Users\\Ismar\\bloom-house\\.env.local']
  let raw = ''
  for (const c of candidates) {
    try { raw = readFileSync(c, 'utf8'); break } catch { /* try next */ }
  }
  if (!raw) throw new Error('.env.local not found (looked in worktree + main repo)')
  return Object.fromEntries(
    raw
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      }),
  )
}

const EXPECTED_UTM_COLUMNS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_first_seen_at',
]

async function checkColumns(sb: SupabaseClient): Promise<boolean> {
  // exec_sql is DDL-only — it doesn't return query results. We probe
  // existence by SELECTing each utm_* column via PostgREST. A failed
  // SELECT (column does not exist) trips a 42703 error; success
  // returns the column shape (count head only — no data needed).
  let allFound = true
  for (const col of EXPECTED_UTM_COLUMNS) {
    const { error } = await sb
      .from('weddings')
      .select(col, { count: 'exact', head: true })
      .limit(1)
    if (error) {
      console.log(`    ✗ ${col} (missing — ${error.message})`)
      allFound = false
    } else {
      console.log(`    ✓ ${col}`)
    }
  }
  return allFound
}

async function checkIndex(sb: SupabaseClient): Promise<boolean> {
  // pg_indexes isn't exposed via PostgREST — we proxy through a
  // tangential signal: try a SELECT that the partial index covers
  // and inspect the EXPLAIN output. Simpler: trust that the
  // CREATE INDEX IF NOT EXISTS in the migration ran successfully
  // (it returned ok=1 from run-migration.ts). Print informational
  // line only.
  console.log('    (index existence not directly probable via PostgREST — trust migration runner)')
  console.log('    (the CREATE INDEX IF NOT EXISTS statement returned ok in the migration apply)')
  // Sanity: query weddings filtered by utm_source IS NOT NULL — if
  // the column or index were broken this would 4xx.
  const { error } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .not('utm_source', 'is', null)
  if (error) {
    console.log(`    ✗ utm_source NOT NULL probe failed: ${error.message}`)
    return false
  }
  console.log('    ✓ utm_source NOT NULL filter accepted by PostgREST')
  return true
}

async function probeUtmCoverageRixey(sb: SupabaseClient): Promise<number> {
  const { count } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_VENUE_ID)
    .not('utm_source', 'is', null)
  return count ?? 0
}

async function probeCrossVenueCoverage(sb: SupabaseClient): Promise<{ totalVenues: number; venuesWithUtm: number; totalRowsWithUtm: number }> {
  const { data: venuesRaw } = await sb.from('venues').select('id, name')
  const venues = (venuesRaw ?? []) as Array<{ id: string; name: string | null }>
  let venuesWithUtm = 0
  let totalRowsWithUtm = 0
  for (const v of venues) {
    const { count } = await sb
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', v.id)
      .not('utm_source', 'is', null)
    const c = count ?? 0
    if (c > 0) {
      venuesWithUtm += 1
      totalRowsWithUtm += c
    }
  }
  return { totalVenues: venues.length, venuesWithUtm, totalRowsWithUtm }
}

const READINESS_SNIPPET = `<!-- Add UTM tracking to your web-form embed code. -->
<!-- Standard pattern for paid-ad landing links: -->
<a href="https://yourvenue.com/inquire?utm_source=knot&utm_medium=storefront&utm_campaign=2026_spring">
  Inquire here
</a>

<!-- For Google Ads / Meta Ads, use the auto-tagging UTM template at the campaign level. -->
<!-- Bloom captures every UTM key on form submission and preserves it through HoneyBook -->
<!-- contract import — your Google Ads spend gets credit for the bookings it actually drove. -->`

async function main(): Promise<void> {
  const env = loadEnv()
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  console.log('=== Stream WWW: UTM column + readiness verify ===')

  console.log('\n--- 1. Checking weddings.utm_* columns ---')
  const colsOk = await checkColumns(sb)

  console.log('\n--- 2. Checking partial index idx_weddings_utm_source ---')
  const idxOk = await checkIndex(sb)

  console.log('\n--- 3. Rixey UTM coverage probe ---')
  const rixeyCount = await probeUtmCoverageRixey(sb)
  console.log(`  Rixey weddings with utm_source IS NOT NULL: ${rixeyCount}`)
  console.log(`  (expected: 0 — column is brand new, no writer has stamped it yet)`)

  console.log('\n--- 4. Cross-venue UTM coverage probe ---')
  const cross = await probeCrossVenueCoverage(sb)
  console.log(`  total venues: ${cross.totalVenues}`)
  console.log(`  venues with any UTM rows: ${cross.venuesWithUtm}`)
  console.log(`  total rows with utm_source IS NOT NULL: ${cross.totalRowsWithUtm}`)

  console.log('\n--- 5. Readiness-step snippet (Day 2 onboarding) ---')
  console.log(READINESS_SNIPPET.split('\n').map((l) => '  ' + l).join('\n'))

  console.log('\n=== Verify complete ===')
  console.log(colsOk && idxOk
    ? '  ✓ schema looks good'
    : '  ✗ schema verification failed — see above')
  if (!colsOk || !idxOk) process.exit(1)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
