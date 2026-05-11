/* Wave 15 verification — discovery_sources capture for Sophie.
 *
 * Simulates a Calendly Q&A capture with the ChatGPT answer.
 * Run: node node_modules/tsx/dist/cli.mjs scripts/test-wave15-discovery.ts
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import {
  captureDiscoverySource,
  extractDiscoveryAnswerFromCalendly,
} from '../src/lib/services/discovery-source/capture'
import { mapToCanonicalDiscoverySource } from '../src/lib/services/discovery-source/canonical'

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

const WEDDING_ID = '948b79a5-5954-4a07-bed4-4fdd3a7d2b95'
const VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

;(async () => {
console.log('=== Wave 15 discovery_source verification ===\n')

// 1. Test the canonical mapper unit cases
console.log('Unit test: canonical mapping')
const cases = [
  ['ChatGPT', 'ai_tool'],
  ['chat gpt', 'ai_tool'],
  ['gpt-5', 'ai_tool'],
  ['Claude', 'ai_tool'],
  ['Perplexity', 'ai_tool'],
  ['Instagram', 'instagram'],
  ['the knot', 'theknot'],
  ['theknot.com', 'theknot'],
  ['Friend referral', 'friend'],
  ['Google search', 'google'],
  ['', 'unknown'],
  ['random nonsense', 'other'],
]
for (const [input, expected] of cases) {
  const got = mapToCanonicalDiscoverySource(input as string)
  const ok = got === expected
  console.log(`  ${ok ? '✓' : '✗'} "${input}" -> ${got} (expected ${expected})`)
}

// 2. Test the Calendly Q&A extractor
console.log('\nUnit test: Calendly Q&A extractor')
const fakePayload = {
  email: 'sophie@example.com',
  scheduled_event: { start_time: '2026-05-10T10:00:00Z' },
  questions_and_answers: [
    {
      question: 'How did you hear about us?',
      answer: 'ChatGPT',
      position: 0,
    },
    {
      question: 'What is your wedding date?',
      answer: '2027-05-01',
      position: 1,
    },
  ],
}
const extracted = extractDiscoveryAnswerFromCalendly(fakePayload)
console.log(`  extracted:`, extracted)

// 3. Simulate a capture write
console.log('\nIntegration: capture write for Sophie')
const result = await captureDiscoverySource({
  venueId: VENUE_ID,
  weddingId: WEDDING_ID,
  personId: null,
  captureSource: 'calendly',
  questionText: 'How did you hear about us?',
  answerText: 'ChatGPT',
  captureRef: 'test-uri-wave15',
  supabase: sb,
})
console.log('  capture result:', result)

// 4. Re-run to confirm idempotency
const result2 = await captureDiscoverySource({
  venueId: VENUE_ID,
  weddingId: WEDDING_ID,
  personId: null,
  captureSource: 'calendly',
  questionText: 'How did you hear about us?',
  answerText: 'ChatGPT',
  captureRef: 'test-uri-wave15',
  supabase: sb,
})
console.log('  re-run capture result (should be idempotent):', result2)

// 5. Read back rows
console.log('\nVerification reads')
const { data: ds } = await sb
  .from('discovery_sources')
  .select('*')
  .eq('wedding_id', WEDDING_ID)
console.log(`  discovery_sources rows: ${ds?.length ?? 0}`)
for (const r of ds ?? []) {
  console.log(`    - canonical=${r.canonical_source} answer="${r.answer_text}" capture_ref=${r.capture_ref}`)
}

const { data: ae } = await sb
  .from('attribution_events')
  .select('id, source_platform, tier, reasoning, decided_at')
  .eq('wedding_id', WEDDING_ID)
  .like('reasoning', '%Wave 15 discovery_source%')
console.log(`  attribution_events Wave 15 rows: ${ae?.length ?? 0}`)
for (const r of ae ?? []) {
  console.log(`    - ${r.source_platform} [${r.tier}]: ${(r.reasoning ?? '').slice(0, 100)}`)
}

console.log('\n=== Fix #3 evidence-override write/read test ===')
// Pick a review row to dismiss (Lauren and Thomas S)
const { data: lauren } = await sb
  .from('reviews')
  .select('id, reviewer_name')
  .eq('venue_id', VENUE_ID)
  .ilike('reviewer_name', '%Lauren%')
  .limit(1)
  .maybeSingle()
if (lauren) {
  console.log('Found review to dismiss:', lauren)
  // Insert a dismiss override
  const { data: ovi, error: oviErr } = await sb
    .from('evidence_overrides')
    .upsert(
      {
        venue_id: VENUE_ID,
        wedding_id: WEDDING_ID,
        evidence_kind: 'review',
        evidence_ref: { table: 'reviews', id: lauren.id },
        override_action: 'dismiss',
        reason: 'Wave 15 test — Lauren and Thomas S is not Sophie',
        active: true,
      },
      { onConflict: 'id' },
    )
    .select('id')
    .single()
  if (oviErr) console.log('  insert error:', oviErr.message)
  else console.log('  override inserted:', ovi)

  // Read back active overrides
  const { data: actives } = await sb
    .from('evidence_overrides')
    .select('*')
    .eq('wedding_id', WEDDING_ID)
    .eq('active', true)
  console.log(`  active overrides on this wedding: ${actives?.length ?? 0}`)
  for (const a of actives ?? []) {
    console.log(`    - ${a.evidence_kind} ${a.override_action} reason="${a.reason}"`)
  }
}

console.log('\nDONE')
})()
