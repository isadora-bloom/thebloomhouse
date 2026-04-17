import { test, expect } from '@playwright/test'
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
 * §8 Plan Tier Gating — API LAYER
 *
 * Enforcement helper: src/lib/auth/require-plan.ts
 *   On denial it returns { ok: false, status: 401 | 402 | 403, ... }.
 *   Current behavior: unauthenticated -> 401, under-tier -> 403.
 *   (Spec comment allowed 402; live code returns 403 via TIER error. Tests
 *    accept either to stay forwards-compatible.)
 *
 * Demo mode (bloom_demo=true cookie) fully bypasses the check — mirrors
 * use-plan-tier and getPlatformAuth.
 *
 * Endpoints covered (grep'd from src/app/api/**):
 *   POST   /api/intel/nlq                  (intelligence)
 *   PATCH  /api/intel/nlq                  (intelligence)
 *   GET    /api/intel/insights             (intelligence)
 *   GET    /api/intel/trends               (intelligence)
 *   POST   /api/intel/trends               (intelligence)
 *   GET    /api/intel/briefings            (intelligence)
 *   POST   /api/intel/briefings            (intelligence)
 *   GET    /api/intel/recommendations      (intelligence)
 *   PATCH  /api/intel/recommendations      (intelligence)
 *   GET    /api/intel/outcomes             (intelligence)
 *   GET    /api/intel/anomalies            (intelligence)
 *   POST   /api/intel/anomalies            (intelligence)
 *   PATCH  /api/intel/anomalies            (intelligence)
 *   GET    /api/intel/reviews              (intelligence)
 *   POST   /api/intel/reviews              (intelligence)
 *   PATCH  /api/intel/reviews              (intelligence)
 *   GET    /api/intel/market-context       (intelligence)
 *   POST   /api/intel/positioning          (intelligence)
 *   PATCH  /api/intel/insights/[id]        (intelligence) — skipped (needs
 *     a seeded insight row; gating logic identical to collection route)
 *
 * AUDIT FINDINGS:
 *
 *   BUG-08A (CRITICAL): src/lib/auth/require-plan.ts:69 calls
 *     tierMeetsMinimum() imported from src/lib/hooks/use-plan-tier.ts.
 *     That file is marked 'use client' at line 1, so Next.js refuses to
 *     execute it on the server. Every requirePlan() call throws:
 *       "Attempted to call tierMeetsMinimum() from the server but
 *        tierMeetsMinimum is on the client..."
 *     The route's outer try/catch swallows it and returns a generic
 *     500. Net effect: API-layer plan gating is CURRENTLY BROKEN on
 *     EVERY intel endpoint. Starter-tier users don't get a clean 403
 *     — they get a 500, and the endpoint never reaches its work.
 *     Fix: move tierMeetsMinimum + TIER_DISPLAY + PlanTier into a
 *     non-client module (e.g. src/lib/auth/plan-tiers.ts) and import
 *     from there in both the hook and require-plan. This spec fails
 *     against today's code and will pass once that refactor lands.
 *
 *   Endpoints that SHOULD have requirePlan but don't:
 *   - src/app/api/portal/sage/route.ts — Sage chat. No plan check. Starter
 *     tier blueprint says Sage is available to all tiers so this may be
 *     intentional; flag for confirmation.
 *   - src/app/api/agent/** — Agent endpoints. Blueprint tiers Agent at
 *     starter so no gating required, but the absence should be explicit.
 *   - src/app/api/intel/portfolio/* — referenced in the old pending spec
 *     as enterprise-only; not present in the filesystem at all, so the
 *     enterprise-tier test below is skipped until that route exists.
 *
 * Shape of this file:
 *   - For each protected endpoint, two tests: starter (expect 403) and
 *     intelligence (expect "not a gating error", i.e. not 401/402/403 with
 *     error='plan_required'). Bodies may fail validation after that — fine.
 *   - One test asserting demo mode bypass.
 */

// Discriminator over the endpoint table. `ok` statuses are anything that
// isn't a plan-gating error from require-plan.ts: 200, 400, 404, 500 etc.
// (Validation failures after gating passes count as "plan check passed".)
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

interface EndpointCase {
  name: string
  method: Method
  path: string
  body?: unknown // for POST/PATCH
}

const ENDPOINTS: EndpointCase[] = [
  { name: 'POST /api/intel/nlq', method: 'POST', path: '/api/intel/nlq', body: { query: 'test' } },
  { name: 'PATCH /api/intel/nlq', method: 'PATCH', path: '/api/intel/nlq', body: { queryId: '00000000-0000-0000-0000-000000000000', helpful: true } },
  { name: 'GET /api/intel/insights', method: 'GET', path: '/api/intel/insights' },
  { name: 'GET /api/intel/trends', method: 'GET', path: '/api/intel/trends' },
  { name: 'POST /api/intel/trends', method: 'POST', path: '/api/intel/trends', body: {} },
  { name: 'GET /api/intel/briefings', method: 'GET', path: '/api/intel/briefings' },
  { name: 'POST /api/intel/briefings', method: 'POST', path: '/api/intel/briefings', body: { type: 'weekly' } },
  { name: 'GET /api/intel/recommendations', method: 'GET', path: '/api/intel/recommendations' },
  { name: 'PATCH /api/intel/recommendations', method: 'PATCH', path: '/api/intel/recommendations', body: { recommendationId: '00000000-0000-0000-0000-000000000000', status: 'applied' } },
  { name: 'GET /api/intel/outcomes', method: 'GET', path: '/api/intel/outcomes' },
  { name: 'GET /api/intel/anomalies', method: 'GET', path: '/api/intel/anomalies' },
  { name: 'POST /api/intel/anomalies', method: 'POST', path: '/api/intel/anomalies', body: {} },
  { name: 'PATCH /api/intel/anomalies', method: 'PATCH', path: '/api/intel/anomalies', body: { alertId: '00000000-0000-0000-0000-000000000000' } },
  { name: 'GET /api/intel/reviews', method: 'GET', path: '/api/intel/reviews' },
  { name: 'POST /api/intel/reviews', method: 'POST', path: '/api/intel/reviews', body: {} },
  { name: 'PATCH /api/intel/reviews', method: 'PATCH', path: '/api/intel/reviews', body: { phraseId: '00000000-0000-0000-0000-000000000000', target: 'sage' } },
  { name: 'GET /api/intel/market-context', method: 'GET', path: '/api/intel/market-context' },
  { name: 'POST /api/intel/positioning', method: 'POST', path: '/api/intel/positioning', body: {} },
]

async function dispatch(
  request: import('@playwright/test').APIRequestContext,
  ep: EndpointCase
) {
  // Use an explicit 45s timeout: NLQ etc. can dial Claude which occasionally
  // stalls past the default 15s action timeout. We only need status codes
  // back; body can be slow.
  const timeout = 45_000
  switch (ep.method) {
    case 'GET':
      return request.get(ep.path, { timeout })
    case 'POST':
      return request.post(ep.path, { data: ep.body ?? {}, timeout })
    case 'PATCH':
      return request.patch(ep.path, { data: ep.body ?? {}, timeout })
    case 'DELETE':
      return request.delete(ep.path, { timeout })
  }
}

test.describe('§8 Plan Gating — API layer', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  // ---------------------------------------------------------------------------
  // Starter-tier: every intelligence-gated endpoint must return 403 with
  // error='plan_required' + required_tier='intelligence'.
  // ---------------------------------------------------------------------------
  for (const ep of ENDPOINTS) {
    test(`starter-tier blocked: ${ep.name}`, async ({ browser }) => {
      test.setTimeout(60_000)
      const { orgId } = await createTestOrg(ctx)
      const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'starter' })
      const coord = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })

      const handle = await loginAsApi(
        browser,
        'coordinator',
        { email: coord.email, password: coord.password },
        { venueId }
      )

      try {
        const res = await dispatch(handle.request, ep)
        const status = res.status()
        const body = await res.json().catch(() => ({}))
        // BUG-08A: today this is 500 (crash in tierMeetsMinimum import).
        // Once fixed, require-plan returns 403 for under-tier.
        expect(
          [402, 403],
          `BUG-08A expected 403 plan_required; got status=${status} body=${JSON.stringify(body).slice(0, 200)}`
        ).toContain(status)
        expect(body.error).toBe('plan_required')
        expect(body.required_tier).toBe('intelligence')
        expect(body.current_tier).toBe('starter')
      } finally {
        await handle.close()
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Intelligence-tier: plan check passes. Request may still fail on validation
  // (400/404/500) but MUST NOT return the plan-gating shape. The gate passing
  // means we see getPlatformAuth or business-logic responses.
  // ---------------------------------------------------------------------------
  for (const ep of ENDPOINTS) {
    test(`intelligence-tier allowed: ${ep.name}`, async ({ browser }) => {
      test.setTimeout(60_000)
      const { orgId } = await createTestOrg(ctx)
      const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })
      const coord = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })

      const handle = await loginAsApi(
        browser,
        'coordinator',
        { email: coord.email, password: coord.password },
        { venueId }
      )

      try {
        const res = await dispatch(handle.request, ep)
        const status = res.status()
        const body = await res.json().catch(() => ({}))

        // Fail if we get back the plan-required shape. Any other outcome
        // (200, 400, 404, 429, 500 ...) is fine for this assertion because it
        // means the plan gate let the request through.
        const isPlanGated =
          (status === 402 || status === 403) && body?.error === 'plan_required'

        expect(
          isPlanGated,
          `intelligence-tier user hit plan gate on ${ep.name} (status=${status}, body=${JSON.stringify(body).slice(0, 200)})`
        ).toBe(false)
      } finally {
        await handle.close()
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Demo-mode bypass: bloom_demo=true cookie should short-circuit requirePlan
  // regardless of the authenticated user's venue tier. Per require-plan.ts
  // lines 33-37: cookie check happens before any auth or tier lookup.
  // ---------------------------------------------------------------------------
  test('demo mode bypasses plan gating (bloom_demo=true cookie)', async ({ browser }) => {
    test.setTimeout(60_000)
    // Note: intentionally no user login. Demo cookie alone should let the
    // plan check pass. getPlatformAuth will also pass via its own demo path,
    // so the endpoint proceeds to its normal work.
    const context = await browser.newContext()
    try {
      await context.addCookies([
        {
          name: 'bloom_demo',
          value: 'true',
          domain: 'localhost',
          path: '/',
        },
      ])
      const page = await context.newPage()
      // GET a lightweight intel endpoint — the plan gate check should
      // short-circuit on the bloom_demo cookie before any work runs.
      // Use /api/intel/market-context (GET, no Claude call) to keep the demo
      // test fast and reliable.
      const res = await page.request.get('/api/intel/market-context', {
        timeout: 45_000,
      })
      const status = res.status()
      const body = await res.json().catch(() => ({}))
      const isPlanGated =
        (status === 402 || status === 403) && body?.error === 'plan_required'
      expect(
        isPlanGated,
        `demo mode did not bypass plan gate (status=${status}, body=${JSON.stringify(body).slice(0, 200)})`
      ).toBe(false)
    } finally {
      await context.close()
    }
  })

  // ---------------------------------------------------------------------------
  // Unauthenticated caller: require-plan.ts returns 401. Demo cookie absent,
  // no Supabase session cookies. This also confirms the helper isn't silently
  // passing auth via some other channel.
  // ---------------------------------------------------------------------------
  test('unauthenticated request to protected endpoint returns 401', async ({ browser }) => {
    test.setTimeout(60_000)
    const context = await browser.newContext()
    try {
      await context.clearCookies()
      const page = await context.newPage()
      const res = await page.request.get('/api/intel/market-context', {
        timeout: 45_000,
      })
      // require-plan returns 401 with error='unauthorized' before doing tier
      // lookup.
      expect(res.status()).toBe(401)
      const body = await res.json().catch(() => ({}))
      expect(body.error).toBe('unauthorized')
    } finally {
      await context.close()
    }
  })
})

test.describe.skip('§8 Plan Gating — enterprise-tier endpoints (not built)', () => {
  // The original pending spec referenced /api/intel/portfolio/* as
  // enterprise-only. No such route exists in src/app/api. Re-enable when
  // the portfolio routes ship.
  test('intelligence venue blocked from enterprise-only /api/intel/portfolio', () => {})
})
