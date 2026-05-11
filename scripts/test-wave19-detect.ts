/**
 * Test Wave 19 detect-from-draft on a real Rixey draft AND with a
 * synthetic hedge-heavy fixture.
 *
 * Usage:
 *   npx tsx scripts/test-wave19-detect.ts
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

function loadEnv() {
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {}
}
loadEnv()

import { detectKnowledgeGapsFromDraft } from '../src/lib/services/knowledge-gaps/detect-from-draft.js'
import { captureKnowledge } from '../src/lib/services/knowledge-gaps/capture.js'
import { buildVenueKnowledgeBlock, inferContextTags } from '../src/lib/services/knowledge-gaps/fold-in.js'

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const { data: venue } = await sb
    .from('venues')
    .select('id, name')
    .ilike('name', '%Rixey%')
    .limit(1)
    .maybeSingle()
  if (!venue) {
    console.error('no Rixey venue found')
    process.exit(2)
  }
  console.log('Venue:', venue.id, venue.name)

  // ---- Test 1: Synthetic hedge-heavy draft ----
  console.log('\n=== TEST 1: detect on a hedge-heavy fixture ===')

  const inboundSubject = 'Question about your venue for our wedding'
  const inboundBody = `
Hi Sage,

We're considering Rixey Manor for our wedding in June 2027. A few quick questions:

1. What's your minimum guest count on a Saturday in peak season?
2. Do you allow sparklers at the send-off?
3. Are dogs allowed at the ceremony?
4. What time do we need to be off the property?
5. Is there a corkage fee if we bring our own wine?

Thanks!
Sarah
`.trim()

  const draftBody = `
Hi Sarah,

Thanks so much for reaching out! We'd love to host you at Rixey Manor in June 2027.

To answer your questions: I'll need to check with the coordinator on the minimum guest count for Saturday peak season - I want to make sure I give you accurate information.

On sparklers, I'm not sure if we allow them at the moment - the coordinator will be in touch about that.

We love dogs! However, I'll need to confirm whether we allow them at the actual ceremony.

For the property departure time, let me check on that and get back to you.

And on corkage - I'll have to ask the coordinator about whether we charge a fee for outside wine.

Looking forward to hearing from you!

Best,
Sage
`.trim()

  const result1 = await detectKnowledgeGapsFromDraft({
    venueId: venue.id,
    aiName: 'Sage',
    inboundSubject,
    inboundBody,
    draftBody,
  })
  console.log('skipped:', result1.skipped, result1.skipReason ?? '')
  console.log('reasoning:', result1.reasoning)
  console.log('gaps detected:', result1.gaps.length)
  for (const g of result1.gaps) {
    console.log('  - Q:', g.question)
    console.log('    category:', g.category)
    console.log('    hedge:', g.hedge_excerpt.slice(0, 200))
  }
  console.log('persisted gap ids:', result1.insertedGapIds.length)

  // ---- Test 2: synthetic confident draft (should yield zero) ----
  console.log('\n=== TEST 2: detect on a confident draft (should yield zero) ===')
  const confidentDraft = `
Hi Sarah,

Thanks so much for reaching out! We'd love to host you at Rixey Manor in June 2027.

Our Saturday minimum in peak season is 60 guests. We do allow sparklers as long as they're used outdoors during the send-off only. Dogs are welcome at outdoor ceremonies (we just need them on a leash and accompanied). The property departure time on Saturdays is 11pm. And we don't charge corkage - bring your own wine!

Looking forward to chatting more!

Best,
Sage
`.trim()
  const result2 = await detectKnowledgeGapsFromDraft({
    venueId: venue.id,
    aiName: 'Sage',
    inboundSubject,
    inboundBody,
    draftBody: confidentDraft,
  })
  console.log('skipped:', result2.skipped, result2.skipReason ?? '')
  console.log('gaps detected:', result2.gaps.length)

  // ---- Test 3: captureKnowledge round-trip ----
  console.log('\n=== TEST 3: captureKnowledge round-trip ===')
  const captureResult = await captureKnowledge({
    venueId: venue.id,
    question: '__wave19_test__ Are sparklers allowed at the send-off?',
    answer:
      'Yes - sparklers are allowed only during the send-off outdoors, with the coordinator present.',
    tags: ['policy'],
    sourceKind: 'operator_input',
  })
  console.log('captureId:', captureResult.captureId)
  console.log('reused:', captureResult.reused)

  // Re-capture same question → reuse
  const captureResult2 = await captureKnowledge({
    venueId: venue.id,
    question: '__wave19_test__ Are sparklers allowed at the send-off?',
    answer: 'Updated answer: sparklers allowed during send-off, outdoors only, coordinator present.',
    tags: ['policy', 'logistics'],
    sourceKind: 'operator_input',
  })
  console.log('second capture captureId:', captureResult2.captureId)
  console.log('reused:', captureResult2.reused, '(should be true)')

  // ---- Test 4: fold-in ----
  console.log('\n=== TEST 4: fold-in via buildVenueKnowledgeBlock ===')
  const contextTags = inferContextTags(inboundBody)
  console.log('inferred context tags:', contextTags)
  const fold = await buildVenueKnowledgeBlock({
    venueId: venue.id,
    contextTags,
  })
  console.log('matched count:', fold.matchedCount)
  console.log('total active captures:', fold.totalActive)
  console.log('block preview:\n', fold.block.slice(0, 800))

  // Cleanup the test capture row
  await sb
    .from('knowledge_captures')
    .delete()
    .eq('id', captureResult.captureId)
  console.log('\nCleaned up test capture row.')
}

main().catch((err) => {
  console.error('test error:', err)
  process.exit(1)
})
