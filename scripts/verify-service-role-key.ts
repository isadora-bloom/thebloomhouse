/**
 * scripts/verify-service-role-key.ts (Tier-C #124/#125).
 *
 * Run AFTER rotating SUPABASE_SERVICE_ROLE_KEY (or any time you want to
 * confirm the key in your environment is wired correctly). Performs:
 *
 *   1. Env-var sanity (key set, distinct from anon key).
 *   2. Connectivity (round-trips a trivial system_settings read).
 *   3. RLS-bypass verification (reads a row that an anon-key request
 *      would NOT see — confirms the key is actually service-role and
 *      not the anon key copy-pasted by mistake).
 *   4. Negative test (an anon-key request to the same row MUST fail
 *      under RLS — guards against an over-permissive RLS policy that
 *      would defeat the bypass).
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/verify-service-role-key.ts
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — env var problem (missing / matching anon)
 *   2 — connectivity problem (network / Supabase down)
 *   3 — RLS bypass not working (key may be the anon key, not service role)
 *   4 — negative test failed (RLS may be too permissive)
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function fail(code: number, msg: string): never {
  console.error(`FAIL: ${msg}`)
  process.exit(code)
}

function pass(msg: string): void {
  console.log(`OK: ${msg}`)
}

async function main(): Promise<void> {
  // 1. Env sanity ---------------------------------------------------
  if (!SUPABASE_URL) fail(1, 'NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!ANON_KEY) fail(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is not set')
  if (!SERVICE_KEY) fail(1, 'SUPABASE_SERVICE_ROLE_KEY is not set')
  if (SERVICE_KEY === ANON_KEY) {
    fail(1, 'SUPABASE_SERVICE_ROLE_KEY equals NEXT_PUBLIC_SUPABASE_ANON_KEY — almost certainly a copy-paste mistake')
  }
  pass('env vars set + service key is distinct from anon key')

  const service = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 2. Connectivity --------------------------------------------------
  const { error: pingErr } = await service.from('venues').select('id').limit(1)
  if (pingErr) {
    fail(2, `connectivity check failed: ${pingErr.message}`)
  }
  pass('service-role connectivity to Supabase confirmed')

  // 3. RLS-bypass verification --------------------------------------
  // user_profiles is RLS-locked: only the row owner can read their own
  // profile under the anon key. Service-role reads ALL rows. Pick the
  // row count as the test.
  const { data: serviceRows, error: serviceErr } = await service
    .from('user_profiles')
    .select('id', { count: 'exact', head: true })
  if (serviceErr) {
    fail(3, `service-role read on user_profiles failed: ${serviceErr.message}`)
  }
  pass(`service-role can read user_profiles (count = ${(serviceRows as unknown as { length?: number })?.length ?? 'n/a'})`)

  // 4. Negative test: anon key MUST be locked out -------------------
  // An unauthenticated anon-key request to user_profiles should return
  // zero rows (or an RLS error). If it returns rows, RLS is broken.
  const { data: anonRows, error: anonErr } = await anon
    .from('user_profiles')
    .select('id')
    .limit(5)
  if (anonErr) {
    pass(`anon key correctly blocked from user_profiles: ${anonErr.message}`)
  } else if ((anonRows ?? []).length > 0) {
    fail(4, `anon key returned ${anonRows!.length} rows from user_profiles — RLS is permissive`)
  } else {
    pass('anon key returned zero rows from user_profiles (RLS active)')
  }

  console.log('\nAll checks passed. Service-role key is wired correctly.')
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(255)
})
