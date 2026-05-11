// Wave 16 verification — test intent classifier against 20 Rixey Knot
// attribution_events and report the breakdown.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const venueId = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Step 1: verify seed patterns find real broadcast inquiries
console.log('=== STEP 1: verify seed patterns find Rixey Knot broadcasts ===\n')

const knotPhrases = [
  '%we saw your listing%',
  '%interested in the prices and details%',
  '%Looking for pricing first%',
  '%reaching out to several%',
  '%information about pricing and availability%',
  '%Lots of details are still TBD%',
  '%Can you share what options are available%',
]
for (const p of knotPhrases) {
  const { count } = await sb
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .ilike('full_body', p)
  console.log(`  pattern "${p}" matched ${count ?? 0} interactions`)
}

// Step 2: test classifier on 20 Rixey Knot attribution_events
console.log('\n=== STEP 2: classify 20 Rixey Knot attribution_events ===\n')

const { data: aes } = await sb
  .from('attribution_events')
  .select('id, wedding_id, source_platform, decided_at, role, intent_class')
  .eq('venue_id', venueId)
  .ilike('source_platform', '%knot%')
  .is('reverted_at', null)
  .not('wedding_id', 'is', null)
  .limit(20)

if (!aes || aes.length === 0) {
  console.log('No Knot attribution_events found.')
  process.exit(0)
}
console.log(`Found ${aes.length} candidates.`)

// Use the real classifier
const { classifyAndPersistInquiryIntent } = await import(
  '../src/lib/services/attribution-roles/intent-classifier.ts'
)

const breakdown = { targeted: 0, broadcast: 0, validation: 0, unknown: 0 }
const samples = { broadcast: [], targeted: [], unknown: [] }
let totalCost = 0
let llmFires = 0

for (const ae of aes) {
  process.stdout.write(`  classifying ${ae.id.slice(0, 8)}... `)
  try {
    const result = await classifyAndPersistInquiryIntent(
      { attributionEventId: ae.id },
      { supabase: sb },
    )
    breakdown[result.intentClass] = (breakdown[result.intentClass] || 0) + 1
    totalCost += result.cost_cents
    if (result.signals.llmJudgeFired) llmFires += 1
    if (samples[result.intentClass]?.length < 3) {
      samples[result.intentClass].push({
        id: ae.id,
        templateScore: result.signals.templateScore,
        matchedPatterns: result.signals.matchedPatterns.slice(0, 3),
        postInquiryInteractionCount: result.signals.postInquiryInteractionCount,
        postInquiryTourCount: result.signals.postInquiryTourCount,
        forensicPath: result.signals.forensic_path,
        reasoning: result.reasoning.slice(0, 200),
      })
    }
    console.log(`${result.intentClass} (score=${result.signals.templateScore})`)
  } catch (err) {
    console.log(`FAIL: ${err.message}`)
  }
}

console.log('\n=== BREAKDOWN ===')
console.log(breakdown)
console.log(`total cost cents: ${totalCost.toFixed(4)}`)
console.log(`Haiku judge fires: ${llmFires}`)

console.log('\n=== TOP BROADCAST SAMPLES ===')
console.log(JSON.stringify(samples.broadcast, null, 2))

console.log('\n=== TARGETED SAMPLES ===')
console.log(JSON.stringify(samples.targeted, null, 2))

console.log('\n=== UNKNOWN SAMPLES ===')
console.log(JSON.stringify(samples.unknown, null, 2))

// Step 3: get the intent summary aggregate
console.log('\n=== STEP 3: intent summary aggregate ===')
const { getIntentSummary } = await import(
  '../src/lib/services/attribution-roles/intent-summary.ts'
)
const summary = await getIntentSummary(venueId)
console.log('byIntent:', summary.byIntent)
console.log('byChannel (knot only):', summary.byChannel.filter((c) => c.channel.includes('knot')))
