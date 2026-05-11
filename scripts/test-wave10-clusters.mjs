/**
 * Wave 10 smoke test — verifies the clusterer + audit table against Rixey.
 *
 * Usage:
 *   node --env-file=.env.local scripts/test-wave10-clusters.mjs
 *
 * Checks:
 *   1. identity_decision_clusters table exists and is readable
 *   2. handle_merge_decisions table is readable for Rixey
 *   3. Cluster proposals for Rixey are computable
 *   4. Optionally simulate a cluster decision (write + read back)
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// Load env
const env = { ...process.env }
try {
  const raw = readFileSync('.env.local', 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// 1. Find Rixey venue
const { data: venues } = await sb
  .from('venues')
  .select('id, name')
  .ilike('name', '%rixey%')
  .limit(5)
console.log('Venues matching rixey:', venues)
const rixey = venues?.[0]
if (!rixey) {
  console.log('No Rixey venue found.')
  process.exit(0)
}

console.log('\n=== Wave 10 smoke test — venue:', rixey.id, '(' + rixey.name + ') ===\n')

// 2. Confirm the new table exists
{
  const { count, error } = await sb
    .from('identity_decision_clusters')
    .select('id', { count: 'exact', head: true })
  console.log('[1] identity_decision_clusters total rows:', count, error?.message ?? 'ok')
}

// 3. Existing handle decisions
{
  const { count, data } = await sb
    .from('handle_merge_decisions')
    .select('id, handle_normalised, decision, decided_at', { count: 'exact' })
    .eq('venue_id', rixey.id)
    .order('decided_at', { ascending: false })
    .limit(5)
  console.log('[2] handle_merge_decisions for Rixey:', count, 'rows. Latest 5:', data)
}

// 4. People + candidates volume that feeds the clusterer
{
  const { count: peopleCount } = await sb
    .from('people')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', rixey.id)
    .is('merged_into_id', null)
    .not('platform_handles', 'is', null)
  console.log('[3] People with platform_handles:', peopleCount)

  const { count: candCount } = await sb
    .from('candidate_identities')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', rixey.id)
    .is('resolved_wedding_id', null)
    .not('username', 'is', null)
  console.log('[4] Unresolved candidates with username:', candCount)
}

// 5. Write a synthetic cluster decision audit row to verify the write
//    path works end-to-end; then delete it.
{
  const syntheticKey = `wave10-smoke-${Date.now()}`
  const { data: inserted, error: insertErr } = await sb
    .from('identity_decision_clusters')
    .insert({
      venue_id: rixey.id,
      cluster_key: syntheticKey,
      canonical_person_id: null,
      handles_involved: [
        { handle: 'synthetic-a', platforms: ['gmail'], score: 80, recordCount: 2, reasoning: ['smoke'], mixed: false },
        { handle: 'synthetic-b', platforms: ['knot'], score: 75, recordCount: 1, reasoning: ['smoke'], mixed: false },
      ],
      total_records: 3,
      aggregate_score: 88,
      decision: 'deferred',
      decision_note: 'wave10 smoke test',
      applied_handle_merges: [],
      decided_by: null,
    })
    .select('id')
    .single()
  if (insertErr) {
    console.log('[5] insert synthetic row FAILED:', insertErr.message)
  } else {
    console.log('[5] insert synthetic row ok, id:', inserted.id)
    const { data: readBack } = await sb
      .from('identity_decision_clusters')
      .select('id, cluster_key, decision, aggregate_score, handles_involved')
      .eq('id', inserted.id)
      .single()
    console.log('[6] read-back:', JSON.stringify(readBack, null, 2))
    // Clean up.
    await sb.from('identity_decision_clusters').delete().eq('id', inserted.id)
    console.log('[7] synthetic row cleaned up')
  }
}

console.log('\n=== Smoke test complete ===')
