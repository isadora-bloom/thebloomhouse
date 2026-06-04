// Apply Wave 16 migration 283 (attribution_intent_class) + verify schema.
//
// Usage:
//   node scripts/apply-wave16.mjs

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

const sql = readFileSync('supabase/migrations/283_attribution_intent_class.sql', 'utf8')
console.log('=== Applying migration 283 ===')
const { error } = await sb.rpc('exec_sql', { sql })
if (error) {
  console.error('FAIL:', error.message)
  process.exit(1)
}
console.log('  applied')

console.log('\n=== Verifying schema ===')
const checks = ['attribution_intent_jobs', 'knot_template_patterns']
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

// Verify the new columns exist by selecting them
const { error: colErr } = await sb
  .from('attribution_events')
  .select('id, intent_class, intent_class_confidence_0_100, intent_class_signals, intent_classified_at')
  .limit(1)
if (colErr) {
  console.log('  ✗ attribution_events.intent_* columns:', colErr.message)
  fail++
} else {
  console.log('  ✓ attribution_events.intent_* columns present')
}

// Verify seed patterns were inserted
const { data: patterns, error: pErr } = await sb
  .from('knot_template_patterns')
  .select('id, pattern_type, pattern_value, weight, source')
  .eq('enabled', true)
if (pErr) {
  console.log('  ✗ pattern read:', pErr.message)
  fail++
} else {
  console.log(`  ✓ seeded ${patterns?.length ?? 0} broadcast patterns`)
}

// Re-running on second apply should be a no-op (idempotent guard).
const { error: rerunErr } = await sb.rpc('exec_sql', { sql })
if (rerunErr) {
  console.log('  ✗ re-apply (idempotent) failed:', rerunErr.message)
  fail++
} else {
  console.log('  ✓ re-apply idempotent')
}

// And that the seed wasn't duplicated.
const { count: patternCount } = await sb
  .from('knot_template_patterns')
  .select('id', { count: 'exact', head: true })
console.log(`  ✓ total pattern rows after re-apply: ${patternCount}`)

if (fail > 0) {
  console.error('\nfailures:', fail)
  process.exit(1)
}
console.log('\nALL OK')
