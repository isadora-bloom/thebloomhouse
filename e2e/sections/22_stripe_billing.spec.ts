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
 * §22 Stripe Billing — End-to-end (GAP-02 closure).
 *
 * The webhook + checkout + portal + invoices stack is wired. These tests
 * exercise the parts we can drive without a live Stripe account:
 *
 *   1. POST /api/stripe/checkout requires auth + a configured priceId,
 *      validates the priceId against PLANS, and (when Stripe is configured)
 *      returns a hosted checkout URL.
 *   2. /billing/success rejects bogus session_ids without leaking metadata.
 *   3. POST /api/stripe/portal requires a stripe_customer_id on the venue.
 *   4. The webhook idempotently downgrades a venue to 'starter' on
 *      customer.subscription.deleted and writes an admin_notifications
 *      row priority='high' type='subscription_canceled'.
 *   5. invoice.payment_failed writes admin_notifications priority='high'
 *      type='payment_failed' for the matching customer.
 *   6. Webhook idempotency — replaying the same event id does NOT double
 *      notify or double-downgrade.
 *
 * Tests that need a real Stripe key/webhook secret are conditionally
 * skipped when the env isn't set, so this spec is safe to run in CI.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return _admin
}

const STRIPE_CONFIGURED = Boolean(process.env.STRIPE_SECRET_KEY)
const WEBHOOK_SECRET_SET = Boolean(process.env.STRIPE_WEBHOOK_SECRET)

test.describe('§22 Stripe billing — end-to-end', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  // ---------------------------------------------------------------------------
  // Checkout — auth + validation
  // ---------------------------------------------------------------------------

  test('POST /api/stripe/checkout — 401 when unauthenticated', async ({ request }) => {
    const res = await request.post('/api/stripe/checkout', {
      data: { priceId: 'price_anything', billingCycle: 'monthly' },
    })
    expect(res.status()).toBe(401)
  })

  test('POST /api/stripe/checkout — rejects unknown priceId', async ({ browser }) => {
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
      const res = await handle.request.post('/api/stripe/checkout', {
        data: { priceId: 'price_attacker_owned', billingCycle: 'monthly' },
      })
      expect(res.status()).toBe(400)
      const body = await res.json().catch(() => ({}))
      expect(body.error).toMatch(/unknown priceid/i)
    } finally {
      await handle.close()
    }
  })

  test('POST /api/stripe/checkout — rejects invalid billingCycle', async ({ browser }) => {
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
      const res = await handle.request.post('/api/stripe/checkout', {
        data: { priceId: 'price_x', billingCycle: 'weekly' },
      })
      expect(res.status()).toBe(400)
    } finally {
      await handle.close()
    }
  })

  // ---------------------------------------------------------------------------
  // Checkout success page — server-side session verification
  // ---------------------------------------------------------------------------

  test('/billing/success — bogus session_id returns 404 (no metadata leak)', async ({ browser }) => {
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
      // Make sure we never accept a non cs_-prefixed value, even logged in.
      const page = await handle.context.newPage()
      const res = await page.goto('/billing/success?session_id=evil_payload_here')
      expect(res?.status()).toBe(404)
    } finally {
      await handle.close()
    }
  })

  test('/billing/success — missing session_id returns 404', async ({ browser }) => {
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
      const page = await handle.context.newPage()
      const res = await page.goto('/billing/success')
      expect(res?.status()).toBe(404)
    } finally {
      await handle.close()
    }
  })

  // ---------------------------------------------------------------------------
  // Portal — requires a stripe_customer_id
  // ---------------------------------------------------------------------------

  test('POST /api/stripe/portal — 400 when venue has no Stripe customer', async ({ browser }) => {
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
      const res = await handle.request.post('/api/stripe/portal')
      expect(res.status()).toBe(400)
      const body = await res.json().catch(() => ({}))
      expect(body.error).toMatch(/no billing account/i)
    } finally {
      await handle.close()
    }
  })

  test('POST /api/stripe/portal — 401 when unauthenticated', async ({ request }) => {
    const res = await request.post('/api/stripe/portal')
    expect(res.status()).toBe(401)
  })

  // ---------------------------------------------------------------------------
  // Webhook — downgrade flow + payment_failed notifications.
  //
  // We talk to the webhook directly with synthetic payloads. When
  // STRIPE_WEBHOOK_SECRET is set we expect signature checks to fail
  // (we can't sign without the secret). When it's NOT set the route
  // accepts unsigned bodies and we can drive the full path.
  // ---------------------------------------------------------------------------

  test.describe('webhook (no signature secret)', () => {
    test.skip(WEBHOOK_SECRET_SET, 'STRIPE_WEBHOOK_SECRET set — skipping unsigned-body webhook tests')

    test('customer.subscription.deleted downgrades venue + writes high-priority notification', async ({ request }) => {
      test.setTimeout(60_000)
      const { orgId } = await createTestOrg(ctx)
      const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })

      // Stamp a subscription id so the webhook's update has something to clear.
      await admin()
        .from('venues')
        .update({
          stripe_customer_id: `cus_e2e_${ctx.testId}`,
          stripe_subscription_id: `sub_e2e_${ctx.testId}`,
        })
        .eq('id', venueId)

      const eventId = `evt_e2e_del_${ctx.testId}`
      const event = {
        id: eventId,
        type: 'customer.subscription.deleted',
        api_version: '2025-02-24.acacia',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `sub_e2e_${ctx.testId}`,
            object: 'subscription',
            status: 'canceled',
            customer: `cus_e2e_${ctx.testId}`,
            metadata: { venue_id: venueId },
            items: { data: [] },
          },
        },
      }

      const res = await request.post('/api/webhooks/stripe', { data: event })
      expect(res.status()).toBe(200)

      // Tier downgraded
      const { data: venue } = await admin()
        .from('venues')
        .select('plan_tier, stripe_subscription_id')
        .eq('id', venueId)
        .single()
      expect(venue?.plan_tier).toBe('starter')
      expect(venue?.stripe_subscription_id).toBeNull()

      // High-priority notification written
      const { data: notes } = await admin()
        .from('admin_notifications')
        .select('type, priority, title')
        .eq('venue_id', venueId)
        .eq('type', 'subscription_canceled')
      expect(notes ?? []).toHaveLength(1)
      expect(notes?.[0]?.priority).toBe('high')

      // Idempotency — replay does NOT create a second notification
      const replay = await request.post('/api/webhooks/stripe', { data: event })
      expect(replay.status()).toBe(200)
      const replayBody = await replay.json().catch(() => ({}))
      // Either the dedup table caught it or the per-notif dedup did.
      expect(replayBody.received).toBe(true)

      const { data: notes2 } = await admin()
        .from('admin_notifications')
        .select('id')
        .eq('venue_id', venueId)
        .eq('type', 'subscription_canceled')
      expect(notes2 ?? []).toHaveLength(1)

      // Cleanup the inserted stripe_events + notification rows.
      await admin().from('admin_notifications').delete().eq('venue_id', venueId)
      await admin().from('stripe_events').delete().eq('id', eventId)
    })

    test('invoice.payment_failed writes payment_failed notification priority=high', async ({ request }) => {
      test.setTimeout(60_000)
      const { orgId } = await createTestOrg(ctx)
      const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })
      const customerId = `cus_e2e_pf_${ctx.testId}`
      await admin()
        .from('venues')
        .update({ stripe_customer_id: customerId })
        .eq('id', venueId)

      const eventId = `evt_e2e_pf_${ctx.testId}`
      const event = {
        id: eventId,
        type: 'invoice.payment_failed',
        api_version: '2025-02-24.acacia',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `in_e2e_${ctx.testId}`,
            object: 'invoice',
            customer: customerId,
            amount_due: 24900,
            currency: 'usd',
            attempt_count: 2,
          },
        },
      }
      const res = await request.post('/api/webhooks/stripe', { data: event })
      expect(res.status()).toBe(200)

      const { data: notes } = await admin()
        .from('admin_notifications')
        .select('type, priority, title')
        .eq('venue_id', venueId)
        .eq('type', 'payment_failed')
      expect(notes ?? []).toHaveLength(1)
      expect(notes?.[0]?.priority).toBe('high')
      expect(notes?.[0]?.title).toMatch(/payment failed/i)

      // Cleanup
      await admin().from('admin_notifications').delete().eq('venue_id', venueId)
      await admin().from('stripe_events').delete().eq('id', eventId)
    })

    test('webhook idempotency — duplicate event id is acked without re-running side effects', async ({ request }) => {
      test.setTimeout(60_000)
      const { orgId } = await createTestOrg(ctx)
      const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })
      await admin()
        .from('venues')
        .update({
          stripe_customer_id: `cus_idem_${ctx.testId}`,
          stripe_subscription_id: `sub_idem_${ctx.testId}`,
        })
        .eq('id', venueId)

      const eventId = `evt_e2e_idem_${ctx.testId}`
      const event = {
        id: eventId,
        type: 'customer.subscription.deleted',
        api_version: '2025-02-24.acacia',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `sub_idem_${ctx.testId}`,
            object: 'subscription',
            status: 'canceled',
            customer: `cus_idem_${ctx.testId}`,
            metadata: { venue_id: venueId },
            items: { data: [] },
          },
        },
      }

      const first = await request.post('/api/webhooks/stripe', { data: event })
      expect(first.status()).toBe(200)
      const firstBody = await first.json().catch(() => ({}))
      expect(firstBody.received).toBe(true)
      expect(firstBody.duplicate).toBeUndefined()

      const second = await request.post('/api/webhooks/stripe', { data: event })
      expect(second.status()).toBe(200)
      const secondBody = await second.json().catch(() => ({}))
      expect(secondBody.duplicate).toBe(true)

      await admin().from('admin_notifications').delete().eq('venue_id', venueId)
      await admin().from('stripe_events').delete().eq('id', eventId)
    })
  })

  // ---------------------------------------------------------------------------
  // Webhook signature enforcement — runs only when STRIPE_WEBHOOK_SECRET set.
  // Confirms that an unsigned body is rejected.
  // ---------------------------------------------------------------------------

  test.describe('webhook (signature enforced)', () => {
    test.skip(!WEBHOOK_SECRET_SET, 'STRIPE_WEBHOOK_SECRET not set — signature path not exercised')

    test('rejects unsigned webhook body with 401', async ({ request }) => {
      const res = await request.post('/api/webhooks/stripe', {
        data: {
          id: 'evt_unsigned',
          type: 'customer.subscription.deleted',
          data: { object: { id: 'sub_x', metadata: {} } },
        },
      })
      expect(res.status()).toBe(401)
    })
  })

  // ---------------------------------------------------------------------------
  // Live Stripe — only runs when STRIPE_SECRET_KEY is set. Confirms that
  // checkout returns a hosted URL.
  // ---------------------------------------------------------------------------

  test.describe('live Stripe (STRIPE_SECRET_KEY required)', () => {
    test.skip(!STRIPE_CONFIGURED, 'STRIPE_SECRET_KEY not set — skipping live checkout test')

    test('POST /api/stripe/checkout returns a hosted Stripe URL when configured', async ({ browser }) => {
      test.setTimeout(60_000)
      const priceId = process.env.STRIPE_PRICE_INTELLIGENCE_MONTHLY
      test.skip(!priceId, 'STRIPE_PRICE_INTELLIGENCE_MONTHLY not set')

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
        const res = await handle.request.post('/api/stripe/checkout', {
          data: { priceId, billingCycle: 'monthly' },
        })
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body.url).toMatch(/^https:\/\/checkout\.stripe\.com/)
      } finally {
        await handle.close()
      }
    })
  })
})
