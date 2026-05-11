/**
 * Wave 22 — re-test channel-role classifier under v2 on Rixey theknot rows.
 *
 * Per the Wave 22 brief:
 *   "After patching channel-role-classifier (critical 2), re-run it on
 *    20 Rixey theknot attribution_events that were classified under v1.
 *    Compare: did the validation % shift? Wave 21 cited '18-19%
 *    reclassify as validation under v1' — re-test under v2 and report
 *    the new %."
 *
 * Anchor docs:
 *   - PROMPT-BIAS-AUDIT.md (Wave 21 audit findings #4 + #18)
 *   - feedback_measure_dont_assume.md (re-measure under neutral framing)
 *   - feedback_audit_agents_overclaim.md (report the actual numbers)
 *
 * Usage:
 *   node --env-file=.env.local scripts/test-wave22-retest.mjs
 *
 * This script:
 *   1. Counts Rixey theknot attribution_events classified under
 *      channel-role-classifier.prompt.v1.
 *   2. Pulls the most recent 20 of them.
 *   3. Dumps the v1 verdict distribution (acquisition / validation /
 *      conversion / mixed / unknown).
 *   4. Reports the v2 distribution that would result from re-running
 *      the classifier under the v2 prompt — by hitting the
 *      /api/admin/attribution/reclassify-v1 endpoint with dryRun=false
 *      and limit=20 (operator-triggered, NOT cron-driven).
 *
 * To actually fire the LLM judges, set RUN_LLM=1 in env and ensure
 * NEXT_PUBLIC_APP_URL is set + valid platform auth cookies are in
 * the SUPABASE_AUTH_COOKIE env (or use the CRON_SECRET path with the
 * Authorization header).
 *
 * Without RUN_LLM=1 the script returns the pre-rerun audit only —
 * candidate count + v1 distribution + URL to call. Safe to run in CI
 * for audit-only purposes.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

function loadEnv() {
  try {
    const text = readFileSync('.env.local', 'utf-8')
    const lines = text.split('\n')
    return {
      url: extract(lines, 'NEXT_PUBLIC_SUPABASE_URL'),
      key: extract(lines, 'SUPABASE_SERVICE_ROLE_KEY'),
      appUrl: extract(lines, 'NEXT_PUBLIC_APP_URL') || 'http://localhost:3000',
      cronSecret: extract(lines, 'CRON_SECRET'),
    }
  } catch (err) {
    return {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY,
      appUrl: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      cronSecret: process.env.CRON_SECRET,
    }
  }
}

function extract(lines, key) {
  const line = lines.find((l) => l.startsWith(key + '='))
  return line ? line.slice(key.length + 1).trim() : ''
}

const env = loadEnv()
if (!env.url || !env.key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(env.url, env.key)
const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const V1_VERSIONS = [
  'channel-role-classifier.prompt.v1',
  'inquiry-intent-judge.prompt.v1',
]

async function main() {
  // ---- 1. Count Rixey rows classified under v1 ----
  const { count: totalV1 } = await sb
    .from('attribution_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_VENUE_ID)
    .in('prompt_version_classified_under', V1_VERSIONS)
    .is('reverted_at', null)
  console.log(`Rixey rows classified under v1 prompts: ${totalV1 ?? 0}`)

  // ---- 2. Filter to theknot rows ----
  const { data: knotV1Rows, count: theknotV1Count } = await sb
    .from('attribution_events')
    .select('id, source_platform, role, intent_class, decided_at, prompt_version_classified_under', { count: 'exact' })
    .eq('venue_id', RIXEY_VENUE_ID)
    .in('prompt_version_classified_under', V1_VERSIONS)
    .ilike('source_platform', '%knot%')
    .is('reverted_at', null)
    .order('decided_at', { ascending: false })
    .limit(20)
  console.log(`Rixey theknot rows under v1 (most recent 20 / total ${theknotV1Count ?? 0}):`)

  // ---- 3. v1 role distribution on the sample ----
  const v1Dist = {}
  for (const row of knotV1Rows ?? []) {
    const k = row.role ?? 'null'
    v1Dist[k] = (v1Dist[k] ?? 0) + 1
  }
  const sampleSize = (knotV1Rows ?? []).length
  console.log('v1 role distribution on sample:', v1Dist)
  const v1ValidationPct = sampleSize > 0
    ? Math.round(100 * (v1Dist.validation ?? 0) / sampleSize)
    : 0
  console.log(`v1 validation %: ${v1ValidationPct}%  (Wave 21 cited ~18-19% on the broader 433-row Knot cohort)`)

  // ---- 4. v2 reclassify ----
  if (process.env.RUN_LLM !== '1') {
    console.log('\nRUN_LLM != 1 — stopping before LLM calls.')
    console.log('To run the v2 re-test:')
    console.log('  - Set RUN_LLM=1')
    console.log('  - Ensure either CRON_SECRET (with venueId) or valid platform-auth cookies')
    console.log('  - Hit POST', `${env.appUrl}/api/admin/attribution/reclassify-v1`)
    console.log('  - Body: { "venueId": "' + RIXEY_VENUE_ID + '", "limit": 20 }')
    process.exit(0)
  }

  if (!env.cronSecret) {
    console.error('RUN_LLM=1 requires CRON_SECRET in env (or a different auth path).')
    process.exit(2)
  }

  console.log('\nFiring v2 re-classify against the endpoint...')
  const res = await fetch(`${env.appUrl}/api/admin/attribution/reclassify-v1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.cronSecret}`,
    },
    body: JSON.stringify({ venueId: RIXEY_VENUE_ID, limit: 20, dryRun: false }),
  })
  if (!res.ok) {
    const body = await res.text()
    console.error(`v2 reclassify failed: ${res.status} ${body}`)
    process.exit(3)
  }
  const json = await res.json()
  console.log('\nv2 reclassify result:')
  console.log(JSON.stringify(json, null, 2))

  // ---- 5. v2 distribution + shift summary ----
  const summary = json.summary
  if (summary?.role_shift) {
    const v2Dist = summary.role_shift.v2_distribution
    const v2Total = Object.values(v2Dist).reduce((a, b) => a + b, 0)
    const v2ValidationPct = v2Total > 0
      ? Math.round(100 * (v2Dist.validation ?? 0) / v2Total)
      : 0
    console.log(`\nv2 role distribution on same sample:`, v2Dist)
    console.log(`v2 validation %: ${v2ValidationPct}%`)
    const delta = v2ValidationPct - v1ValidationPct
    console.log(`\nDelta v2 vs v1: ${delta > 0 ? '+' : ''}${delta}pp`)
    if (Math.abs(delta) < 5) {
      console.log('Finding: bias was NOT load-bearing — v1 verdict held up under symmetric v2 prompt.')
    } else if (delta < 0) {
      console.log('Finding: bias was load-bearing — v1 over-classified as validation; v2 (neutral) shifts away.')
    } else {
      console.log('Finding: bias was load-bearing in the opposite direction — v2 (neutral) classifies MORE as validation.')
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err)
  process.exit(1)
})
