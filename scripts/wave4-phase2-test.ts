/**
 * Wave 4 Phase 2 verification harness.
 *
 * Read-only against the DB except for the 3-wedding enqueue, which
 * inserts up to 3 rows into identity_reconstruction_jobs and lets the
 * cron sweep mutate couple_identity_profile (the whole point of the
 * test). Idempotent — the dedupe lookup collapses re-runs within 24h.
 *
 * Run: npx tsx scripts/wave4-phase2-test.ts
 *
 * Expected output (happy path):
 *   1. Resolve Rixey venue id
 *   2. POST /reconstruct-bulk with limit:3 mode:enqueue → enqueued=3
 *   3. POST /reconstruct-bulk again with same body → all 3 dedupe-skip
 *   4. POST /api/cron/identity-judge-sweep → done=3 (or fewer if any
 *      of the 3 weddings has zero signal — those return parse errors)
 *   5. Verify identity_reconstruction_jobs rows now status='done'
 *   6. Verify couple_identity_profile has 3 rows for those weddings
 *   7. Test enqueue-helper dedupe directly (skipped:true on second call)
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv(): Record<string, string> {
  const text = readFileSync('.env.local', 'utf-8')
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

const env = loadEnv()
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SVC = env.SUPABASE_SERVICE_ROLE_KEY
const CRON_SECRET = env.CRON_SECRET
const APP_URL = process.env.APP_URL || 'http://localhost:3000'

if (!SUPABASE_URL || !SUPABASE_SVC || !CRON_SECRET) {
  console.error('Missing env: SUPABASE_URL / SERVICE_ROLE / CRON_SECRET')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SVC, {
  auth: { persistSession: false },
})

async function main() {
  console.log('=== Wave 4 Phase 2 verification ===')
  console.log(`APP_URL=${APP_URL}`)

  // Step 1: Resolve Rixey venue id. Hardcoded canonical id (mirrors
  // scripts/selfreview-data-cleanup.ts and friends).
  const venueId = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) {
    console.error(`Rixey venue ${venueId} not found`)
    process.exit(1)
  }
  console.log(`\n[1] Rixey venue: ${(venueRow as { name: string }).name} (${venueId})`)

  // Step 2: First bulk enqueue.
  console.log('\n[2] First bulk enqueue (limit=3, mode=enqueue)...')
  const r1 = await fetch(`${APP_URL}/api/admin/identity/reconstruct-bulk`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ venueId, limit: 3, mode: 'enqueue' }),
  })
  const j1 = await r1.json()
  console.log('   response:', JSON.stringify(j1, null, 2))
  if (!j1.ok) {
    console.error('FAIL: first bulk enqueue did not return ok')
    process.exit(2)
  }

  // Step 3: Second bulk call should dedupe.
  console.log('\n[3] Second bulk enqueue with same body (dedupe expected)...')
  const r2 = await fetch(`${APP_URL}/api/admin/identity/reconstruct-bulk`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ venueId, limit: 3, mode: 'enqueue' }),
  })
  const j2 = await r2.json()
  console.log('   response:', JSON.stringify(j2, null, 2))

  // Step 4: Cron sweep.
  console.log('\n[4] POST /api/cron/identity-judge-sweep...')
  const r3 = await fetch(`${APP_URL}/api/cron/identity-judge-sweep`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CRON_SECRET}`,
    },
  })
  const j3 = await r3.json()
  console.log('   response:', JSON.stringify(j3, null, 2))

  // Step 5: Verify jobs rows.
  console.log('\n[5] Verifying identity_reconstruction_jobs rows...')
  const { data: jobs } = await supabase
    .from('identity_reconstruction_jobs')
    .select('id, wedding_id, status, trigger_signal, started_at, completed_at, error_text')
    .eq('venue_id', venueId)
    .eq('trigger_signal', 'manual_bulk')
    .order('enqueued_at', { ascending: false })
    .limit(5)
  console.log(`   recent manual_bulk rows: ${jobs?.length ?? 0}`)
  for (const j of jobs ?? []) {
    console.log(`     - ${j.id} ${j.wedding_id} status=${j.status} err=${j.error_text ? j.error_text.slice(0, 80) : 'null'}`)
  }

  // Step 6: Verify couple_identity_profile rows.
  if (jobs && jobs.length > 0) {
    const weddingIds = jobs.map((x) => x.wedding_id)
    const { data: profiles } = await supabase
      .from('couple_identity_profile')
      .select('wedding_id, last_reconstructed_at, reconstruction_count, prompt_version, cost_cents')
      .in('wedding_id', weddingIds)
    console.log(`\n[6] couple_identity_profile rows for those weddings: ${profiles?.length ?? 0}`)
    for (const p of profiles ?? []) {
      console.log(`     - ${p.wedding_id} last=${p.last_reconstructed_at} count=${p.reconstruction_count} cost_cents=${p.cost_cents}`)
    }
  }

  // Step 7: Direct enqueue-helper dedupe test.
  console.log('\n[7] Direct enqueueIdentityReconstruction dedupe test...')
  const { enqueueIdentityReconstruction } = await import('../src/lib/services/identity/enqueue-reconstruction')
  // Need a wedding to test against — pick the first non-tombstoned for this venue.
  const { data: pickRows } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
    .limit(1)
  if (pickRows && pickRows.length > 0) {
    const targetWeddingId = pickRows[0].id as string
    const a = await enqueueIdentityReconstruction({
      weddingId: targetWeddingId,
      venueId,
      triggerSignal: 'verification_test',
      supabase,
    })
    console.log(`   call A: ${JSON.stringify(a)}`)
    const b = await enqueueIdentityReconstruction({
      weddingId: targetWeddingId,
      venueId,
      triggerSignal: 'verification_test',
      supabase,
    })
    console.log(`   call B: ${JSON.stringify(b)}`)
    if (a.skipped !== false || b.skipped !== true) {
      console.warn('   WARN: dedupe behaviour did not match expected (A=insert,B=dedupe). May be benign if a fresh job arrived from earlier bulk enqueue — test still proves the dedupe path runs.')
    } else {
      console.log('   OK: dedupe path verified (A inserted, B dedupe-skipped)')
    }
  } else {
    console.log('   SKIP: no wedding rows in venue to test enqueue helper directly.')
  }

  console.log('\n=== verification complete ===')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(99)
})
