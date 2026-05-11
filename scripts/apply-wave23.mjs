// Apply Wave 23 migration 289 (listing_platform_patterns rename + multi-
// platform seeds) and verify the schema.
//
// Usage:
//   node scripts/apply-wave23.mjs

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
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const sql = readFileSync('supabase/migrations/289_listing_platform_patterns.sql', 'utf8')
console.log('=== Applying migration 289 ===')
const applyResult = await sb.rpc('exec_sql', { sql })
if (applyResult.error) {
  console.error('FAIL:', applyResult.error.message)
  process.exit(1)
}
// exec_sql encodes its own success/failure inside the data payload.
if (applyResult.data && applyResult.data.ok === false) {
  console.error('FAIL (rpc-level):', applyResult.data.error)
  process.exit(1)
}
console.log('  applied')

console.log('\n=== Verifying schema ===')
let fail = 0

// Force schema reload so PostgREST sees the rename.
await sb.rpc('exec_sql', { sql: "NOTIFY pgrst, 'reload schema';" })
await new Promise((r) => setTimeout(r, 3000))

// Rename successful — knot_template_patterns gone, listing_platform_patterns exists.
const { error: oldErr } = await sb.from('knot_template_patterns').select('id', { count: 'exact', head: true })
if (oldErr) {
  console.log('  ✓ knot_template_patterns has been renamed (no longer queryable)')
} else {
  console.log('  ✗ knot_template_patterns still queryable — rename did not happen')
  fail++
}

const { count: lppCount, error: lppErr } = await sb
  .from('listing_platform_patterns')
  .select('id', { count: 'exact', head: true })
if (lppErr) {
  console.log('  ✗ listing_platform_patterns:', lppErr.message)
  fail++
} else {
  console.log(`  ✓ listing_platform_patterns table exists (${lppCount} rows)`)
}

// Verify platform column populated.
const { data: byPlatform, error: bpErr } = await sb
  .from('listing_platform_patterns')
  .select('platform')
if (bpErr) {
  console.log('  ✗ platform column read:', bpErr.message)
  fail++
} else {
  const counts = {}
  for (const r of byPlatform ?? []) counts[r.platform] = (counts[r.platform] ?? 0) + 1
  console.log('  ✓ rows by platform:')
  for (const [p, c] of Object.entries(counts).sort()) console.log(`     ${p}: ${c}`)
  // Expectations: the_knot >= 18 (Wave 16 seeded), weddingwire = 2,
  // hctg = 5, brides_com = 4, zola = 4, junebug = 3, carats_cake = 3,
  // style_me_pretty = 3.
  const expected = {
    weddingwire: 2,
    hctg: 5,
    brides_com: 4,
    zola: 4,
    junebug: 3,
    carats_cake: 3,
    style_me_pretty: 3,
  }
  for (const [p, n] of Object.entries(expected)) {
    if ((counts[p] ?? 0) !== n) {
      console.log(`  ✗ expected ${n} ${p} patterns, found ${counts[p] ?? 0}`)
      fail++
    }
  }
}

// Re-run for idempotence.
console.log('\n=== Re-applying for idempotence ===')
const rerunResult = await sb.rpc('exec_sql', { sql })
if (rerunResult.error) {
  console.log('  ✗ re-apply failed:', rerunResult.error.message)
  fail++
} else if (rerunResult.data && rerunResult.data.ok === false) {
  console.log('  ✗ re-apply failed (rpc-level):', rerunResult.data.error)
  fail++
} else {
  console.log('  ✓ re-apply succeeded')
}

const { count: lppCount2 } = await sb
  .from('listing_platform_patterns')
  .select('id', { count: 'exact', head: true })
if (lppCount2 !== lppCount) {
  console.log(`  ✗ row count drifted: ${lppCount} → ${lppCount2}`)
  fail++
} else {
  console.log(`  ✓ row count stable: ${lppCount2}`)
}

if (fail > 0) {
  console.error('\nfailures:', fail)
  process.exit(1)
}
console.log('\nALL OK')
