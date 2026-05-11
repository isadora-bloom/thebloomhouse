// Apply Wave 13 migration 281 (tour-prep briefs + review solicit) + verify schema.
//
// Usage:
//   node scripts/apply-wave13.mjs

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

const sql = readFileSync('supabase/migrations/281_tour_prep_review_solicit.sql', 'utf8')
console.log('=== Applying migration 281 ===')
const { error } = await sb.rpc('exec_sql', { sql })
if (error) {
  console.error('FAIL:', error.message)
  process.exit(1)
}
console.log('  applied')

console.log('\n=== Verifying schema ===')
const checks = [
  'tour_prep_briefs',
  'tour_prep_jobs',
  'post_tour_followup_jobs',
  'review_solicit_requests',
  'review_solicit_jobs',
]
let fail = 0
for (const t of checks) {
  const { error: e } = await sb.from(t).select('id', { count: 'exact', head: true })
  if (e) {
    console.log('  ✗', t, ':', e.message)
    fail++
  } else {
    console.log('  ✓', t)
  }
}

// Re-running on second apply should be a no-op (idempotent guard).
const { error: rerunErr } = await sb.rpc('exec_sql', { sql })
if (rerunErr) {
  console.log('  ✗ re-apply (idempotent) failed:', rerunErr.message)
  fail++
} else {
  console.log('  ✓ re-apply idempotent')
}

// Verify reviews.wedding_id (used by reconciliation + state-machine reviewExists)
const { error: rwErr } = await sb.from('reviews').select('id, wedding_id').limit(1)
console.log(rwErr ? '  ✗ reviews.wedding_id: ' + rwErr.message : '  ✓ reviews.wedding_id')
if (rwErr) fail++

if (fail > 0) {
  console.error('\nfailures:', fail)
  process.exit(1)
}
console.log('\nALL OK')
