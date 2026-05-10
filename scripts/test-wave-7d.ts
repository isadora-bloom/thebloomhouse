/**
 * Wave 7D smoke test — feedback loop + digest.
 *
 * 1. Asserts applyDiscoveryFeedback gates correctly on a non-validated
 *    discovery (returns { actionsApplied: 0, errors: ['discovery not validated'] }).
 * 2. For each known hypothesis_category, creates a synthetic VALIDATED
 *    discovery, fires applyDiscoveryFeedback, and confirms the mapping
 *    wrote to the correct target_system.
 * 3. Builds the discovery digest for Rixey.
 * 4. Cleans up synthetic discoveries.
 *
 * Run with: npx tsx scripts/test-wave-7d.ts
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv(): Record<string, string> {
  try {
    const text = readFileSync('.env.local', 'utf-8')
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      out[key] = val
    }
    return out
  } catch {
    return {}
  }
}

// Hoist .env.local into process.env BEFORE any module import runs
// (so callAI, createServiceClient, etc., see the keys).
const fileEnv = loadEnv()
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] === undefined) process.env[k] = v
}

const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  'https://jsxxgwprxuqgcauzlxcb.supabase.co'
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
if (!serviceKey) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY in env')
  process.exit(1)
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const KNOT_DISCOVERY_ID = 'eccae892-20e9-47c6-b89f-c4f246123c5b'
const RIXEY_VENUE_ID = 'a1e9c8b8-1234-4567-89ab-cdef01234567' // placeholder if not found

async function findRixeyVenueId(): Promise<string | null> {
  const { data } = await supabase
    .from('venues')
    .select('id, name')
    .ilike('name', '%rixey%')
    .limit(1)
    .maybeSingle()
  return (data as { id?: string } | null)?.id ?? null
}

async function main() {
  console.log('=== Wave 7D smoke test ===\n')

  // Resolve Rixey venue.
  const rixeyId = await findRixeyVenueId()
  if (!rixeyId) {
    console.error('Could not find Rixey venue — aborting')
    process.exit(1)
  }
  console.log(`Rixey venue id: ${rixeyId}\n`)

  // Module imports (after env is set).
  const { applyDiscoveryFeedback, getKnownFeedbackCategories } = await import(
    '../src/lib/services/intel/discovery/feedback-loop'
  )
  const { buildDiscoveryDigest } = await import(
    '../src/lib/services/intel/discovery/discovery-digest'
  )

  // -----------------------------------------------------------------------
  // 1. Knot-discovery gating test
  // -----------------------------------------------------------------------
  console.log('--- Test 1: Knot-discovery gating ---')
  const { data: knotRow } = await supabase
    .from('intel_discoveries')
    .select('id, validation_status, hypothesis_title, hypothesis_category')
    .eq('id', KNOT_DISCOVERY_ID)
    .maybeSingle()
  if (!knotRow) {
    console.warn(`Knot discovery ${KNOT_DISCOVERY_ID} not found; skipping gating test`)
  } else {
    const r = knotRow as {
      id: string
      validation_status: string
      hypothesis_title: string
      hypothesis_category: string
    }
    console.log(
      `  Knot discovery: status=${r.validation_status}, category=${r.hypothesis_category}`,
    )
    const result = await applyDiscoveryFeedback({
      discoveryId: KNOT_DISCOVERY_ID,
      supabase: supabase as unknown as Parameters<typeof applyDiscoveryFeedback>[0]['supabase'],
    })
    console.log(`  applyDiscoveryFeedback → ${JSON.stringify(result)}`)
    if (r.validation_status !== 'validated') {
      const ok = result.actionsApplied === 0 && result.errors.includes('discovery not validated')
      console.log(`  GATING: ${ok ? 'PASS' : 'FAIL'} (expected actionsApplied=0 + errors=['discovery not validated'])`)
    } else {
      console.log(`  Knot discovery is validated — gating test does not apply, real feedback ran instead`)
    }
  }
  console.log()

  // -----------------------------------------------------------------------
  // 2. Mapping coverage test
  // -----------------------------------------------------------------------
  console.log('--- Test 2: Mapping coverage ---')
  const knownCats = getKnownFeedbackCategories()
  console.log(`  Known categories: ${knownCats.join(', ')}\n`)

  const evidenceFor = (cat: string): Record<string, unknown> => {
    // Build minimal evidence_summary that the mapping handler can extract
    // the fields it needs from. Each handler probes specific fields.
    const base = {
      signal_type: cat,
      n_couples: 5,
      n_evidence_points: 10,
      key_observations: ['synthetic test fixture'],
      aggregate_stats: {
        affected_channel: 'theknot',
        vendor_name: 'test_vendor',
        persona_label: 'test_persona',
        competitor_name: 'test_competitor',
        pattern: 'test_pattern_string',
        cohort_segment: 'test_cohort_segment',
      },
    }
    return base
  }

  const createdIds: string[] = []
  const results: Array<{ category: string; targetSystems: string[]; actionTypes: string[]; errors: string[] }> = []

  // Include 'tag_only' fallback by adding a fake category that's NOT known.
  const testCategories = [...knownCats, 'invented_category_xyz']

  for (const cat of testCategories) {
    // Insert a synthetic validated discovery row.
    const { data: inserted, error: insErr } = await supabase
      .from('intel_discoveries')
      .insert({
        venue_id: rixeyId,
        hypothesis_title: `[wave7d test] ${cat}`,
        hypothesis_text: `Synthetic test fixture for category ${cat}`,
        hypothesis_category: cat,
        evidence_summary: evidenceFor(cat),
        recommended_test: 'synthetic — never run',
        recommended_action_if_validated: 'synthetic — never act',
        confidence_0_100: 75,
        validation_status: 'validated',
        validated_at: new Date().toISOString(),
        validation_runs_count: 1,
        prompt_version: 'wave7d-test.v1',
      })
      .select('id')
      .single()

    if (insErr || !inserted) {
      console.error(`  [${cat}] FAILED to insert synthetic: ${insErr?.message}`)
      continue
    }
    const id = (inserted as { id: string }).id
    createdIds.push(id)

    // Fire feedback.
    let result: { actionsApplied: number; errors: string[] }
    try {
      result = await applyDiscoveryFeedback({
        discoveryId: id,
        supabase: supabase as unknown as Parameters<typeof applyDiscoveryFeedback>[0]['supabase'],
      })
    } catch (err) {
      console.error(`  [${cat}] applyDiscoveryFeedback threw: ${err instanceof Error ? err.message : err}`)
      continue
    }

    // Read audit log.
    const { data: actions } = await supabase
      .from('discovery_feedback_actions')
      .select('target_system, action_type, error')
      .eq('discovery_id', id)
    const actionRows = (actions ?? []) as Array<{
      target_system: string
      action_type: string
      error: string | null
    }>

    const targetSystems = Array.from(new Set(actionRows.map((a) => a.target_system)))
    const actionTypes = Array.from(new Set(actionRows.map((a) => a.action_type)))
    results.push({
      category: cat,
      targetSystems,
      actionTypes,
      errors: result.errors,
    })

    console.log(
      `  [${cat}] actionsApplied=${result.actionsApplied} | targets=[${targetSystems.join(', ')}] | types=[${actionTypes.join(', ')}] | errors=${result.errors.length}`,
    )
  }

  console.log()

  // Verify each known category mapped to a non-empty audit row set.
  const expectedPrimaryTargets: Record<string, string> = {
    channel_role_distortion: 'attribution_role_jobs',
    vendor_referral_unobserved: 'venue_intel.service_demand_map',
    persona_channel_pattern: 'marketing_recommendations',
    cross_platform_drift: 'handle_merge_review_flag',
    competitor_positioning: 'intel_matches',
    stale_warm_lead: 'couple_intel',
    booking_blocker_question: 'venue_intel.timing_patterns',
    time_of_day_pattern: 'venue_intel.timing_patterns',
    demographic_clustering: 'venue_intel.over_indexed_personas',
  }

  let mappingPass = 0
  let mappingFail = 0
  for (const cat of knownCats) {
    const r = results.find((x) => x.category === cat)
    const expected = expectedPrimaryTargets[cat]
    const ok =
      r != null &&
      ((expected && r.targetSystems.includes(expected)) ||
        (!expected && r.targetSystems.length > 0))
    if (ok) mappingPass += 1
    else mappingFail += 1
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} ${cat} → expected ${expected} | got [${(r?.targetSystems ?? []).join(', ')}]`,
    )
  }
  // tag_only fallback expectation
  const taggedRow = results.find((x) => x.category === 'invented_category_xyz')
  const tagOk =
    taggedRow != null && taggedRow.targetSystems.includes('tag_only')
  console.log(`  ${tagOk ? 'PASS' : 'FAIL'} invented_category_xyz → expected tag_only | got [${(taggedRow?.targetSystems ?? []).join(', ')}]`)
  console.log(`  Mapping coverage: ${mappingPass}/${knownCats.length} known + ${tagOk ? 1 : 0}/1 tag_only fallback\n`)

  // Cleanup synthetic rows.
  if (createdIds.length > 0) {
    const { error: cleanupErr } = await supabase
      .from('intel_discoveries')
      .delete()
      .in('id', createdIds)
    if (cleanupErr) {
      console.warn(`  cleanup error: ${cleanupErr.message}`)
    } else {
      console.log(`  Cleaned up ${createdIds.length} synthetic discoveries`)
    }
  }
  console.log()

  // -----------------------------------------------------------------------
  // 3. Discovery digest test
  // -----------------------------------------------------------------------
  console.log('--- Test 3: Discovery digest for Rixey ---')
  let digestId: string | null = null
  try {
    const r = await buildDiscoveryDigest(rixeyId, {
      supabase: supabase as unknown as Parameters<typeof buildDiscoveryDigest>[1] extends { supabase?: infer S } ? S : never,
    })
    digestId = r.digestId
    console.log(`  digestId: ${r.digestId}`)
    console.log(`  costCents: ${r.costCents.toFixed(4)}`)
    console.log(`  promptVersion: ${r.promptVersion}`)
    console.log(`  period: ${r.periodStart} → ${r.periodEnd}`)
    console.log(`  diagnostics: ${JSON.stringify(r.diagnostics)}`)
    console.log(`  headline: ${r.digestJsonb.headline}`)
    console.log(`  refusal: ${r.digestJsonb.refusal ?? '(none)'}`)
  } catch (err) {
    console.error(`  digest build failed: ${err instanceof Error ? err.message : err}`)
  }

  // Cleanup digest row.
  if (digestId) {
    const { error: delErr } = await supabase
      .from('discovery_digests')
      .delete()
      .eq('id', digestId)
    if (delErr) console.warn(`  digest cleanup error: ${delErr.message}`)
    else console.log(`  Cleaned up digest row`)
  }

  console.log('\n=== Done ===')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
