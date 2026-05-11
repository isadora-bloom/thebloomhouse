// Bulk classify all Knot+WW attribution_events on Rixey via the sync
// reclassify service. Reports breakdown and conversion-by-intent.

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

const { classifyAndPersistInquiryIntent } = await import(
  '../src/lib/services/attribution-roles/intent-classifier.ts'
)

// Find all Knot + WW AEs for Rixey (broadcast-capable platforms only)
const { data: aes } = await sb
  .from('attribution_events')
  .select('id, source_platform, wedding_id')
  .eq('venue_id', venueId)
  .or('source_platform.ilike.%knot%,source_platform.ilike.%weddingwire%,source_platform.ilike.%wedding_wire%')
  .is('reverted_at', null)
  .not('wedding_id', 'is', null)

console.log(`Total broadcast-capable AEs to classify: ${aes?.length ?? 0}`)
const totalCount = aes?.length ?? 0

const breakdown = { targeted: 0, broadcast: 0, validation: 0, unknown: 0 }
const breakdownBypath = {}
let totalCost = 0
let llmFires = 0
let failures = 0

const sampled = { broadcast: [], targeted: [] }

let i = 0
for (const ae of aes ?? []) {
  i++
  try {
    const result = await classifyAndPersistInquiryIntent(
      { attributionEventId: ae.id },
      { supabase: sb },
    )
    breakdown[result.intentClass] = (breakdown[result.intentClass] || 0) + 1
    breakdownBypath[result.signals.forensic_path] = (breakdownBypath[result.signals.forensic_path] || 0) + 1
    totalCost += result.cost_cents
    if (result.signals.llmJudgeFired) llmFires += 1

    if (result.intentClass === 'broadcast' && sampled.broadcast.length < 3) {
      sampled.broadcast.push({
        aeId: ae.id,
        weddingId: ae.wedding_id,
        platform: ae.source_platform,
        score: result.signals.templateScore,
        patterns: result.signals.matchedPatterns,
        reasoning: result.reasoning,
      })
    }
    if (i % 50 === 0) {
      process.stdout.write(`\r  ${i}/${totalCount} processed...`)
    }
  } catch (err) {
    failures += 1
    console.log(`  FAIL ae=${ae.id.slice(0,8)}: ${err.message}`)
  }
}
console.log(`\n  done.`)

console.log('\n=== INTENT BREAKDOWN (all broadcast-capable AEs) ===')
console.log(breakdown)
console.log('\n=== FORENSIC PATH BREAKDOWN ===')
console.log(breakdownBypath)
console.log(`\ntotal cost cents: ${totalCost.toFixed(4)}`)
console.log(`Haiku judge fires: ${llmFires}`)
console.log(`failures: ${failures}`)

console.log('\n=== TOP 3 BROADCAST SAMPLES ===')
for (const s of sampled.broadcast) {
  console.log(JSON.stringify(s, null, 2))
  // Pull the inquiry body
  const { data: ints } = await sb
    .from('interactions')
    .select('subject, full_body')
    .eq('wedding_id', s.weddingId)
    .eq('direction', 'inbound')
    .ilike('from_email', s.platform.includes('knot') ? '%theknot%' : '%weddingwire%')
    .order('timestamp', { ascending: true })
    .limit(1)
  const i = ints?.[0]
  console.log('  subject:', i?.subject?.slice(0, 120))
  console.log('  body (200 chars):', (i?.full_body || '').slice(0, 400).replace(/\n/g, ' | '))
}

// Per-channel intent summary
console.log('\n=== INTENT SUMMARY (live) ===')
const { getIntentSummary } = await import(
  '../src/lib/services/attribution-roles/intent-summary.ts'
)
const summary = await getIntentSummary(venueId)
console.log('byIntent:', summary.byIntent)
const knot = summary.byChannel.find((c) => c.channel === 'the_knot')
console.log('\nthe_knot channel:')
console.log(JSON.stringify(knot, null, 2))
const ww = summary.byChannel.find((c) => c.channel.includes('weddingwire') || c.channel.includes('wedding_wire'))
if (ww) {
  console.log('\nweddingwire channel:')
  console.log(JSON.stringify(ww, null, 2))
}
