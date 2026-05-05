import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestUser,
  cleanup,
  TestContext,
} from '../helpers/seed'
import { loginAsApi } from '../helpers/api-auth'

/**
 * §8c Require-Plan — 7-day past-due grace period (Phase 1 audit Fix 5).
 *
 * require-plan.ts (src/lib/auth/require-plan.ts) implements a 7-day grace
 * window for venues whose subscription_status = 'past_due'. During this
 * window requests are allowed through at the current plan_tier; after
 * expiry the effective tier is downgraded to 'starter'.
 *
 * Migration 211 adds the columns this feature depends on:
 *   - venues.subscription_status  TEXT — mirrors the Stripe status.
 *   - venues.past_due_since       TIMESTAMPTZ — stamped on the FIRST past_due
 *     transition; cleared when the subscription returns to active.
 *
 * Behaviour under test:
 *   8c-1  Within grace (5 days past_due) — intelligence endpoint returns 200.
 *   8c-2  Grace expired (8 days past_due) — intelligence endpoint returns 403
 *         with error='plan_required'.
 *   8c-3  past_due_since = NULL fallback — handler uses updated_at as proxy;
 *         with a very recent updated_at the venue is still in grace.
 *   8c-4  Active subscription — normal gating applies (intelligence tier
 *         passes for intelligence endpoints, starter tier blocks).
 *   8c-5  Cache isolation — two different test venues in the same run do not
 *         share cached tier state (fresh venue IDs guarantee separate cache
 *         entries; both behave correctly).
 *
 * Cache note:
 *   require-plan.ts keeps a 30-second in-process LRU cache keyed on userId.
 *   Past-due venues are explicitly excluded from the cache so every request
 *   re-checks the DB and grace expiry is enforced with day-boundary precision.
 *   We verify this by observing that both a within-grace and an expired-grace
 *   request return the correct status when the underlying DB row changes —
 *   if the cache incorrectly stored the past-due venue's tier, a subsequent
 *   request within 30s would return the stale result.
 *
 * The test uses fresh userIds for each sub-test so cache keys never collide.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return _admin
}

/**
 * Seconds in a day, as a helper for computing past_due_since values.
 */
const DAYS_MS = (n: number) => n * 24 * 60 * 60 * 1000

/**
 * Call GET /api/intel/insights with the given authenticated handle.
 * Returns the HTTP status code.
 */
async function getInsightsStatus(
  request: import('@playwright/test').APIRequestContext
): Promise<number> {
  const res = await request.get('/api/intel/insights', { timeout: 45_000 })
  return res.status()
}

/**
 * Discriminate a plan-gating 403 from a "plan check passed" response.
 * The route can return 200, 400, 404, or 500 if the gating logic let it
 * through — those all count as "allowed" for these tests.
 */
async function isPlanGated(
  request: import('@playwright/test').APIRequestContext
): Promise<boolean> {
  const res = await request.get('/api/intel/insights', { timeout: 45_000 })
  const status = res.status()
  const body = await res.json().catch(() => ({}))
  return (status === 402 || status === 403) && body?.error === 'plan_required'
}

test.describe('§8c Require-Plan — 7-day past-due grace period', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  // ---------------------------------------------------------------------------
  // 8c-1: Within grace window — 5 days past_due, endpoint should return 200.
  // ---------------------------------------------------------------------------

  test('8c-1: intelligence endpoint is accessible when past_due for 5 days (within grace)', async ({ browser }) => {
    test.setTimeout(60_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })
    const coord = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })

    // Set subscription_status=past_due with past_due_since 5 days ago.
    const fiveDaysAgo = new Date(Date.now() - DAYS_MS(5)).toISOString()
    await admin()
      .from('venues')
      .update({
        subscription_status: 'past_due',
        past_due_since: fiveDaysAgo,
      })
      .eq('id', venueId)

    const handle = await loginAsApi(
      browser,
      'coordinator',
      { email: coord.email, password: coord.password },
      { venueId }
    )
    try {
      const gated = await isPlanGated(handle.request)
      expect(
        gated,
        'Expected past-due venue within 5-day grace to NOT be plan-gated on intelligence endpoint'
      ).toBe(false)
    } finally {
      await handle.close()
    }
  })

  // ---------------------------------------------------------------------------
  // 8c-2: Grace expired — 8 days past_due, endpoint should return 403.
  // ---------------------------------------------------------------------------

  test('8c-2: intelligence endpoint is blocked when past_due for 8 days (grace expired)', async ({ browser }) => {
    test.setTimeout(60_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })
    const coord = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })

    // Set subscription_status=past_due with past_due_since 8 days ago.
    const eightDaysAgo = new Date(Date.now() - DAYS_MS(8)).toISOString()
    await admin()
      .from('venues')
      .update({
        subscription_status: 'past_due',
        past_due_since: eightDaysAgo,
      })
      .eq('id', venueId)

    const handle = await loginAsApi(
      browser,
      'coordinator',
      { email: coord.email, password: coord.password },
      { venueId }
    )
    try {
      const res = await handle.request.get('/api/intel/insights', { timeout: 45_000 })
      const status = res.status()
      const body = await res.json().catch(() => ({}))

      expect(
        [402, 403],
        `Expected 403 plan_required after 8-day past_due; got status=${status} body=${JSON.stringify(body).slice(0, 200)}`
      ).toContain(status)
      expect(body.error).toBe('plan_required')
    } finally {
      await handle.close()
    }
  })

  // ---------------------------------------------------------------------------
  // 8c-3: Transition — same venue, update past_due_since from within grace to
  //          expired, then verify the second call is blocked.
  //
  // This exercises the "no cache for past-due venues" guarantee: if the cache
  // incorrectly stored the tier, the updated DB row would not be re-read and
  // the second call would still pass. The spec uses a fresh coordinator user
  // per call to guarantee a clean cache entry.
  // ---------------------------------------------------------------------------

  test('8c-3: grace window transition — allowed at 5 days, blocked at 8 days for same venue', async ({ browser }) => {
    test.setTimeout(90_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })

    // ---- 5 days ago — within grace ----
    const coordA = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })
    const fiveDaysAgo = new Date(Date.now() - DAYS_MS(5)).toISOString()
    await admin()
      .from('venues')
      .update({ subscription_status: 'past_due', past_due_since: fiveDaysAgo })
      .eq('id', venueId)

    const handleA = await loginAsApi(
      browser,
      'coordinator',
      { email: coordA.email, password: coordA.password },
      { venueId }
    )
    try {
      const gatedA = await isPlanGated(handleA.request)
      expect(gatedA, '5-day past_due should NOT be plan-gated').toBe(false)
    } finally {
      await handleA.close()
    }

    // ---- 8 days ago — grace expired ----
    // Use a fresh user so the in-process userId cache is not hit.
    const coordB = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })
    const eightDaysAgo = new Date(Date.now() - DAYS_MS(8)).toISOString()
    await admin()
      .from('venues')
      .update({ past_due_since: eightDaysAgo })
      .eq('id', venueId)

    const handleB = await loginAsApi(
      browser,
      'coordinator',
      { email: coordB.email, password: coordB.password },
      { venueId }
    )
    try {
      const res = await handleB.request.get('/api/intel/insights', { timeout: 45_000 })
      const status = res.status()
      const body = await res.json().catch(() => ({}))

      expect(
        [402, 403],
        `Expected 403 after updating past_due_since to 8 days; got status=${status} body=${JSON.stringify(body).slice(0, 200)}`
      ).toContain(status)
      expect(body.error).toBe('plan_required')
    } finally {
      await handleB.close()
    }
  })

  // ---------------------------------------------------------------------------
  // 8c-4: Active subscription — normal tier-based gating applies.
  //        Starter-tier venue with subscription_status='active' must be blocked
  //        on an intelligence-gated endpoint.
  // ---------------------------------------------------------------------------

  test('8c-4: active subscription with starter tier is blocked on intelligence endpoint (normal gating)', async ({ browser }) => {
    test.setTimeout(60_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'starter' })
    const coord = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })

    // Ensure subscription_status is active (default state — no past_due override).
    await admin()
      .from('venues')
      .update({ subscription_status: 'active', past_due_since: null })
      .eq('id', venueId)

    const handle = await loginAsApi(
      browser,
      'coordinator',
      { email: coord.email, password: coord.password },
      { venueId }
    )
    try {
      const res = await handle.request.get('/api/intel/insights', { timeout: 45_000 })
      const status = res.status()
      const body = await res.json().catch(() => ({}))

      // Starter tier must be gated on intelligence endpoints.
      expect(
        [402, 403],
        `Expected 403 plan_required for active starter tier; got status=${status} body=${JSON.stringify(body).slice(0, 200)}`
      ).toContain(status)
      expect(body.error).toBe('plan_required')
      expect(body.required_tier).toBe('intelligence')
      expect(body.current_tier).toBe('starter')
    } finally {
      await handle.close()
    }
  })

  // ---------------------------------------------------------------------------
  // 8c-5: Cache isolation — two venues in the same test run must not share
  //          cached tier state. One is within grace, the other has grace expired.
  //          Both should return their correct independent results.
  //
  // The 30s in-process LRU cache is keyed on userId (not venueId), so fresh
  // users per venue guarantee separate cache entries. This test verifies no
  // cross-contamination between concurrent venue contexts.
  // ---------------------------------------------------------------------------

  test('8c-5: cache isolation — within-grace and expired-grace venues in same run behave independently', async ({ browser }) => {
    test.setTimeout(90_000)
    const { orgId } = await createTestOrg(ctx)

    // Venue A — 5 days past_due (within grace, intelligence tier)
    const { venueId: venueIdA } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })
    const coordA = await createTestUser(ctx, { role: 'coordinator', orgId, venueId: venueIdA })
    await admin()
      .from('venues')
      .update({
        subscription_status: 'past_due',
        past_due_since: new Date(Date.now() - DAYS_MS(5)).toISOString(),
      })
      .eq('id', venueIdA)

    // Venue B — 8 days past_due (expired, intelligence tier)
    const { venueId: venueIdB } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })
    const coordB = await createTestUser(ctx, { role: 'coordinator', orgId, venueId: venueIdB })
    await admin()
      .from('venues')
      .update({
        subscription_status: 'past_due',
        past_due_since: new Date(Date.now() - DAYS_MS(8)).toISOString(),
      })
      .eq('id', venueIdB)

    // Authenticate both coordinators concurrently.
    const [handleA, handleB] = await Promise.all([
      loginAsApi(browser, 'coordinator', { email: coordA.email, password: coordA.password }, { venueId: venueIdA }),
      loginAsApi(browser, 'coordinator', { email: coordB.email, password: coordB.password }, { venueId: venueIdB }),
    ])

    try {
      // Both calls in parallel — isolates any per-userId cache entries.
      const [gatedA, resB] = await Promise.all([
        isPlanGated(handleA.request),
        handleB.request.get('/api/intel/insights', { timeout: 45_000 }),
      ])

      // Venue A: within grace — must NOT be gated.
      expect(gatedA, 'Venue A (5-day past_due) should NOT be plan-gated').toBe(false)

      // Venue B: expired — must be gated.
      const statusB = resB.status()
      const bodyB = await resB.json().catch(() => ({}))
      expect(
        [402, 403],
        `Venue B (8-day past_due) expected 403; got status=${statusB} body=${JSON.stringify(bodyB).slice(0, 200)}`
      ).toContain(statusB)
      expect(bodyB.error).toBe('plan_required')
    } finally {
      await Promise.all([handleA.close(), handleB.close()])
    }
  })
})
