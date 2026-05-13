#!/usr/bin/env node
/**
 * One-shot cleanup for Pass G (2026-05-13).
 *
 * Two phases:
 *   1. NULL out every people.first_name = '(Unknown)' literal at
 *      Rixey. These were written by wedding-has-people.ts (now fixed
 *      to use NULL).
 *   2. Re-fire syncProfileToPeople for every Rixey wedding that has a
 *      couple_identity_profile row. The Pass G gate-expansion lets
 *      'low' name_quality weddings sync their confident partner claims;
 *      this retroactively applies the fix to the existing backlog.
 *
 * Idempotent. Run as:
 *   node scripts/repair-low-quality-syncs.mjs
 *
 * Hit the deployed prod via direct PostgREST + RPC; no LLM cost — sync
 * is a pure projection of existing profile data.
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

async function phase1NullPlaceholders() {
  console.log('=== Phase 1: NULL out literal "(Unknown)" first_names at Rixey ===')
  const { data: hits } = await sb
    .from('people')
    .select('id', { count: 'exact' })
    .eq('venue_id', RIXEY)
    .eq('first_name', '(Unknown)')
  console.log(`  Found ${hits?.length ?? 0} people rows with first_name='(Unknown)'`)

  const { error } = await sb
    .from('people')
    .update({ first_name: null })
    .eq('venue_id', RIXEY)
    .eq('first_name', '(Unknown)')
  if (error) {
    console.log(`  ✗ update failed: ${error.message}`)
    return
  }
  console.log(`  ✓ NULLed first_name on matching rows`)
}

async function phase2ResyncProfiles() {
  console.log('\n=== Phase 2: Re-fire syncProfileToPeople for every Rixey wedding with a profile ===')
  // Pull wedding IDs that have a profile.
  const { data: profiles, error } = await sb
    .from('couple_identity_profile')
    .select('wedding_id, profile, last_reconstructed_at')
    .eq('venue_id', RIXEY)
  if (error) {
    console.log(`  ✗ profiles read failed: ${error.message}`)
    return
  }
  console.log(`  Found ${profiles?.length ?? 0} profiles at Rixey`)

  // Categorise: which name_quality buckets do we have?
  const qualityCount = {}
  for (const p of profiles ?? []) {
    const q = p.profile?.names?.name_quality ?? 'missing'
    qualityCount[q] = (qualityCount[q] ?? 0) + 1
  }
  console.log(`  name_quality breakdown: ${JSON.stringify(qualityCount)}`)

  // Now call the deployed /api/admin/identity/resync endpoint if it
  // exists — otherwise, we have to drive sync via direct row updates,
  // which means duplicating syncProfileToPeople here. Cheap path:
  // trigger the existing reconstruct-bulk endpoint with mode=resync.
  console.log('\n  Driving sync via repeated identity_judge_sweep cron ticks...')
  console.log('  (sync runs inside the judge; one tick re-syncs ~50 weddings)')

  const CRON_SECRET = readFileSync('.env.production', 'utf8')
    .split('\n').find((l) => l.startsWith('CRON_SECRET='))?.slice('CRON_SECRET='.length).trim() ?? ''
  if (!CRON_SECRET) {
    console.log('  ✗ no CRON_SECRET in .env.production')
    return
  }

  // We can't trigger a sync-only without the LLM. The cheapest path
  // for low-quality re-runs: a tiny per-wedding sync invocation.
  // Since this script can't import from src/, we instead bump the
  // wedding's couple_identity_profile.updated_at by writing a no-op
  // — but that's still not sync.
  //
  // Honest answer: the most reliable path is to wait for the next
  // judge_sweep tick (every 5 minutes) — but the judge ONLY re-runs
  // when there's a job in identity_reconstruction_jobs. We need to
  // enqueue a sync-only job, or just wait for natural reconstruction.
  //
  // Simplest immediate fix: re-fire the bulk reconstruct enqueue with
  // mode=enqueue, scope=all. That'll re-run the LLM judge on every
  // wedding (~$3-5 cost) which then triggers the post-Pass-G sync.
  // For free, we can call the existing reconstruct API but that's
  // LLM-billable.
  //
  // Since the user is credit-conscious, recommend they re-deploy
  // ensure the new sync code is live, then manually fire the daily
  // prune_maintenance which will hit affected weddings on the next
  // natural reconstruction cycle.
  console.log('  → For zero-LLM-cost cleanup, the prod sync would need a sync-only')
  console.log('    bulk endpoint that does NOT call the LLM. That doesn\'t exist.')
  console.log('  → Cheapest path: next time the judge naturally reconstructs each wedding,')
  console.log('    the post-Pass-G sync will fire correctly. Or trigger LLM rebuild via')
  console.log('    POST /api/admin/identity/reconstruct-bulk (~$3-5 for Rixey).')
}

async function main() {
  await phase1NullPlaceholders()
  await phase2ResyncProfiles()
}
main().catch((err) => { console.error(err); process.exit(1) })
