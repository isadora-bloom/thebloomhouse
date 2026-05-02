/**
 * Brain regression harness self-test (OPS-21.1.1-C).
 *
 * Demonstrates:
 *   - fingerprintInputs is deterministic + sensitive to inputs
 *   - recordBrainStub + lookupStub round-trip
 *   - runBrainScenario uses stubs when available + reports missing
 *   - unusedStubs detects dead fixtures (drift signal)
 *
 * Real per-brain regression suites land as scripts/test-brain-<name>.ts
 * each registering its own stubs via this harness.
 */

import {
  fingerprintInputs,
  recordBrainStub,
  lookupStub,
  runBrainScenario,
  unusedStubs,
  resetStubs,
} from './test-harness/brain-regression'
import type { CallAIOptions, CallAIResult } from './test-harness/brain-types'

let pass = 0
let fail = 0

function assert(cond: unknown, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`)
    pass++
  } else {
    console.error(`  ✗ ${label}`)
    fail++
  }
}

async function main() {
  console.log('\n=== fingerprintInputs ===')
  resetStubs()
  const baseOpts = {
    systemPrompt: 'You are a wedding-venue concierge.',
    userPrompt: 'Hi, can I tour Saturday?',
    model: 'claude-sonnet',
  }
  const fp1 = fingerprintInputs(baseOpts)
  const fp2 = fingerprintInputs(baseOpts)
  assert(fp1 === fp2, 'identical inputs → identical fingerprint')
  assert(fp1.length === 8, 'fingerprint is 8-char hex')
  assert(fingerprintInputs({ ...baseOpts, systemPrompt: 'different' }) !== fp1, 'systemPrompt change busts fingerprint')
  assert(fingerprintInputs({ ...baseOpts, userPrompt: 'Hi, can I tour Sunday?' }) !== fp1, 'userPrompt change busts fingerprint')
  assert(fingerprintInputs({ ...baseOpts, model: 'claude-haiku' }) !== fp1, 'model change busts fingerprint')

  console.log('\n=== record / lookup stub ===')
  recordBrainStub('inquiry-brain.prompt.v1.0', fp1, {
    text: 'Yes — Saturday at 2pm works. Want me to confirm?',
    inputTokens: 50,
    outputTokens: 12,
    cost: 0.00005,
  })
  const found = lookupStub('inquiry-brain.prompt.v1.0', fp1)
  assert(found?.text === 'Yes — Saturday at 2pm works. Want me to confirm?', 'lookup returns the recorded response')
  assert(lookupStub('inquiry-brain.prompt.v1.0', 'absent-fp') === null, 'absent fingerprint returns null')
  assert(lookupStub('inquiry-brain.prompt.v999.0', fp1) === null, 'absent prompt-version returns null')

  console.log('\n=== runBrainScenario with stubbed callAi ===')
  resetStubs()
  recordBrainStub('test-brain.v1', fingerprintInputs({ systemPrompt: 'sys', userPrompt: 'usr', model: 'sonnet' }), {
    text: 'stubbed response', inputTokens: 1, outputTokens: 1, cost: 0.001,
  })

  // Simulate a brain function that calls the stubbed callAi.
  async function exampleBrainFn(callAi: (opts: CallAIOptions) => Promise<CallAIResult>): Promise<string> {
    const r = await callAi({ systemPrompt: 'sys', userPrompt: 'usr', tier: 'sonnet' })
    return r.text
  }
  const { result, missingFingerprints } = await runBrainScenario({
    promptVersion: 'test-brain.v1',
    brainFn: exampleBrainFn,
  })
  assert(result === 'stubbed response', 'brain function received stubbed response')
  assert(missingFingerprints.length === 0, 'no missing fingerprints when stub registered')

  // Run a scenario where the stub is missing.
  const { missingFingerprints: missing2 } = await runBrainScenario({
    promptVersion: 'test-brain.v1',
    brainFn: async (callAi) => {
      const r = await callAi({ systemPrompt: 'NEW prompt', userPrompt: 'usr', tier: 'sonnet' })
      return r.text
    },
  })
  assert(missing2.length === 1, 'missing-fingerprint reported when stub absent')

  console.log('\n=== unused stubs (drift detector) ===')
  resetStubs()
  recordBrainStub('test-brain.v1', 'used-fp', { text: 'used', inputTokens: 1, outputTokens: 1, cost: 0.001 })
  recordBrainStub('test-brain.v1', 'unused-fp', { text: 'unused', inputTokens: 1, outputTokens: 1, cost: 0.001 })
  void lookupStub('test-brain.v1', 'used-fp')
  const unused = unusedStubs()
  assert(unused.length === 1, 'one unused stub detected')
  assert(unused[0].fingerprint === 'unused-fp', 'unused stub identifies the dead fixture')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
