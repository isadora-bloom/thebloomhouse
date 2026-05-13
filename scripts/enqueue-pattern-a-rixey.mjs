#!/usr/bin/env node
/**
 * Pattern A backfill (Step 5d / 2026-05-13). Bulk-enqueues Wave 4
 * identity reconstruction for every Rixey wedding without a
 * couple_identity_profile row. Mirrors what the
 * /api/admin/identity/reconstruct-bulk endpoint does with
 * mode='enqueue' + onlyMissingProfile=true, but runs directly via
 * the service role so we don't need a deployed URL.
 *
 * 24h dedupe on identity_reconstruction_jobs handles re-runs
 * gracefully — calling this twice in a row is a no-op.
 *
 * After enqueue, the identity_judge_sweep cron (every 5 min) picks
 * jobs up and reconstructs profiles. Profile→people sync then
 * populates partner1 first_name from the LLM-judged truth.
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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const { data: venue } = await sb
  .from('venues')
  .select('id, name')
  .ilike('name', '%rixey%')
  .limit(1)
  .maybeSingle()
if (!venue) {
  console.error('Rixey not found')
  process.exit(1)
}
console.log(`Venue: ${venue.name}`)

// 1. Pull all non-tombstoned weddings.
const { data: weddings } = await sb
  .from('weddings')
  .select('id, venue_id')
  .eq('venue_id', venue.id)
  .is('merged_into_id', null)
  .is('non_couple_at', null)
  .limit(2000)
console.log(`Active weddings: ${weddings?.length ?? 0}`)

// 2. Pull every wedding_id that already has a profile.
const { data: profiles } = await sb
  .from('couple_identity_profile')
  .select('wedding_id')
  .eq('venue_id', venue.id)
  .limit(5000)
const profiled = new Set((profiles ?? []).map((p) => p.wedding_id))
console.log(`Already have profile: ${profiled.size}`)

const unprofiled = (weddings ?? []).filter((w) => !profiled.has(w.id))
console.log(`Pattern A (no profile): ${unprofiled.length}`)
if (unprofiled.length === 0) process.exit(0)

// 3. Pull recent identity_reconstruction_jobs to dedupe — anything
// queued or running in the last 24h is already in flight.
const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
const { data: activeJobs } = await sb
  .from('identity_reconstruction_jobs')
  .select('wedding_id, status')
  .in('wedding_id', unprofiled.map((w) => w.id))
  .in('status', ['queued', 'running'])
  .gte('enqueued_at', since)
  .limit(5000)
const activeSet = new Set((activeJobs ?? []).map((j) => j.wedding_id))
console.log(`Already active jobs: ${activeSet.size}`)

const toEnqueue = unprofiled.filter((w) => !activeSet.has(w.id))
console.log(`To enqueue: ${toEnqueue.length}`)

// 4. Bulk insert. The table has FK constraints on venue_id +
// wedding_id, so a single INSERT … VALUES batch works.
let inserted = 0
const BATCH = 50
for (let i = 0; i < toEnqueue.length; i += BATCH) {
  const slice = toEnqueue.slice(i, i + BATCH)
  const rows = slice.map((w) => ({
    wedding_id: w.id,
    venue_id: w.venue_id,
    status: 'queued',
    trigger_signal: 'manual_pattern_a_backfill',
  }))
  const { data, error } = await sb
    .from('identity_reconstruction_jobs')
    .insert(rows)
    .select('id')
  if (error) {
    console.warn(`  batch ${i}-${i + slice.length} failed: ${error.message}`)
    continue
  }
  inserted += data?.length ?? 0
  if ((i + BATCH) % 200 === 0 || i + BATCH >= toEnqueue.length) {
    console.log(`  progress: ${Math.min(i + BATCH, toEnqueue.length)}/${toEnqueue.length} (inserted=${inserted})`)
  }
}

console.log(`\n=== Done ===`)
console.log(`  enqueued: ${inserted}`)
console.log(`\nThe identity_judge_sweep cron runs every 5 min. Profiles will appear over the next ~30 minutes.`)
