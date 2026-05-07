/**
 * Unit tests for require-plan.ts — 30-second in-memory tier cache.
 *
 * Tests prove that:
 *   1. Supabase is only called ONCE per user within the 30-second TTL window
 *      (second call hits cache, no additional DB round-trips).
 *   2. After the TTL expires (simulated via vi.useFakeTimers), Supabase IS
 *      called again.
 *   3. Demo-token bypass returns { ok: true, isDemo: true } without any DB
 *      calls.
 *   4. Unauthenticated users (getUser returns null) → { ok: false, status: 401 }.
 *   5. A user on solo tier requesting a growth-gated route →
 *      { ok: false, status: 403 }.
 *
 * ALL external calls are mocked. No network traffic, no Supabase, no Claude.
 *
 * Mocking strategy:
 *   - `next/headers` → fake cookies() that returns no demo token cookie.
 *   - `@/lib/services/demo-token` → verifyDemoToken returns { ok: false }
 *     by default; overridden for the demo-bypass test.
 *   - `@/lib/supabase/server` → createServerSupabaseClient returns a stub
 *     with auth.getUser.
 *   - `@/lib/supabase/service` → createServiceClient returns a stub with
 *     .from().select()...chain.
 *   - `@/lib/observability/metrics` → recordCounter is a no-op.
 *
 * The tier cache is module-level state inside require-plan.ts. To ensure
 * test isolation we call vi.resetModules() before each test group and
 * dynamically import the module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Static mocks (registered before any dynamic import)
// ---------------------------------------------------------------------------

vi.mock('@/lib/observability/metrics', () => ({
  recordCounter: vi.fn().mockResolvedValue(undefined),
  recordHistogram: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/observability/redact', () => ({
  redact: (s: string) => s,
  redactError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  redactObject: <T>(obj: T) => obj,
}))

// ---------------------------------------------------------------------------
// Test fixture types
// ---------------------------------------------------------------------------

interface MockSupabaseChain {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
  order: ReturnType<typeof vi.fn>
  limit: ReturnType<typeof vi.fn>
}

function makeChain(returnValue: unknown): MockSupabaseChain {
  const chain: MockSupabaseChain = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn().mockResolvedValue(returnValue),
    maybeSingle: vi.fn().mockResolvedValue(returnValue),
    order: vi.fn(),
    limit: vi.fn(),
  }
  // Wire the fluent chain: each method returns the same chain object.
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  chain.order.mockReturnValue(chain)
  chain.limit.mockReturnValue(chain)
  return chain
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-uuid-aabbccdd'
const VENUE_ID = 'venue-uuid-11223344'
const FAKE_URL = 'http://localhost/api/test'

/**
 * Build the full mock environment and return the freshly imported requirePlan.
 *
 * getUser: what auth.getUser returns as { data: { user } }
 * profileData: .from('user_profiles') query result
 * venueData: .from('venues') query result
 * demoOk: whether verifyDemoToken should return ok: true
 */
async function buildRequirePlan({
  getUserResult = { data: { user: { id: USER_ID } } },
  profileResult = { data: { venue_id: VENUE_ID, org_id: null, role: 'coordinator' } },
  venueResult = { data: { plan_tier: 'enterprise', subscription_status: 'active', past_due_since: null, updated_at: null } },
  demoOk = false,
}: {
  getUserResult?: unknown
  profileResult?: unknown
  venueResult?: unknown
  demoOk?: boolean
} = {}) {
  // Register all mocks via doMock (respects resetModules).
  vi.doMock('next/headers', () => ({
    cookies: vi.fn().mockResolvedValue({
      get: vi.fn().mockReturnValue(undefined),
      getAll: vi.fn().mockReturnValue([]),
    }),
  }))

  vi.doMock('@/lib/services/demo-token', () => ({
    verifyDemoToken: vi.fn().mockReturnValue(
      demoOk
        ? { ok: true, payload: { kind: 'demo', demo_venue_id: 'demo-venue-id' } }
        : { ok: false, reason: 'missing' },
    ),
    DEMO_TOKEN_COOKIE: 'bloom_demo_token',
    DEMO_VENUE_ID: '22222222-2222-2222-2222-222222222201',
    signDemoToken: vi.fn(),
  }))

  // Server supabase (auth.getUser)
  const authGetUser = vi.fn().mockResolvedValue(getUserResult)
  vi.doMock('@/lib/supabase/server', () => ({
    createServerSupabaseClient: vi.fn().mockResolvedValue({
      auth: { getUser: authGetUser },
    }),
  }))

  // Service supabase (.from chain) — two different tables.
  // We need to distinguish calls by table name.
  const profileChain = makeChain(profileResult)
  const venueChain = makeChain(venueResult)

  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'user_profiles') return profileChain
    if (table === 'venues') return venueChain
    return makeChain({ data: null })
  })

  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn().mockReturnValue({ from: fromFn }),
  }))

  const { requirePlan } = await import('@/lib/auth/require-plan')

  return {
    requirePlan,
    authGetUser,
    fromFn,
    profileChain,
    venueChain,
  }
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Cache hit: second call must NOT hit Supabase
// ---------------------------------------------------------------------------

describe('30-second tier cache', () => {
  it('calls Supabase only once for the same user within the TTL window', async () => {
    const { requirePlan, authGetUser, venueChain } = await buildRequirePlan({
      venueResult: { data: { plan_tier: 'enterprise', subscription_status: 'active', past_due_since: null, updated_at: null } },
    })

    const fakeReq = new Request(FAKE_URL)

    const r1 = await requirePlan(fakeReq, 'solo')
    expect(r1.ok).toBe(true)

    const r2 = await requirePlan(fakeReq, 'solo')
    expect(r2.ok).toBe(true)

    // auth.getUser is called once per requirePlan (before cache check).
    // venue query (.single) must only have been called once — second call
    // used the cached tier.
    expect(venueChain.single).toHaveBeenCalledTimes(1)
    // authGetUser is called for both (cache only skips the DB tier lookup,
    // not auth resolution).
    expect(authGetUser).toHaveBeenCalledTimes(2)
  })

  it('calls Supabase again after the 30-second TTL expires', async () => {
    const { requirePlan, venueChain } = await buildRequirePlan({
      venueResult: { data: { plan_tier: 'growth', subscription_status: 'active', past_due_since: null, updated_at: null } },
    })

    const fakeReq = new Request(FAKE_URL)

    // First call — populates cache.
    await requirePlan(fakeReq, 'solo')
    expect(venueChain.single).toHaveBeenCalledTimes(1)

    // Advance time past the 30-second TTL.
    vi.advanceTimersByTime(31_000)

    // Second call — cache is expired, Supabase must be called again.
    await requirePlan(fakeReq, 'solo')
    expect(venueChain.single).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache within the 30-second window (same tier returned from cache)', async () => {
    const { requirePlan } = await buildRequirePlan({
      venueResult: { data: { plan_tier: 'enterprise', subscription_status: 'active', past_due_since: null, updated_at: null } },
    })

    const fakeReq = new Request(FAKE_URL)

    const r1 = await requirePlan(fakeReq, 'growth')
    const r2 = await requirePlan(fakeReq, 'growth')

    // Both must pass because enterprise >= intelligence.
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Demo bypass
// ---------------------------------------------------------------------------

describe('demo token bypass', () => {
  it('returns { ok: true, isDemo: true } without touching Supabase', async () => {
    const { requirePlan, fromFn, authGetUser } = await buildRequirePlan({ demoOk: true })

    const fakeReq = new Request(FAKE_URL)
    const result = await requirePlan(fakeReq, 'enterprise')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.isDemo).toBe(true)

    // Demo bypass must return before any DB call.
    expect(authGetUser).not.toHaveBeenCalled()
    expect(fromFn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Unauthenticated user
// ---------------------------------------------------------------------------

describe('unauthenticated user', () => {
  it('returns { ok: false, status: 401 } when getUser returns null', async () => {
    const { requirePlan } = await buildRequirePlan({
      getUserResult: { data: { user: null } },
    })

    const result = await requirePlan(new Request(FAKE_URL), 'solo')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Insufficient tier
// ---------------------------------------------------------------------------

describe('insufficient tier', () => {
  it('returns { ok: false, status: 403 } when user is on starter but route requires intelligence', async () => {
    const { requirePlan } = await buildRequirePlan({
      venueResult: { data: { plan_tier: 'solo', subscription_status: 'active', past_due_since: null, updated_at: null } },
    })

    const result = await requirePlan(new Request(FAKE_URL), 'growth')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      if ('requiredTier' in result) {
        expect(result.requiredTier).toBe('growth')
        expect(result.currentTier).toBe('solo')
      }
    }
  })

  it('returns { ok: true } when user is on intelligence and route requires starter', async () => {
    const { requirePlan } = await buildRequirePlan({
      venueResult: { data: { plan_tier: 'growth', subscription_status: 'active', past_due_since: null, updated_at: null } },
    })

    const result = await requirePlan(new Request(FAKE_URL), 'solo')

    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// No profile → 401
// ---------------------------------------------------------------------------

describe('missing profile', () => {
  it('returns { ok: false, status: 401 } when user_profiles row is missing', async () => {
    const { requirePlan } = await buildRequirePlan({
      profileResult: { data: null },
    })

    const result = await requirePlan(new Request(FAKE_URL), 'solo')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// planErrorBody shape (exported helper)
// ---------------------------------------------------------------------------

describe('planErrorBody', () => {
  it('returns { error: "unauthorized" } for status 401', async () => {
    vi.doMock('next/headers', () => ({
      cookies: vi.fn().mockResolvedValue({ get: vi.fn(), getAll: vi.fn().mockReturnValue([]) }),
    }))
    vi.doMock('@/lib/services/demo-token', () => ({
      verifyDemoToken: vi.fn().mockReturnValue({ ok: false, reason: 'missing' }),
      DEMO_TOKEN_COOKIE: 'bloom_demo_token',
      DEMO_VENUE_ID: '22222222-2222-2222-2222-222222222201',
      signDemoToken: vi.fn(),
    }))
    vi.doMock('@/lib/supabase/server', () => ({
      createServerSupabaseClient: vi.fn().mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      }),
    }))
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({ from: vi.fn() }),
    }))

    const { planErrorBody } = await import('@/lib/auth/require-plan')

    const body = planErrorBody({ ok: false, status: 401, message: 'Unauthorized' })
    expect(body.error).toBe('unauthorized')
  })

  it('returns { error: "plan_required" } with tier info for status 403', async () => {
    vi.doMock('next/headers', () => ({
      cookies: vi.fn().mockResolvedValue({ get: vi.fn(), getAll: vi.fn().mockReturnValue([]) }),
    }))
    vi.doMock('@/lib/services/demo-token', () => ({
      verifyDemoToken: vi.fn().mockReturnValue({ ok: false, reason: 'missing' }),
      DEMO_TOKEN_COOKIE: 'bloom_demo_token',
      DEMO_VENUE_ID: '22222222-2222-2222-2222-222222222201',
      signDemoToken: vi.fn(),
    }))
    vi.doMock('@/lib/supabase/server', () => ({
      createServerSupabaseClient: vi.fn().mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      }),
    }))
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({ from: vi.fn() }),
    }))

    const { planErrorBody } = await import('@/lib/auth/require-plan')

    const body = planErrorBody({
      ok: false,
      status: 403,
      message: 'Upgrade required',
      requiredTier: 'growth',
      currentTier: 'solo',
    })
    expect(body.error).toBe('plan_required')
    expect(body.required_tier).toBe('growth')
    expect(body.current_tier).toBe('solo')
  })
})
