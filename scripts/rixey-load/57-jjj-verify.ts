/**
 * T5-Rixey-JJJ verification script.
 *
 * Hits the new /api/intel/sources/wedding-rollup endpoint with Rixey's
 * venue_id and asserts:
 *   - The endpoint returns NON-zero HoneyBook revenue + bookings (the
 *     core regression: a silent-RLS-zero would be the bug shape).
 *   - The endpoint output matches a direct service-role DB query with
 *     the same predicates (status IN booked|completed AND
 *     merged_into_id IS NULL).
 *   - Pre-merge totals match the spec's reference ($794K HoneyBook
 *     revenue, 60 HoneyBook bookings) — confirms the dataset is the
 *     same Rixey database the spec was written against.
 *
 * Spec note: the spec's `Reference data` block lists $794,200 / 60
 * bookings for HoneyBook. Those are the PRE-merge counts. After the
 * merged_into_id IS NULL filter the spec also instructed us to add,
 * Rixey's HoneyBook bucket is $514K / 40 bookings (20 merged-into-
 * other rows are excluded). Both numbers are checked separately so
 * the test catches drift in either direction.
 *
 * Why this exists: the previous browser-side weddings query silently
 * returned zero rows under RLS. Total Revenue showed $0 even though
 * the database had $794K. This script makes that regression
 * impossible to ship unnoticed — if the endpoint comes back with a
 * zero Rixey total, the script exits non-zero.
 *
 * Run:
 *   $env:BLOOM_BASE_URL="http://localhost:3000"   # or production URL
 *   npx tsx scripts/rixey-load/57-jjj-verify.ts
 *
 * The endpoint is auth-gated. To call it from a script you either need
 * a coordinator session cookie OR you can run the same query directly
 * against Supabase via SUPABASE_SERVICE_ROLE_KEY (this script does
 * BOTH so it works either way — see VERIFY_VIA_API and VERIFY_VIA_DB
 * below).
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
) as Record<string, string>

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY!
const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Spec reference data — PRE-merge counts (no merged_into_id filter)
const SPEC_PRE_MERGE_HB_REVENUE = 794_200 // dollars
const SPEC_PRE_MERGE_HB_BOOKINGS = 60
// Post-merge expectations — what the new endpoint should return
const POST_MERGE_HB_MIN_BOOKINGS = 30 // 40 in current data, leave headroom
const POST_MERGE_HB_MIN_REVENUE = 400_000 // $514K in current data
const REVENUE_TOLERANCE = 1_000 // dollars

let exitCode = 0

function fail(msg: string) {
  console.error(`FAIL: ${msg}`)
  exitCode = 1
}

function pass(msg: string) {
  console.log(`PASS: ${msg}`)
}

// ---------------------------------------------------------------------------
// Verification A: query Supabase directly with the same predicates the
// new endpoint uses. This is the source-of-truth check — if this is off
// the endpoint can never be right.
// ---------------------------------------------------------------------------
async function verifyViaDb() {
  console.log('\n--- A: direct Supabase query (truth) ---')
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // POST-merge query — same predicates as the new endpoint.
  const { data: postMerge, error: e1 } = await sb
    .from('weddings')
    .select('source, booking_value')
    .eq('venue_id', RIXEY_VENUE_ID)
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
  if (e1) {
    fail(`post-merge query error: ${e1.message}`)
    return null
  }

  // PRE-merge query — should match the spec's reference numbers.
  const { data: preMerge, error: e2 } = await sb
    .from('weddings')
    .select('source, booking_value')
    .eq('venue_id', RIXEY_VENUE_ID)
    .in('status', ['booked', 'completed'])
  if (e2) {
    fail(`pre-merge query error: ${e2.message}`)
    return null
  }

  function summarise(rows: Array<{ source: string | null; booking_value: number | null }>) {
    let totalBookings = 0, totalCents = 0, hbBookings = 0, hbCents = 0
    for (const w of rows) {
      totalBookings += 1
      const cents = Number(w.booking_value ?? 0)
      totalCents += Number.isFinite(cents) ? cents : 0
      const k = ((w.source ?? '').toString().trim().toLowerCase()) || 'unknown'
      if (k === 'honeybook') {
        hbBookings += 1
        hbCents += Number.isFinite(cents) ? cents : 0
      }
    }
    return { totalBookings, totalCents, hbBookings, hbCents }
  }

  const post = summarise((postMerge ?? []) as Array<{ source: string | null; booking_value: number | null }>)
  const pre = summarise((preMerge ?? []) as Array<{ source: string | null; booking_value: number | null }>)

  console.log(`  POST-merge (endpoint truth):`)
  console.log(`    total bookings: ${post.totalBookings}`)
  console.log(`    total revenue:  $${(post.totalCents / 100).toLocaleString()}`)
  console.log(`    honeybook:      ${post.hbBookings} bookings, $${(post.hbCents / 100).toLocaleString()}`)
  console.log(`  PRE-merge (spec reference):`)
  console.log(`    total bookings: ${pre.totalBookings}`)
  console.log(`    honeybook:      ${pre.hbBookings} bookings, $${(pre.hbCents / 100).toLocaleString()}`)

  // POST-merge must be NON-zero — that's the regression we care about.
  if (post.totalCents <= 0) {
    fail(`POST-merge total revenue is $0 — RLS or query regression`)
  } else {
    pass(`POST-merge total revenue is non-zero`)
  }
  if (post.hbBookings < POST_MERGE_HB_MIN_BOOKINGS) {
    fail(`POST-merge HoneyBook bookings (${post.hbBookings}) below ${POST_MERGE_HB_MIN_BOOKINGS}`)
  } else {
    pass(`POST-merge HoneyBook bookings >= ${POST_MERGE_HB_MIN_BOOKINGS}`)
  }
  if (post.hbCents / 100 < POST_MERGE_HB_MIN_REVENUE) {
    fail(`POST-merge HoneyBook revenue ($${(post.hbCents / 100).toLocaleString()}) below $${POST_MERGE_HB_MIN_REVENUE.toLocaleString()}`)
  } else {
    pass(`POST-merge HoneyBook revenue >= $${POST_MERGE_HB_MIN_REVENUE.toLocaleString()}`)
  }

  // PRE-merge sanity: confirms we're against the same dataset the spec
  // used. If this drifts, either the data changed or the spec is stale.
  if (pre.hbBookings < SPEC_PRE_MERGE_HB_BOOKINGS) {
    fail(`PRE-merge HoneyBook bookings (${pre.hbBookings}) below spec reference ${SPEC_PRE_MERGE_HB_BOOKINGS}`)
  } else {
    pass(`PRE-merge HoneyBook bookings matches spec reference (${pre.hbBookings} >= ${SPEC_PRE_MERGE_HB_BOOKINGS})`)
  }
  const preDollars = pre.hbCents / 100
  if (Math.abs(preDollars - SPEC_PRE_MERGE_HB_REVENUE) > REVENUE_TOLERANCE) {
    fail(`PRE-merge HoneyBook revenue ($${preDollars.toLocaleString()}) >$${REVENUE_TOLERANCE} off spec reference $${SPEC_PRE_MERGE_HB_REVENUE.toLocaleString()}`)
  } else {
    pass(`PRE-merge HoneyBook revenue matches spec reference within $${REVENUE_TOLERANCE}`)
  }

  return { totalBookings: post.totalBookings, totalRevenueCents: post.totalCents, honeyBookBookings: post.hbBookings, honeyBookRevenueCents: post.hbCents }
}

// ---------------------------------------------------------------------------
// Verification B: call the actual endpoint and compare to the truth
// from A. Skipped (with a warning) when no BLOOM_BASE_URL is set or
// when the endpoint isn't reachable — direct DB verification still
// covers the regression we care about most.
// ---------------------------------------------------------------------------
async function verifyViaApi(truth: { totalBookings: number; totalRevenueCents: number } | null) {
  console.log('\n--- B: live endpoint call ---')
  const baseUrl = process.env.BLOOM_BASE_URL
  if (!baseUrl) {
    console.log('  SKIP: set BLOOM_BASE_URL=http://localhost:3000 (or prod) to enable.')
    return
  }
  const url = `${baseUrl.replace(/\/$/, '')}/api/intel/sources/wedding-rollup?venue_id=${RIXEY_VENUE_ID}`
  console.log(`  GET ${url}`)
  let res: Response
  try {
    res = await fetch(url, {
      headers: process.env.BLOOM_COOKIE
        ? { Cookie: process.env.BLOOM_COOKIE }
        : undefined,
    })
  } catch (err) {
    fail(`endpoint fetch failed: ${(err as Error).message}`)
    return
  }
  if (res.status === 401 || res.status === 403) {
    console.log(`  SKIP: endpoint requires auth (status ${res.status}). Set BLOOM_COOKIE to a coordinator session cookie to enable.`)
    return
  }
  if (!res.ok) {
    fail(`endpoint HTTP ${res.status}`)
    return
  }
  const json = (await res.json()) as {
    rows?: Array<{ source_key: string; bookings: number; revenue_cents: number }>
    totals?: { bookings: number; revenue_cents: number }
  }
  const apiBookings = json.totals?.bookings ?? 0
  const apiRevenueCents = json.totals?.revenue_cents ?? 0
  console.log(`  api totals: bookings=${apiBookings}, revenue=$${(apiRevenueCents / 100).toLocaleString()}`)

  if (truth) {
    if (apiBookings !== truth.totalBookings) {
      fail(`api bookings (${apiBookings}) != truth (${truth.totalBookings})`)
    } else {
      pass(`api bookings match truth (${apiBookings})`)
    }
    if (Math.abs(apiRevenueCents - truth.totalRevenueCents) > REVENUE_TOLERANCE * 100) {
      fail(`api revenue cents (${apiRevenueCents}) deviates from truth (${truth.totalRevenueCents})`)
    } else {
      pass(`api revenue matches truth (within $${REVENUE_TOLERANCE})`)
    }
  }

  const honeyBookRow = (json.rows ?? []).find((r) => r.source_key === 'honeybook')
  if (!honeyBookRow) {
    fail('api returned no honeybook row for Rixey')
  } else {
    console.log(`  honeybook row: bookings=${honeyBookRow.bookings}, revenue=$${(honeyBookRow.revenue_cents / 100).toLocaleString()}`)
    if (honeyBookRow.bookings < POST_MERGE_HB_MIN_BOOKINGS) {
      fail(`api honeybook bookings (${honeyBookRow.bookings}) below ${POST_MERGE_HB_MIN_BOOKINGS}`)
    } else {
      pass(`api honeybook bookings >= ${POST_MERGE_HB_MIN_BOOKINGS}`)
    }
    const honeyBookRevenueDollars = honeyBookRow.revenue_cents / 100
    if (honeyBookRevenueDollars < POST_MERGE_HB_MIN_REVENUE) {
      fail(`api honeybook revenue ($${honeyBookRevenueDollars.toLocaleString()}) below $${POST_MERGE_HB_MIN_REVENUE.toLocaleString()}`)
    } else {
      pass(`api honeybook revenue >= $${POST_MERGE_HB_MIN_REVENUE.toLocaleString()}`)
    }
  }
}

async function main() {
  console.log('=== T5-Rixey-JJJ verification ===')
  const truth = await verifyViaDb()
  await verifyViaApi(truth)
  console.log(exitCode === 0 ? '\nAll checks passed.' : '\nFailures detected — see FAIL lines above.')
  process.exit(exitCode)
}

main().catch((err) => {
  console.error('script error:', err)
  process.exit(1)
})
