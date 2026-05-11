// Apply Wave 20 migration 287 (voice_dna_derivations + voice_dna_jobs).
// Uses run-migration.ts internally for proper per-statement application.
// Usage: node scripts/apply-wave20.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

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

console.log('=== Applying migration 287 (delegating to run-migration.ts) ===')
const r = spawnSync('node', [
  '--env-file=.env.local',
  'node_modules/tsx/dist/cli.mjs',
  'scripts/run-migration.ts',
  'supabase/migrations/287_voice_dna_derivations.sql',
], { stdio: 'inherit' })
if (r.status !== 0) {
  console.error('migration failed')
  process.exit(1)
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Force PostgREST schema cache reload.
await sb.rpc('exec_sql', { sql: "NOTIFY pgrst, 'reload schema';" })

console.log('\n=== Verifying physical existence via SQL ===')
const tables = ['voice_dna_derivations', 'voice_dna_jobs']
let fail = 0
for (const t of tables) {
  const { data, error } = await sb.rpc('exec_sql', {
    sql: `SELECT 1 FROM public.${t} LIMIT 0;`,
  })
  if (error || (data && !data.ok)) {
    console.log('  X', t, ':', data?.error ?? error?.message)
    fail++
  } else {
    console.log('  +', t)
  }
}

if (fail > 0) {
  console.error('\nfailures:', fail)
  process.exit(1)
}

// Idempotency: re-apply must succeed and create no duplicates.
console.log('\n=== Idempotency re-check ===')
const r2 = spawnSync('node', [
  '--env-file=.env.local',
  'node_modules/tsx/dist/cli.mjs',
  'scripts/run-migration.ts',
  'supabase/migrations/287_voice_dna_derivations.sql',
], { stdio: 'inherit' })
if (r2.status !== 0) {
  console.error('re-apply failed (NOT idempotent)')
  process.exit(1)
}
console.log('\n+ idempotent re-apply OK')

console.log('\nALL OK')
