/**
 * Wave 14 smoke test — referral attribution + alumni cohort patterns.
 *
 * 1. Finds a Rixey wedding whose interactions mention common referral
 *    phrases ("recommended us", "told me about", "heard about you from"),
 *    asserts the couple_identity_profile exists, then runs
 *    extractReferrers + resolveReferrer.
 * 2. Generates alumni cohorts for the Rixey venue. Reports archetype
 *    count + top archetype label + cost.
 *
 * Run with:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-wave-14.ts
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

const fileEnv = loadEnv()
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] === undefined) process.env[k] = v
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const supabase = createClient(url, serviceKey)

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function findReferrerCandidate(): Promise<string | null> {
  // Search interactions whose body mentions a referral phrase. Scope to
  // weddings that have a reconstructed profile.
  const phrases = [
    'recommended us',
    'recommended you',
    'recommended me',
    'told me about',
    'told us about',
    'heard about you from',
    'heard about you through',
    'referred us',
    'referred me',
    'their wedding was',
    'recommend',
    'referral',
    'word of mouth',
  ]
  for (const phrase of phrases) {
    const { data } = await supabase
      .from('interactions')
      .select('wedding_id, weddings!inner(venue_id, merged_into_id)')
      .ilike('full_body', `%${phrase}%`)
      .limit(50)
    if (data && data.length > 0) {
      for (const row of data as unknown as Array<{
        wedding_id: string
        weddings: { venue_id: string; merged_into_id: string | null } | Array<{ venue_id: string; merged_into_id: string | null }>
      }>) {
        if (!row.wedding_id) continue
        const w = Array.isArray(row.weddings) ? row.weddings[0] : row.weddings
        if (!w) continue
        if (w.venue_id !== RIXEY_VENUE_ID) continue
        if (w.merged_into_id) continue
        // Check profile exists
        const { data: prof } = await supabase
          .from('couple_identity_profile')
          .select('wedding_id')
          .eq('wedding_id', row.wedding_id)
          .maybeSingle()
        if (prof) {
          console.log(
            `[findReferrerCandidate] matched phrase "${phrase}" on wedding ${row.wedding_id}`,
          )
          return row.wedding_id
        }
      }
    }
  }
  return null
}

async function runReferralTest(): Promise<void> {
  console.log('=== Wave 14 referral extraction smoke test ===')
  console.log('Searching for a Rixey wedding with a referrer-shaped body…')
  const weddingId = await findReferrerCandidate()
  if (!weddingId) {
    console.log('No referrer-shaped wedding found at Rixey — skipping extraction test.')
    console.log('(This is OK — the extractor would simply return empty arrays.)')
    return
  }

  console.log(`Running extractReferrers on wedding ${weddingId}…`)
  // Dynamic import so the .env.local hoist is in effect first.
  const { extractReferrers } = await import('../src/lib/services/intel/referrals/extract')
  const { resolveReferrer } = await import('../src/lib/services/intel/referrals/resolve')

  let result
  try {
    result = await extractReferrers({ weddingId })
  } catch (err) {
    console.error('extractReferrers threw:', err)
    return
  }
  console.log(`  cost: ${result.costCents.toFixed(4)}¢`)
  console.log(`  input tokens: ${result.inputTokens}`)
  console.log(`  output tokens: ${result.outputTokens}`)
  console.log(`  mentions extracted: ${result.output.referrer_mentions.length}`)
  console.log(`  refusals: ${result.output.refusals.length}`)
  for (const m of result.output.referrer_mentions) {
    console.log(
      `    - "${m.referrer_name}" (${m.relationship_to_couple}, ${m.confidence_0_100}%) :: "${m.evidence_quote.slice(0, 120)}"`,
    )
  }
  for (const r of result.output.refusals) {
    console.log(`    refusal: ${r.field} — ${r.reason}`)
  }

  // Resolve each mention
  console.log('Running resolveReferrer for each mention…')
  for (const m of result.output.referrer_mentions) {
    const res = await resolveReferrer({
      newWeddingId: weddingId,
      venueId: result.venueId,
      mention: m,
    })
    console.log(`    resolve "${m.referrer_name}" → ${res.kind}`, res)
  }
}

async function runAlumniTest(): Promise<void> {
  console.log('')
  console.log('=== Wave 14 alumni cohort generation smoke test ===')
  console.log(`Generating archetypes for Rixey (${RIXEY_VENUE_ID})…`)

  const { generateAlumniCohorts } = await import(
    '../src/lib/services/intel/alumni/generate'
  )
  let result
  try {
    result = await generateAlumniCohorts({ venueId: RIXEY_VENUE_ID })
  } catch (err) {
    console.error('generateAlumniCohorts threw:', err)
    return
  }
  console.log(`  cost: ${result.costCents.toFixed(4)}¢`)
  console.log(`  input tokens: ${result.inputTokens}`)
  console.log(`  output tokens: ${result.outputTokens}`)
  console.log(`  booked couples in scope: ${result.bookedCoupleCount}`)
  console.log(`  archetypes upserted: ${result.archetypesUpserted}`)
  console.log(`  archetype count from LLM: ${result.output.archetypes.length}`)
  console.log('  archetypes (sorted by booked_count desc):')
  const sorted = [...result.output.archetypes].sort(
    (a, b) => b.booked_count - a.booked_count,
  )
  for (const a of sorted) {
    console.log(
      `    - "${a.label}" (n=${a.booked_count}): ${a.description.slice(0, 100)}`,
    )
  }
  for (const r of result.output.refusals) {
    console.log(`  refusal: ${r.field} — ${r.reason}`)
  }
  if (sorted.length > 0) {
    console.log(`  TOP ARCHETYPE: "${sorted[0].label}" (${sorted[0].booked_count} couples)`)
  }
}

async function main() {
  try {
    await runReferralTest()
  } catch (err) {
    console.error('referral test fatal:', err)
  }
  try {
    await runAlumniTest()
  } catch (err) {
    console.error('alumni test fatal:', err)
  }
  console.log('')
  console.log('=== Wave 14 smoke test complete ===')
}

main().catch((err) => {
  console.error('top-level fatal:', err)
  process.exit(1)
})
