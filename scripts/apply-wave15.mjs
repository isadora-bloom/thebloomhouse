// Apply Wave 15 migration 282 (evidence overrides + discovery sources) + verify schema.
//
// Usage:
//   node scripts/apply-wave15.mjs

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

let sql = readFileSync('supabase/migrations/282_evidence_overrides.sql', 'utf8')
// exec_sql wraps the call in its own implicit txn; explicit
// BEGIN/COMMIT inside the body fails with "EXECUTE of transaction
// commands is not implemented". Strip them.
sql = sql.replace(/^\s*BEGIN\s*;\s*$/gm, '').replace(/^\s*COMMIT\s*;\s*$/gm, '')

console.log('=== Applying migration 282 ===')
const { error, data } = await sb.rpc('exec_sql', { sql })
if (error) {
  console.error('FAIL (rpc):', error.message)
  process.exit(1)
}
if (data && data.ok === false) {
  console.error('FAIL (sql):', data.error)
  console.error('  state:', data.state)
  console.error('  context:', (data.context ?? '').slice(0, 400))
  process.exit(1)
}
console.log('  applied')

console.log('\n=== Verifying schema ===')
const checks = [
  'evidence_overrides',
  'review_match_review_queue',
  'discovery_sources',
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
const { error: rerunErr, data: rerunData } = await sb.rpc('exec_sql', { sql })
if (rerunErr) {
  console.log('  ✗ re-apply (idempotent) failed:', rerunErr.message)
  fail++
} else if (rerunData && rerunData.ok === false) {
  console.log('  ✗ re-apply (idempotent) sql error:', rerunData.error)
  fail++
} else {
  console.log('  ✓ re-apply idempotent')
}

if (fail > 0) {
  console.error('\nfailures:', fail)
  process.exit(1)
}

// Deep insert test
console.log('\n=== Insert test ===')
const insertProbe = await sb.from('discovery_sources').insert({
  venue_id: 'f3d10226-4c5c-47ad-b89b-98ad63842492',
  wedding_id: '948b79a5-5954-4a07-bed4-4fdd3a7d2b95',
  capture_source: 'verify',
  question_text: 'How did you hear about us?',
  answer_text: 'ChatGPT',
  canonical_source: 'ai_tool',
  capture_ref: 'verify-' + Date.now(),
}).select('id').single()
console.log('insert result:', insertProbe)

console.log('\nALL OK')
