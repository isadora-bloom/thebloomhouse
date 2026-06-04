#!/usr/bin/env tsx
/**
 * Unit test — askIntel mapping (Phase 3.3 canonical function, 6th of 6).
 *
 * askIntel wraps the NLQ brain (answerNaturalLanguageQuery → an LLM call),
 * so the live path can't be unit-tested without a key. What IS testable
 * without the LLM: (1) the pure NLQResult → IntelAnswer mapping, and (2) the
 * honest-`refused` guard, which returns BEFORE importing/calling the brain.
 * Locks:
 *   - answer passes through; evidence is [] (brain cites inline, no refs);
 *   - confidence = 'high' when no honesty flags, 'hedged' when any tripped;
 *   - empty venueId / empty / whitespace question → 'refused' (no brain call).
 *
 * Pure. Run: npx tsx scripts/test-ask-intel-mapping.ts
 */
import { mapNLQToAnswer, askIntel } from '@/lib/intel/canonical'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

async function main() {
  // --- pure mapping -------------------------------------------------------
  const clean = mapNLQToAnswer({ response: 'Knot is your top source at 38%.', honestyFlags: [] })
  check('answer passes through', clean.answer === 'Knot is your top source at 38%.', clean)
  check('no honesty flags → confidence high', clean.confidence === 'high', clean)
  check('evidence is [] (brain cites inline, not structured refs)', Array.isArray(clean.evidence) && clean.evidence.length === 0)
  check('generatedAt is an ISO string', typeof clean.generatedAt === 'string' && clean.generatedAt.length > 0)

  const hedged = mapNLQToAnswer({ response: 'Roughly half, though the sample is thin.', honestyFlags: [{ rule: 'small_sample' }] })
  check('any honesty flag → confidence hedged', hedged.confidence === 'hedged', hedged)

  const multiFlag = mapNLQToAnswer({ response: 'x', honestyFlags: ['a', 'b'] })
  check('multiple flags → still hedged', multiFlag.confidence === 'hedged')

  // --- refused guard (returns before any brain/LLM call) ------------------
  const noVenue = await askIntel('', 'what is my best channel?')
  check('empty venueId → refused (no brain call)', noVenue.confidence === 'refused', noVenue)

  const noQuestion = await askIntel('venue-1', '')
  check('empty question → refused', noQuestion.confidence === 'refused', noQuestion)

  const wsQuestion = await askIntel('venue-1', '    ')
  check('whitespace-only question → refused', wsQuestion.confidence === 'refused', wsQuestion)

  check('refused answers still carry the IntelAnswer shape', Array.isArray(noVenue.evidence) && typeof noVenue.answer === 'string')

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — askIntel mapping`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
