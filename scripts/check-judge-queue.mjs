#!/usr/bin/env node
/**
 * Read-only inspection of identity_reconstruction_jobs.
 * Zero LLM cost. Just counts.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[m[1]] = v
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Total by status
const statuses = ['pending', 'queued', 'in_progress', 'running', 'failed', 'completed', 'done', 'paused']
console.log('=== identity_reconstruction_jobs by status (all venues) ===')
for (const status of statuses) {
  const { count, error } = await sb
    .from('identity_reconstruction_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('status', status)
  if (error) {
    if (!error.message.includes('does not exist')) console.log(`  ${status}: err ${error.message}`)
    continue
  }
  if ((count ?? 0) > 0) console.log(`  ${status}: ${count}`)
}

// What statuses actually exist?
const { data: distinctStatuses } = await sb
  .from('identity_reconstruction_jobs')
  .select('status')
  .limit(2000)
const seen = new Set((distinctStatuses ?? []).map(r => r.status))
console.log(`\nDistinct status values seen in sample: ${[...seen].join(', ')}`)

// Rixey breakdown
console.log('\n=== Rixey only ===')
for (const status of [...seen]) {
  const { count } = await sb
    .from('identity_reconstruction_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .eq('status', status)
  if ((count ?? 0) > 0) console.log(`  ${status}: ${count}`)
}

// Recently enqueued
const { data: recent } = await sb
  .from('identity_reconstruction_jobs')
  .select('id, status, venue_id, created_at, started_at, completed_at, wedding_id, reason')
  .eq('venue_id', RIXEY)
  .order('created_at', { ascending: false })
  .limit(5)
console.log(`\nMost recent 5 Rixey jobs:`)
for (const j of recent ?? []) {
  console.log(`  ${j.created_at} | ${j.status} | wed=${j.wedding_id?.slice(0, 8)} | reason=${j.reason ?? '—'}`)
}
