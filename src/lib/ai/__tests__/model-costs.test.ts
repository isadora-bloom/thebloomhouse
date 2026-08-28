import { describe, it, expect } from 'vitest'
import { CLAUDE_COSTS, OPENAI_COSTS, calculateCost } from '@/lib/ai/cost-tracker'
import { CLAUDE_MODEL, HAIKU_MODEL, OPUS_MODEL, OPENAI_FALLBACK_MODEL } from '@/lib/ai/client'

/**
 * Price-drift guard.
 *
 * Both current-model rows in CLAUDE_COSTS were wrong for months because each
 * was copied off the legacy row above it instead of looked up, and nothing
 * compared either one to the provider's published list. There is no price
 * endpoint to check against the way model-currency.ts checks model IDs, so
 * this is the next best control: the numbers are pinned here as well as
 * declared there, and changing one without the other fails the build.
 *
 * If a provider genuinely changes a price, update both and say so in the
 * commit. The point is that the edit has to be deliberate.
 *
 * Source: anthropic.com/pricing and openai.com/api/pricing, USD per million
 * tokens, checked 2026-08-28.
 */
describe('model cost constants', () => {
  it('prices every model the router can actually select', () => {
    for (const model of [CLAUDE_MODEL, HAIKU_MODEL, OPUS_MODEL]) {
      expect(CLAUDE_COSTS[model as keyof typeof CLAUDE_COSTS]).toBeDefined()
    }
    expect(OPENAI_COSTS[OPENAI_FALLBACK_MODEL as keyof typeof OPENAI_COSTS]).toBeDefined()
  })

  it('matches the published per-million rates', () => {
    expect(CLAUDE_COSTS['claude-sonnet-4-6']).toEqual({ input: 3.0, output: 15.0 })
    expect(CLAUDE_COSTS['claude-haiku-4-5-20251001']).toEqual({ input: 1.0, output: 5.0 })
    expect(CLAUDE_COSTS['claude-opus-4-8']).toEqual({ input: 5.0, output: 25.0 })
    expect(OPENAI_COSTS['gpt-4o-mini']).toEqual({ input: 0.15, output: 0.6 })
  })

  it('keeps the legacy rows on their own historical rates', () => {
    // These exist so old api_costs rows still resolve. They must NOT be
    // dragged along when a current row is repriced, which is how the two
    // current rows got wrong in the first place.
    expect(CLAUDE_COSTS['claude-haiku-3-20240307']).toEqual({ input: 0.25, output: 1.25 })
    expect(CLAUDE_COSTS['claude-opus-4-20250514']).toEqual({ input: 15.0, output: 75.0 })
  })

  it('keeps Haiku about 3x cheaper than Sonnet, which is what the tier docs claim', () => {
    const haiku = CLAUDE_COSTS[HAIKU_MODEL as keyof typeof CLAUDE_COSTS]
    const sonnet = CLAUDE_COSTS[CLAUDE_MODEL as keyof typeof CLAUDE_COSTS]
    expect(sonnet.input / haiku.input).toBeCloseTo(3, 1)
    expect(sonnet.output / haiku.output).toBeCloseTo(3, 1)
  })

  it('computes cost per million, not per thousand', () => {
    // 1M in + 1M out on Sonnet is $18, not $18,000.
    expect(calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18, 6)
    expect(calculateCost(HAIKU_MODEL, 1_000_000, 1_000_000)).toBeCloseTo(6, 6)
  })

  it('falls back to Sonnet pricing for an unknown model rather than zero', () => {
    // A silent 0 would make an unpriced model look free in the ledger.
    expect(calculateCost('some-model-we-have-not-priced', 1_000_000, 0)).toBeCloseTo(3, 6)
  })
})
