// Find Rixey weddings that actually have a Knot inbound interaction,
// pull the AEs for those weddings, and re-classify them. These are the
// real "couple inquired via Knot template" cases we need to test.

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

// Find weddings with Knot inbound interactions
const { data: knotInbound } = await sb
  .from('interactions')
  .select('wedding_id, id, full_body, subject, timestamp')
  .eq('venue_id', venueId)
  .eq('direction', 'inbound')
  .ilike('from_email', '%theknot%')
  .not('wedding_id', 'is', null)
  .order('timestamp', { ascending: false })
  .limit(80)

// Dedup by wedding_id, take 30
const seen = new Set()
const weddings = []
for (const r of knotInbound ?? []) {
  if (seen.has(r.wedding_id)) continue
  seen.add(r.wedding_id)
  weddings.push(r.wedding_id)
  if (weddings.length >= 30) break
}
console.log(`Distinct weddings with Knot inbound: ${weddings.length}`)

// For each wedding, get its Knot AE
const { data: aes } = await sb
  .from('attribution_events')
  .select('id, wedding_id, source_platform, role, intent_class')
  .in('wedding_id', weddings)
  .ilike('source_platform', '%knot%')
  .is('reverted_at', null)
  .limit(30)
console.log(`AEs to classify: ${aes?.length ?? 0}`)

const { classifyAndPersistInquiryIntent } = await import(
  '../src/lib/services/attribution-roles/intent-classifier.ts'
)

const breakdown = { targeted: 0, broadcast: 0, validation: 0, unknown: 0 }
const samples = { broadcast: [], targeted: [], unknown: [] }
let totalCost = 0
let llmFires = 0

for (const ae of aes ?? []) {
  process.stdout.write(`  classifying ${ae.id.slice(0, 8)}... `)
  try {
    const result = await classifyAndPersistInquiryIntent(
      { attributionEventId: ae.id },
      { supabase: sb },
    )
    breakdown[result.intentClass] = (breakdown[result.intentClass] || 0) + 1
    totalCost += result.cost_cents
    if (result.signals.llmJudgeFired) llmFires += 1
    if (samples[result.intentClass]?.length < 5) {
      samples[result.intentClass].push({
        aeId: ae.id,
        weddingId: ae.wedding_id,
        templateScore: result.signals.templateScore,
        matchedPatterns: result.signals.matchedPatterns.slice(0, 5),
        components: result.signals,
        forensicPath: result.signals.forensic_path,
        reasoning: result.reasoning.slice(0, 200),
      })
    }
    console.log(`${result.intentClass} score=${result.signals.templateScore} patterns=${result.signals.matchedPatterns.length} post-int=${result.signals.postInquiryInteractionCount} llm=${result.signals.llmJudgeFired}`)
  } catch (err) {
    console.log(`FAIL: ${err.message}`)
  }
}

console.log('\n=== BREAKDOWN ===')
console.log(breakdown)
console.log(`total cost cents: ${totalCost.toFixed(4)}`)
console.log(`Haiku judge fires: ${llmFires}`)

console.log('\n=== TOP BROADCAST SAMPLES ===')
for (const s of samples.broadcast) {
  console.log(JSON.stringify(s, null, 2))

  // Also fetch the inquiry body
  const { data: ints } = await sb
    .from('interactions')
    .select('subject, full_body')
    .eq('wedding_id', s.weddingId)
    .eq('direction', 'inbound')
    .ilike('from_email', '%theknot%')
    .order('timestamp', { ascending: true })
    .limit(1)
  const i = ints?.[0]
  console.log('   subject:', i?.subject?.slice(0, 100))
  console.log('   body excerpt:', (i?.full_body || '').slice(0, 400).replace(/\n/g, ' | '))
  console.log()
}

console.log('\n=== TARGETED SAMPLES ===')
for (const s of samples.targeted.slice(0, 3)) {
  console.log(JSON.stringify(s, null, 2))
  const { data: ints } = await sb
    .from('interactions')
    .select('subject, full_body')
    .eq('wedding_id', s.weddingId)
    .eq('direction', 'inbound')
    .ilike('from_email', '%theknot%')
    .order('timestamp', { ascending: true })
    .limit(1)
  const i = ints?.[0]
  console.log('   body excerpt:', (i?.full_body || '').slice(0, 400).replace(/\n/g, ' | '))
  console.log()
}
