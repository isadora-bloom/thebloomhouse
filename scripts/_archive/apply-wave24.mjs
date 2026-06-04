// Apply Wave 24 migration 290 (channel_truth_audits) and verify the
// schema. Mirrors apply-wave23.mjs.
//
// Usage:
//   node scripts/apply-wave24.mjs

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

// exec_sql cannot run BEGIN/COMMIT — strip them so the body runs as a
// single statement-batch. The whole migration body is idempotent
// anyway.
const rawSql = readFileSync('supabase/migrations/290_channel_truth_audits.sql', 'utf8')
const sql = rawSql
  .replace(/^\s*BEGIN\s*;\s*$/gim, '-- BEGIN stripped for exec_sql')
  .replace(/^\s*COMMIT\s*;\s*$/gim, '-- COMMIT stripped for exec_sql')
console.log('=== Applying migration 290 ===')
const applyResult = await sb.rpc('exec_sql', { sql })
if (applyResult.error) {
  console.error('FAIL:', applyResult.error.message)
  process.exit(1)
}
if (applyResult.data && applyResult.data.ok === false) {
  console.error('FAIL (rpc-level):', applyResult.data.error)
  process.exit(1)
}
console.log('  applied')

console.log('\n=== Verifying schema ===')
let fail = 0

await sb.rpc('exec_sql', { sql: "NOTIFY pgrst, 'reload schema';" })
await new Promise((r) => setTimeout(r, 2000))

const { count, error: cErr } = await sb
  .from('channel_truth_audits')
  .select('id', { count: 'exact', head: true })
if (cErr) {
  console.log('  ✗ channel_truth_audits:', cErr.message)
  fail++
} else {
  console.log(`  ✓ channel_truth_audits table exists (${count} rows)`)
}

// Re-run for idempotence.
console.log('\n=== Re-applying for idempotence ===')
const rerun = await sb.rpc('exec_sql', { sql })
if (rerun.error) {
  console.log('  ✗ re-apply failed:', rerun.error.message)
  fail++
} else if (rerun.data && rerun.data.ok === false) {
  console.log('  ✗ re-apply failed (rpc-level):', rerun.data.error)
  fail++
} else {
  console.log('  ✓ re-apply succeeded')
}

const { count: count2 } = await sb
  .from('channel_truth_audits')
  .select('id', { count: 'exact', head: true })
if (count2 !== count) {
  console.log(`  ✗ row count drifted: ${count} → ${count2}`)
  fail++
} else {
  console.log(`  ✓ row count stable: ${count2}`)
}

if (fail > 0) {
  console.error('\nfailures:', fail)
  process.exit(1)
}
console.log('\nALL OK')
