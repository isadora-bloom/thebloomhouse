/**
 * T5-Rixey-KKK verification script.
 *
 * Runs computeSourceFunnel directly (no HTTP — same code path the
 * /api/intel/sources/funnel route uses) and asserts:
 *
 *   - Calendly bookings = 0 under last_touch (was 17)
 *   - Calendly bookings near 0 (<0.1) under linear (was 9.8)
 *   - The Knot bookings = 0 under last_touch (DB truth: zero non-merged
 *     booked weddings have source='the_knot')
 *   - The Knot bookings = 0 under linear
 *
 * Why call the service directly: the funnel route is auth-gated and
 * needs a coordinator session cookie; the script-level service-role
 * call exercises the SAME computation without that ceremony. If the
 * service is right, the route is right (the route is a thin wrapper).
 *
 * Run:
 *   npx tsx scripts/rixey-load/61-kkk-verify.ts
 *
 * Set BLOOM_BASE_URL + BLOOM_COOKIE to additionally hit the live
 * endpoint (skipped when unset).
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

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

// Inline the env loader at module-top so process.env is set before
// computeSourceFunnel imports createServiceClient (which reads env at
// import time).
const env = loadEnv()
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v
}

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

let exitCode = 0

function fail(msg: string) {
  console.error(`FAIL: ${msg}`)
  exitCode = 1
}

function pass(msg: string) {
  console.log(`PASS: ${msg}`)
}

async function main() {
  console.log('=== T5-Rixey-KKK verification ===')

  // Dynamic import so process.env hydration above lands before the
  // service module reads SUPABASE_URL / SERVICE_ROLE_KEY.
  const { computeSourceFunnel } = await import('../../src/lib/services/attribution.js')

  // ---- Direct DB truth ----
  console.log('\n--- A) DB truth (non-merged booked weddings by source) ---')
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
  const { data: bookedNonMerged } = await sb
    .from('weddings')
    .select('source')
    .eq('venue_id', RIXEY_VENUE_ID)
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
  const truthBySource = new Map<string, number>()
  for (const w of bookedNonMerged ?? []) {
    const s = ((w.source as string | null) ?? 'unknown').toString().toLowerCase()
    truthBySource.set(s, (truthBySource.get(s) ?? 0) + 1)
  }
  console.log(`  total non-merged booked: ${bookedNonMerged?.length ?? 0}`)
  console.log(`  the_knot: ${truthBySource.get('the_knot') ?? 0}`)
  console.log(`  calendly: ${truthBySource.get('calendly') ?? 0}`)

  // ---- Last-touch model ----
  console.log('\n--- B) computeSourceFunnel(model=last_touch) ---')
  const lastTouchRows = await computeSourceFunnel(RIXEY_VENUE_ID, { model: 'last_touch' })
  const ltCalendly = lastTouchRows.find((r) => (r.source ?? '').toLowerCase() === 'calendly')
  const ltKnot = lastTouchRows.find((r) => (r.source ?? '').toLowerCase() === 'the_knot')
  const ltCalendlyBookings = Number(ltCalendly?.bookings ?? 0)
  const ltKnotBookings = Number(ltKnot?.bookings ?? 0)
  console.log(`  calendly bookings: ${ltCalendlyBookings} (was 17 pre-KKK)`)
  console.log(`  the_knot bookings: ${ltKnotBookings} (DB truth: 0)`)

  if (ltCalendlyBookings === 0) {
    pass('last_touch Calendly bookings = 0')
  } else {
    fail(`last_touch Calendly bookings = ${ltCalendlyBookings} (expected 0)`)
  }
  if (ltKnotBookings === 0) {
    pass('last_touch The Knot bookings = 0')
  } else {
    fail(`last_touch The Knot bookings = ${ltKnotBookings} (expected 0 — DB truth says zero non-merged booked weddings have source=the_knot)`)
  }

  // ---- Linear model ----
  console.log('\n--- C) computeSourceFunnel(model=linear) ---')
  const linearRows = await computeSourceFunnel(RIXEY_VENUE_ID, { model: 'linear' })
  const linCalendly = linearRows.find((r) => (r.source ?? '').toLowerCase() === 'calendly')
  const linKnot = linearRows.find((r) => (r.source ?? '').toLowerCase() === 'the_knot')
  const linCalendlyBookings = Number(linCalendly?.bookings ?? 0)
  const linKnotBookings = Number(linKnot?.bookings ?? 0)
  console.log(`  calendly bookings: ${linCalendlyBookings} (was 9.8 pre-KKK)`)
  console.log(`  the_knot bookings: ${linKnotBookings} (DB truth: 0)`)

  if (linCalendlyBookings < 0.1) {
    pass('linear Calendly bookings near 0')
  } else {
    fail(`linear Calendly bookings = ${linCalendlyBookings} (expected near 0)`)
  }
  if (linKnotBookings < 0.1) {
    pass('linear The Knot bookings near 0')
  } else {
    fail(`linear The Knot bookings = ${linKnotBookings} (expected near 0 — DB truth says zero non-merged booked weddings have source=the_knot)`)
  }

  // ---- Optional live HTTP cross-check ----
  console.log('\n--- D) live endpoint (optional) ---')
  const baseUrl = process.env.BLOOM_BASE_URL
  if (!baseUrl) {
    console.log('  SKIP: set BLOOM_BASE_URL to enable.')
  } else {
    for (const model of ['last_touch', 'linear'] as const) {
      const url = `${baseUrl.replace(/\/$/, '')}/api/intel/sources/funnel?venue_id=${RIXEY_VENUE_ID}&model=${model}`
      let res: Response
      try {
        res = await fetch(url, { headers: process.env.BLOOM_COOKIE ? { Cookie: process.env.BLOOM_COOKIE } : undefined })
      } catch (err) {
        console.log(`  SKIP (${model}): ${(err as Error).message}`)
        continue
      }
      if (res.status === 401 || res.status === 403) {
        console.log(`  SKIP (${model}): HTTP ${res.status}, set BLOOM_COOKIE`)
        continue
      }
      if (!res.ok) {
        fail(`endpoint ${model}: HTTP ${res.status}`)
        continue
      }
      const json = (await res.json()) as { rows?: Array<{ source: string | null; bookings: number }> }
      const cal = (json.rows ?? []).find((r) => (r.source ?? '').toLowerCase() === 'calendly')
      const knot = (json.rows ?? []).find((r) => (r.source ?? '').toLowerCase() === 'the_knot')
      console.log(`  ${model}: calendly=${cal?.bookings ?? 0} knot=${knot?.bookings ?? 0}`)
      if ((cal?.bookings ?? 0) > 0.1) fail(`endpoint ${model} calendly > 0`)
      if ((knot?.bookings ?? 0) > 0.1) fail(`endpoint ${model} knot > 0`)
    }
  }

  console.log(exitCode === 0 ? '\nAll checks passed.' : '\nFailures detected.')
  process.exit(exitCode)
}

main().catch((e) => { console.error(e); process.exit(1) })
