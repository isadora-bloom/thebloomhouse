#!/usr/bin/env tsx
/**
 * Unit test — askIntel mapping and the enforcing grounding check.
 *
 * askIntel now answers by calling the canonical readers as tools, so the live
 * path needs an API key. What IS testable here without one, and without a
 * database:
 *   - composeIntelAnswer, the pure step that turns a finished tool loop into
 *     an IntelAnswer: grounded figures survive as 'high' with evidence, an
 *     ungrounded figure becomes a 'refused' that names the claim;
 *   - mapNLQToAnswer, the legacy NLQ_LEGACY=1 mapping;
 *   - the honest-refused guard, which returns BEFORE any model call.
 *
 * The richer scripted-tool-turn cases live in
 * src/lib/intel/__tests__/ask-intel-grounding.test.ts (vitest).
 *
 * Pure. Run: npx tsx scripts/test-ask-intel-mapping.ts
 */
import { mapNLQToAnswer, composeIntelAnswer, askIntel } from '@/lib/intel/canonical'
import type { ToolCallRecord } from '@/lib/ai/tools'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

const attributionCall: ToolCallRecord = {
  name: 'get_source_attribution',
  args: { model: 'first_touch' },
  result: JSON.stringify({
    model: 'first_touch',
    channels: [
      { channel: 'knot', n: 392, conversion: { value: 0.4023, n: 392, enoughData: true } },
    ],
    topByVolume: 'knot',
    topByConversion: 'knot',
  }),
  isError: false,
}

async function main() {
  // --- composeIntelAnswer: the grounding contract -------------------------
  const grounded = composeIntelAnswer({
    question: 'which channel converts best?',
    text: 'Knot converts at 40% (n=392) and is also your biggest by volume.',
    calls: [attributionCall],
    truncated: false,
  })
  check('a figure that came back from a tool survives', grounded.confidence === 'high', grounded.confidence)
  check('the answer text passes through unchanged', grounded.answer.includes('40%'))
  check('evidence names the reader it stands on', grounded.evidence[0]?.ref.includes('get_source_attribution'), grounded.evidence)
  check('path is tagged as the tool-calling brain', grounded.path === 'tools')

  const ungrounded = composeIntelAnswer({
    question: 'which channel converts best?',
    text: 'Unknown converts at 86%, comfortably your best.',
    calls: [attributionCall],
    truncated: false,
  })
  check('an ungrounded figure refuses the whole answer', ungrounded.confidence === 'refused', ungrounded.confidence)
  check('the refusal names the claim it could not ground', ungrounded.answer.includes('86%'), ungrounded.answer)
  check('the evidence trail survives a refusal', ungrounded.evidence.length === 1)

  const truncated = composeIntelAnswer({
    question: 'how many couples?',
    text: 'You have 392 couples credited to Knot.',
    calls: [attributionCall],
    truncated: true,
  })
  check('a truncated loop is hedged, not high', truncated.confidence === 'hedged', truncated.confidence)

  const blank = composeIntelAnswer({ question: 'anything?', text: '  ', calls: [], truncated: false })
  check('an empty answer refuses rather than returning a blank', blank.confidence === 'refused')

  // --- legacy mapping (NLQ_LEGACY=1 path) ---------------------------------
  const clean = mapNLQToAnswer({ response: 'Knot is your top source at 38%.', honestyFlags: [] })
  check('legacy answer passes through', clean.answer === 'Knot is your top source at 38%.', clean)
  check('legacy: no honesty flags → confidence high', clean.confidence === 'high', clean)
  check('legacy: evidence is [] (brain cites inline, not structured refs)', Array.isArray(clean.evidence) && clean.evidence.length === 0)
  check('legacy: path is tagged legacy', clean.path === 'legacy')

  const hedged = mapNLQToAnswer({ response: 'Roughly half, though the sample is thin.', honestyFlags: [{ rule: 'small_sample' }] })
  check('legacy: any honesty flag → confidence hedged', hedged.confidence === 'hedged', hedged)

  // --- refused guard (returns before any model call) ----------------------
  const noVenue = await askIntel('', 'what is my best channel?')
  check('empty venueId → refused (no model call)', noVenue.confidence === 'refused', noVenue)

  const noQuestion = await askIntel('venue-1', '')
  check('empty question → refused', noQuestion.confidence === 'refused', noQuestion)

  const wsQuestion = await askIntel('venue-1', '    ')
  check('whitespace-only question → refused', wsQuestion.confidence === 'refused', wsQuestion)

  const sensitive = await askIntel('venue-1', 'which couples are dealing with grief?')
  check('sensitive-theme naming → refused before any model call', sensitive.confidence === 'refused', sensitive.confidence)

  check('refused answers still carry the IntelAnswer shape', Array.isArray(noVenue.evidence) && typeof noVenue.answer === 'string')

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — askIntel mapping + grounding`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
