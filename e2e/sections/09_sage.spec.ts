import { test, expect, request as pwRequest } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestWedding,
  cleanup,
  TestContext,
} from '../helpers/seed'
import {
  cleanupRateLimits,
  cleanupSageConversations,
  seedSageContext,
  testRateLimitPrefix,
} from '../helpers/sage-seed'

/**
 * §9 SAGE (couple-facing AI chat)
 *
 * This spec verifies the four invariants Sage depends on:
 *
 *   a) Rate limiter atomicity. `increment_rate_limit(key, limit, window_sec)`
 *      is called 20x in a burst with limit=5 and must return exactly 5
 *      allowed=true rows — proof that the RPC's UPSERT serialises rather
 *      than races (BUG-12, migration 053).
 *
 *   b) Transcript persistence. The Sage portal endpoint persists the user's
 *      message + assistant reply to `sage_conversations`. We do NOT call the
 *      live Anthropic API from tests — the node-side SDK call is made inside
 *      /api/portal/sage, so Playwright's browser-context `page.route()` can't
 *      intercept it. Instead we assert the same DB path by invoking the
 *      context-builder logic (mirrored from src/lib/services/sage-brain.ts
 *      getWeddingContext) and separately assert that direct inserts to
 *      sage_conversations round-trip.
 *
 *   c) Venue scope. Two wedding records under two venues. sage_conversations
 *      rows written under venue A's wedding are NOT returned when filtering
 *      by venue B — a minimal tenancy guard at the data layer.
 *
 *   d) Rate-limit enforcement end-to-end. After pre-filling the rate_limits
 *      row to the cap, /api/portal/sage returns 429 Too Many Requests.
 *
 * Notes:
 *   - /api/couple/sage does not exist at the time of writing. The couple
 *     portal talks to /api/portal/sage directly (see
 *     src/app/couple/[slug]/sage/page.tsx and similar). Tests target that.
 *   - The Sage endpoint currently takes venueId/weddingId from the request
 *     body without enforcing that the caller's Supabase session owns the
 *     wedding. That's a separate auth finding, documented in the report.
 *     This spec asserts the *data* scope; auth enforcement would require a
 *     code change.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

/**
 * Probes whether migration 053 has been applied. When missing, all rate-limit
 * assertions are skipped with a TODO rather than hard-failing — the migration
 * has to be run before the live app can enforce limits either.
 */
async function rateLimitsTableExists(): Promise<boolean> {
  const { error } = await admin().from('rate_limits').select('key').limit(1)
  return !error
}

test.describe('§9 Sage (couple chat)', () => {
  let ctx: TestContext
  const extraRateLimitKeys: string[] = []

  test.beforeEach(() => {
    ctx = createContext()
    extraRateLimitKeys.length = 0
  })

  test.afterEach(async () => {
    await cleanupSageConversations(ctx.createdWeddingIds)
    await cleanupRateLimits(ctx, extraRateLimitKeys)
    await cleanup(ctx)
  })

  // ---------------------------------------------------------------------------
  // a) Rate limiter atomicity
  // ---------------------------------------------------------------------------

  test('a) increment_rate_limit is atomic under burst (20 parallel, limit=5 => 5 allowed)', async () => {
    if (!(await rateLimitsTableExists())) {
      test.skip(true, 'TODO: migration 053_rate_limits.sql not applied to this Supabase project — rate_limits table + increment_rate_limit RPC missing. Apply the migration to enable this test.')
    }
    const key = `${testRateLimitPrefix(ctx)}atomic`
    const limit = 5
    const windowSec = 60

    // Ensure no prior state
    await admin().from('rate_limits').delete().eq('key', key)

    const burst = 20
    const results = await Promise.all(
      Array.from({ length: burst }).map(() =>
        admin()
          .rpc('increment_rate_limit', {
            p_key: key,
            p_limit: limit,
            p_window_sec: windowSec,
          })
          .then((r) => {
            if (r.error) throw new Error(`RPC error: ${r.error.message}`)
            const row = Array.isArray(r.data) ? r.data[0] : r.data
            return Boolean(row?.allowed)
          })
      )
    )

    const allowedCount = results.filter(Boolean).length
    const deniedCount = results.length - allowedCount

    expect(
      allowedCount,
      `expected exactly ${limit} of ${burst} concurrent calls to be allowed (got ${allowedCount} allowed / ${deniedCount} denied)`
    ).toBe(limit)
    expect(deniedCount).toBe(burst - limit)

    // The row's final count should equal burst (every call increments).
    const { data: row } = await admin()
      .from('rate_limits')
      .select('count')
      .eq('key', key)
      .single()
    expect(Number(row?.count)).toBe(burst)
  })

  // ---------------------------------------------------------------------------
  // b) Transcript persistence + context builder
  // ---------------------------------------------------------------------------

  test('b1) sage_conversations persists user + assistant turns for a wedding', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })

    // Mirror what /api/portal/sage does at step 6: inserts a 'user' row, then
    // later an 'assistant' row. We assert the table accepts both roles and
    // round-trips.
    const userMsg = `Hi Sage, what time is setup? [e2e:${ctx.testId}]`
    const assistantMsg = `Setup begins at 10am. [e2e:${ctx.testId}]`

    const { error: uerr } = await admin().from('sage_conversations').insert({
      venue_id: venueId,
      wedding_id: wedding.weddingId,
      role: 'user',
      content: userMsg,
    })
    expect(uerr).toBeNull()

    const { error: aerr } = await admin().from('sage_conversations').insert({
      venue_id: venueId,
      wedding_id: wedding.weddingId,
      role: 'assistant',
      content: assistantMsg,
      model_used: 'claude-sonnet-4-20250514',
      tokens_used: 420,
      cost: 0.0042,
      confidence_score: 95,
      flagged_uncertain: false,
    })
    expect(aerr).toBeNull()

    const { data: rows } = await admin()
      .from('sage_conversations')
      .select('role, content, confidence_score')
      .eq('wedding_id', wedding.weddingId)
      .order('created_at', { ascending: true })
    expect(rows?.length).toBe(2)
    expect(rows![0].role).toBe('user')
    expect(rows![0].content).toBe(userMsg)
    expect(rows![1].role).toBe('assistant')
    expect(rows![1].content).toBe(assistantMsg)
    expect(rows![1].confidence_score).toBe(95)

    // CHECK constraint enforces role IN ('user','assistant')
    const { error: badRoleErr } = await admin().from('sage_conversations').insert({
      venue_id: venueId,
      wedding_id: wedding.weddingId,
      role: 'system',
      content: 'nope',
    })
    expect(badRoleErr).not.toBeNull()
  })

  test('b2) context builder pulls budgetTotal, budgetSpent, checklist totals, timeline count', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })

    await seedSageContext(venueId, wedding.weddingId, {
      totalBudget: 60000,
      paidAmounts: [2500, 1500, 3000], // spent = 7000
      checklistCount: 5,
      checklistCompleteCount: 3,
      timelineCount: 4,
    })

    // Replicate sage-brain's getWeddingContext reads exactly.
    const a = admin()

    const { data: cfg } = await a
      .from('wedding_config')
      .select('total_budget')
      .eq('wedding_id', wedding.weddingId)
      .maybeSingle()
    expect(Number(cfg?.total_budget)).toBe(60000)

    const { data: budgetItems } = await a
      .from('budget_items')
      .select('paid')
      .eq('wedding_id', wedding.weddingId)
    const spent = (budgetItems ?? []).reduce(
      (sum: number, r: { paid: number }) => sum + (Number(r.paid) || 0),
      0
    )
    expect(spent).toBe(7000)

    const { count: checklistTotal } = await a
      .from('checklist_items')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', wedding.weddingId)
    const { count: checklistDone } = await a
      .from('checklist_items')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', wedding.weddingId)
      .eq('is_completed', true)
    expect(checklistTotal).toBe(5)
    expect(checklistDone).toBe(3)

    const { count: timelineCount } = await a
      .from('timeline')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', wedding.weddingId)
    expect(timelineCount).toBe(4)
  })

  // ---------------------------------------------------------------------------
  // c) Venue scope
  // ---------------------------------------------------------------------------

  test('c) sage_conversations stay scoped to their venue + wedding', async () => {
    const { orgId: orgIdA } = await createTestOrg(ctx, { name: `E2E Sage Org A [e2e:${ctx.testId}]` })
    const { orgId: orgIdB } = await createTestOrg(ctx, { name: `E2E Sage Org B [e2e:${ctx.testId}]` })
    const { venueId: venueA } = await createTestVenue(ctx, { orgId: orgIdA })
    const { venueId: venueB } = await createTestVenue(ctx, { orgId: orgIdB })
    const weddingA = await createTestWedding(ctx, { venueId: venueA })
    const weddingB = await createTestWedding(ctx, { venueId: venueB })

    const secretA = `VENUE-A-ONLY ${ctx.testId}`
    const secretB = `VENUE-B-ONLY ${ctx.testId}`
    await admin().from('sage_conversations').insert([
      { venue_id: venueA, wedding_id: weddingA.weddingId, role: 'user', content: secretA },
      { venue_id: venueA, wedding_id: weddingA.weddingId, role: 'assistant', content: `assistant:${secretA}` },
      { venue_id: venueB, wedding_id: weddingB.weddingId, role: 'user', content: secretB },
    ])

    // Query scoped to venue B's wedding: should NOT see venue A's secret
    const { data: bRows } = await admin()
      .from('sage_conversations')
      .select('content')
      .eq('wedding_id', weddingB.weddingId)
    const bContents = (bRows ?? []).map((r) => r.content as string)
    expect(bContents).toEqual(expect.arrayContaining([secretB]))
    expect(bContents.some((c) => c.includes('VENUE-A-ONLY'))).toBe(false)

    // Mirror the loader in /api/portal/sage (step 2): filters by wedding_id
    // only. Venue B's wedding must never surface venue A's transcript.
    const { data: asSageLoader } = await admin()
      .from('sage_conversations')
      .select('role, content')
      .eq('wedding_id', weddingB.weddingId)
      .order('created_at', { ascending: false })
      .limit(20)
    expect(asSageLoader?.every((r) => !String(r.content).includes('VENUE-A-ONLY'))).toBe(true)

    // And the reverse direction
    const { data: aRows } = await admin()
      .from('sage_conversations')
      .select('content')
      .eq('wedding_id', weddingA.weddingId)
    expect((aRows ?? []).some((r) => String(r.content).includes('VENUE-B-ONLY'))).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // d) Rate-limit enforcement end-to-end
  // ---------------------------------------------------------------------------

  test('d) /api/portal/sage returns 429 once the window cap is hit', async ({ baseURL }) => {
    if (!(await rateLimitsTableExists())) {
      test.skip(true, 'TODO: migration 053_rate_limits.sql not applied — endpoint currently falls through to "allow" on RPC error (graceful degradation), so 429 cannot be asserted until the migration is run.')
    }
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })

    // The endpoint uses key=`sage:${weddingId || venueId || 'anonymous'}`
    // with limit=20 / windowSec=900. Pre-fill rate_limits so the next call
    // trips the cap without burning 20 LLM requests.
    const rlKey = `sage:${wedding.weddingId}`
    extraRateLimitKeys.push(rlKey)
    await admin().from('rate_limits').delete().eq('key', rlKey)
    const { error: preErr } = await admin().from('rate_limits').insert({
      key: rlKey,
      window_start: new Date().toISOString(),
      count: 20, // == limit, so next increment => 21 > 20 => denied
      updated_at: new Date().toISOString(),
    })
    expect(preErr).toBeNull()

    const apiContext = await pwRequest.newContext({ baseURL })
    try {
      const res = await apiContext.post('/api/portal/sage', {
        data: {
          venueId,
          weddingId: wedding.weddingId,
          message: `rate-limit probe [e2e:${ctx.testId}]`,
        },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.status()).toBe(429)
      const retryAfter = res.headers()['retry-after']
      expect(retryAfter, 'Retry-After header should be present on 429').toBeTruthy()
      const body = await res.json().catch(() => ({}))
      expect(String(body.error ?? '')).toMatch(/too many|wait/i)
    } finally {
      await apiContext.dispose()
    }
  })
})
