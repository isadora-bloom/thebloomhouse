#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const envContent = readFileSync('.env.local', 'utf8')
const env = {}
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let value = m[2]
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  env[m[1]] = value
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// Probe: does the table exist? Use head=true to skip data fetch.
const { count, error } = await sb
  .from('mint_wedding_telemetry')
  .select('id', { count: 'exact', head: true })

if (error) {
  console.log('Table does not exist or RLS-denied:', error.code, error.message)
  process.exit(0)
}

console.log('Table exists. Row count:', count)

// Probe: try a test insert to verify write path. Roll back via DELETE.
const testId = `soak-test-${Date.now()}`
const { error: insErr } = await sb.from('mint_wedding_telemetry').insert({
  venue_id: null,
  source: 'manual_admin',
  reason: testId,
  resolved_via: 'created_new',
  wedding_id: null,
  person_id: null,
  is_new_wedding: null,
  is_new_person: null,
  latency_ms: 0,
  errored: false,
  error_message: null,
  correlation_id: null,
})
if (insErr) {
  console.log('Insert failed:', insErr.message)
  console.log('  Schema likely requires non-null fields. Inspecting:')
  // Try a simpler insert
  const { error: simpleErr } = await sb.from('mint_wedding_telemetry').insert({
    source: 'manual_admin',
    reason: testId,
    errored: false,
  })
  console.log('  simpler insert:', simpleErr ? simpleErr.message : 'OK')
} else {
  console.log('Insert OK.')
  await sb.from('mint_wedding_telemetry').delete().eq('reason', testId)
  console.log('Test row deleted.')
}
