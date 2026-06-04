// Apply Wave 18 migration 285 (prediction_calibration) + verify schema.
//
// Usage:
//   node scripts/apply-wave18.mjs

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

const sql = readFileSync('supabase/migrations/285_prediction_calibration.sql', 'utf8')
console.log('=== Applying migration 285 ===')
const { error } = await sb.rpc('exec_sql', { sql })
if (error) {
  console.error('FAIL:', error.message)
  process.exit(1)
}
console.log('  applied')

console.log('\n=== Verifying schema ===')
const checks = ['prediction_snapshots', 'prediction_outcomes', 'measure_outcome_jobs']
let fail = 0
for (const t of checks) {
  const { error: e } = await sb.from(t).select('id', { count: 'exact', head: true })
  if (e) {
    console.log('  X', t, ':', e.message)
    fail++
  } else {
    console.log('  OK', t)
  }
}

// Re-running on second apply should be a no-op (idempotent guard).
const { error: rerunErr } = await sb.rpc('exec_sql', { sql })
if (rerunErr) {
  console.log('  X re-apply (idempotent) failed:', rerunErr.message)
  fail++
} else {
  console.log('  OK re-apply idempotent')
}

if (fail > 0) {
  console.error('\nfailures:', fail)
  process.exit(1)
}
console.log('\nALL OK')
