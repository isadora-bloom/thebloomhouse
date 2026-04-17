import { test } from '@playwright/test'

/**
 * §8 (subset) — NEEDS BUILDING
 *
 * GAP-12: Plan-tier gating is not implemented. Starter venues can currently
 *   access /intel endpoints that should be Intelligence-tier-only.
 * GAP-07: NLQ (natural-language query) does not guard against empty-data
 *   scenarios. When there is no data, it should return a "need more data"
 *   structured response; currently it hallucinates or errors.
 */

test.describe.skip('§8 Plan Tier Gating (GAP-12)', () => {
  test('starter venue cannot access /intel/dashboard market-pulse widgets', () => {})
  test('intelligence tier unlocks Market Pulse + Lost Deals analytics', () => {})
  test('enterprise tier unlocks multi-venue Portfolio rollup', () => {})
})

test.describe.skip('§8 NLQ "need more data" guard (GAP-07)', () => {
  test('NLQ returns need-more-data when fewer than N weddings seeded', () => {})
  test('NLQ returns confident answer when threshold met', () => {})
})
