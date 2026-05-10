/**
 * Smoke test for Wave 6D (marketing loop).
 *
 * Tests:
 *   1. detectMarketingFlags on Rixey — returns counts.
 *   2. buildWeeklyDigest on Rixey — returns digest + cost.
 *
 * Usage:
 *   npx tsx scripts/smoke-wave-6d.ts
 */

import { readFileSync } from 'node:fs'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  const env = loadEnv()
  for (const k of [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ANTHROPIC_API_KEY',
  ]) {
    if (!env[k]) {
      console.error(`Missing ${k} in env / .env.local`)
      process.exit(2)
    }
    process.env[k] = env[k]
  }

  console.log('=== Wave 6D smoke test ===')
  console.log(`Venue: Rixey Manor (${RIXEY_VENUE_ID})\n`)

  // ----- Test 1: detectMarketingFlags -----
  console.log('--- Test 1: detectMarketingFlags ---')
  const { detectMarketingFlags } = await import(
    '../src/lib/services/marketing-spend/loop/flag-detector'
  )
  try {
    const result = await detectMarketingFlags({ venueId: RIXEY_VENUE_ID })
    console.log('Result:', {
      flagsCreated: result.flagsCreated,
      flagsConfirmed: result.flagsConfirmed,
      flagsResolved: result.flagsResolved,
      diagnostics: result.diagnostics,
    })
  } catch (err) {
    console.error('detectMarketingFlags threw:', err)
  }

  // ----- Test 2: buildWeeklyDigest -----
  console.log('\n--- Test 2: buildWeeklyDigest ---')
  const { buildWeeklyDigest, MARKETING_DIGEST_PROMPT_VERSION } = await import(
    '../src/lib/services/marketing-spend/loop/digest-builder'
  )
  try {
    const result = await buildWeeklyDigest(RIXEY_VENUE_ID)
    console.log('Result:', {
      digestId: result.digestId,
      promptVersion: result.promptVersion,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      costCents: result.costCents,
      diagnostics: result.diagnostics,
    })
    console.log('\nDigest headline:', result.digestJsonb.headline)
    console.log(
      'Digest narrative:',
      result.digestJsonb.this_week_in_3_sentences,
    )
    console.log('Refusal:', result.digestJsonb.refusal)
    console.log('top_flags:', result.digestJsonb.top_flags.length)
    console.log('top_recommendations:', result.digestJsonb.top_recommendations.length)
    console.log('week_over_week:', result.digestJsonb.week_over_week)
    console.log('\nMarketing-digest prompt version:', MARKETING_DIGEST_PROMPT_VERSION)
  } catch (err) {
    console.error('buildWeeklyDigest threw:', err)
    process.exit(1)
  }

  console.log('\n=== Smoke test complete ===')
}

main().catch((err) => {
  console.error('smoke test failed:', err)
  process.exit(1)
})
