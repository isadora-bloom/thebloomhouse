import { test } from '@playwright/test'

/**
 * §8 Plan Tier Gating — API LAYER (unbuilt)
 *
 * The UI layer IS built and tested in e2e/sections/08a_plan_gating_ui.spec.ts.
 * What remains unbuilt:
 *
 *   API endpoints do NOT check plan_tier before doing work. A starter-tier
 *   venue's coordinator can hit endpoints that should require 'intelligence'
 *   or 'enterprise' directly via fetch:
 *     - /api/intel/nlq          (should require 'intelligence')
 *     - /api/intel/briefings/*  (should require 'intelligence')
 *     - /api/intel/portfolio/*  (should require 'enterprise')
 *
 *   Confirmed via Grep: no file under src/app/api uses usePlanTier /
 *   tierHasFeature / plan_tier checks. The only plan_tier read sites are the
 *   UI hook and the Stripe webhook writer.
 *
 * These tests stay skipped until the gating middleware / decorator is in place.
 *
 * Also still unbuilt from the original GAP-07:
 *   NLQ "not enough data" guard when venue has < N weddings.
 */

test.describe.skip('§8 Plan Tier Gating — API layer (GAP-12 remainder)', () => {
  test('starter venue cannot POST /api/intel/nlq (403 or tier-gated error)', () => {})
  test('starter venue cannot GET /api/intel/briefings (403 or tier-gated error)', () => {})
  test('intelligence venue cannot hit enterprise-only /api/intel/portfolio/*', () => {})
  test('enterprise tier unlocks multi-venue Portfolio rollup', () => {})
})

test.describe.skip('§8 NLQ "need more data" guard (GAP-07)', () => {
  test('NLQ returns need-more-data when fewer than N weddings seeded', () => {})
  test('NLQ returns confident answer when threshold met', () => {})
})
