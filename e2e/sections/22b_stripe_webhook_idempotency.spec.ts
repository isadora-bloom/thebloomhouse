import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  cleanup,
  TestContext,
} from '../helpers/seed'

/**
 * §22b Stripe Webhook Idempotency — state-machine tests (migration 209).
 *
 * Migration 209 introduced a processed_at TIMESTAMPTZ column on stripe_events
 * that turns webhook delivery from a naive unique-constraint guard into a
 * proper three-state machine:
 *
 *   (a) Row absent                  — first delivery: INSERT, run side-effects, stamp processed_at.
 *   (b) Row present, processed_at IS NULL — prior run claimed the row but crashed
 *       before finishing: re-run side-effects, stamp processed_at.
 *   (c) Row present, processed_at IS NOT NULL — fully processed: return 200
 *       with { received: true, duplicate: true } without re-running side-effects.
 *
 * These tests exercise the observable behaviour of the state-machine by
 * calling the webhook HTTP endpoint with synthetic (unsigned) payloads.
 *
 * Signature handling:
 *   When STRIPE_WEBHOOK_SECRET is NOT set the route skips signature validation
 *   and processes the raw JSON body directly — the same path the §22 webhook
 *   tests use. These tests follow that same convention and are skipped when
 *   STRIPE_WEBHOOK_SECRET IS set so they don't spuriously fail in production
 *   CI environments where the secret is configured.
 *
 * Test IDs:
 *   22b-1  First delivery: processed_at is set after side-effects complete.
 *   22b-2  Retry after success (state c): returns duplicate=true, venue plan NOT toggled back.
 *   22b-3  Retry after crash (state b): pre-inserting a NULL-processed_at row, the
 *           webhook re-runs side-effects and stamps processed_at.
 *   22b-4  Duplicate delivery cannot double-notify: admin_notifications count stays at 1.
 *   22b-5  Downgrade idempotency: replaying customer.subscription.deleted does NOT
 *           alter an already-downgraded venue's plan_tier.
 */

const WEBHOOK_SECRET_SET = Boolean(process.env.STRIPE_WEBHOOK_SECRET)

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
 * Build a minimal customer.subscription.deleted event payload that the
 * webhook handler will recognise and use to downgrade a venue.
 */
function makeDeletedEvent(opts: {
  eventId: string
  subscriptionId: string
  customerId: string
  venueId: string
}): Record<string, unknown> {
  return {
    id: opts.eventId,
    type: 'customer.subscription.deleted',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.subscriptionId,
        object: 'subscription',
        status: 'canceled',
        customer: opts.customerId,
        metadata: { venue_id: opts.venueId },
        items: { data: [] },
      },
    },
  }
}

/**
 * POST the synthetic event to /api/webhooks/stripe.
 * Returns the Playwright APIResponse.
 */
async function postWebhook(
  request: import('@playwright/test').APIRequestContext,
  payload: Record<string, unknown>
) {
  return request.post('/api/webhooks/stripe', {
    data: payload,
    timeout: 30_000,
  })
}

test.describe('§22b Stripe Webhook Idempotency (state-machine)', () => {
  // Skip the entire suite when the webhook secret is configured — in that
  // environment unsigned bodies are rejected (401) and these tests cannot
  // send properly-signed requests without the secret value.
  test.skip(WEBHOOK_SECRET_SET, 'STRIPE_WEBHOOK_SECRET is set — unsigned-body webhook tests skipped')

  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  // ---------------------------------------------------------------------------
  // 22b-1: First delivery — processed_at is set after side-effects succeed.
  // ---------------------------------------------------------------------------

  test('22b-1: first delivery stamps processed_at on stripe_events row', async ({ request }) => {
    test.setTimeout(60_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })

    const eventId = `evt_22b1_${ctx.testId}`
    const subscriptionId = `sub_22b1_${ctx.testId}`
    const customerId = `cus_22b1_${ctx.testId}`

    await admin()
      .from('venues')
      .update({ stripe_customer_id: customerId, stripe_subscription_id: subscriptionId })
      .eq('id', venueId)

    const payload = makeDeletedEvent({ eventId, subscriptionId, customerId, venueId })

    const res = await postWebhook(request, payload)
    expect(res.status()).toBe(200)

    const body = await res.json().catch(() => ({}))
    expect(body.received).toBe(true)
    expect(body.duplicate).toBeUndefined()

    // processed_at must be set after a clean first delivery.
    const { data: row } = await admin()
      .from('stripe_events')
      .select('processed_at')
      .eq('id', eventId)
      .maybeSingle()

    expect(row).not.toBeNull()
    expect(row?.processed_at).not.toBeNull()

    // Cleanup
    await admin().from('admin_notifications').delete().eq('venue_id', venueId)
    await admin().from('stripe_events').delete().eq('id', eventId)
  })

  // ---------------------------------------------------------------------------
  // 22b-2: Retry after success (state c) — duplicate=true, no side-effect replay.
  //
  // We deliver the same event twice. The second call must return duplicate=true
  // and the venue plan_tier must still be 'starter' (downgraded by the first)
  // — it must NOT be toggled back to anything else.
  // ---------------------------------------------------------------------------

  test('22b-2: replay of a fully-processed event returns duplicate=true without re-running side-effects', async ({ request }) => {
    test.setTimeout(60_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })

    const eventId = `evt_22b2_${ctx.testId}`
    const subscriptionId = `sub_22b2_${ctx.testId}`
    const customerId = `cus_22b2_${ctx.testId}`

    await admin()
      .from('venues')
      .update({ stripe_customer_id: customerId, stripe_subscription_id: subscriptionId })
      .eq('id', venueId)

    const payload = makeDeletedEvent({ eventId, subscriptionId, customerId, venueId })

    // First delivery — processes cleanly.
    const first = await postWebhook(request, payload)
    expect(first.status()).toBe(200)
    const firstBody = await first.json().catch(() => ({}))
    expect(firstBody.received).toBe(true)
    expect(firstBody.duplicate).toBeUndefined()

    // Confirm the venue was downgraded to starter.
    const { data: venueAfterFirst } = await admin()
      .from('venues')
      .select('plan_tier')
      .eq('id', venueId)
      .single()
    expect(venueAfterFirst?.plan_tier).toBe('starter')

    // Second delivery — must be recognised as a duplicate (state c).
    const second = await postWebhook(request, payload)
    expect(second.status()).toBe(200)
    const secondBody = await second.json().catch(() => ({}))
    expect(secondBody.received).toBe(true)
    expect(secondBody.duplicate).toBe(true)

    // venue plan_tier must remain 'starter' — not flipped back.
    const { data: venueAfterSecond } = await admin()
      .from('venues')
      .select('plan_tier')
      .eq('id', venueId)
      .single()
    expect(venueAfterSecond?.plan_tier).toBe('starter')

    // Cleanup
    await admin().from('admin_notifications').delete().eq('venue_id', venueId)
    await admin().from('stripe_events').delete().eq('id', eventId)
  })

  // ---------------------------------------------------------------------------
  // 22b-3: Retry after crash (state b) — pre-insert a NULL processed_at row,
  //          then deliver the event. The handler must re-run side-effects and
  //          stamp processed_at (not short-circuit on the duplicate).
  // ---------------------------------------------------------------------------

  test('22b-3: delivery after a crashed prior run (processed_at=null) re-runs side-effects and stamps processed_at', async ({ request }) => {
    test.setTimeout(60_000)
    const { orgId } = await createTestOrg(ctx)
    // Start on intelligence so we can observe a downgrade.
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })

    const eventId = `evt_22b3_${ctx.testId}`
    const subscriptionId = `sub_22b3_${ctx.testId}`
    const customerId = `cus_22b3_${ctx.testId}`

    await admin()
      .from('venues')
      .update({ stripe_customer_id: customerId, stripe_subscription_id: subscriptionId })
      .eq('id', venueId)

    // Simulate a prior run that claimed the row but crashed before finishing.
    // Insert the stripe_events row with processed_at = NULL (the crash state).
    const { error: preInsertErr } = await admin()
      .from('stripe_events')
      .insert({
        id: eventId,
        type: 'customer.subscription.deleted',
        payload: makeDeletedEvent({ eventId, subscriptionId, customerId, venueId }),
        // processed_at intentionally omitted — stays NULL (state b)
      })
    expect(preInsertErr).toBeNull()

    // Deliver the event. Because the row exists with processed_at=null, the
    // handler must fall through to re-run side-effects (downgrade + notify),
    // then stamp processed_at.
    const payload = makeDeletedEvent({ eventId, subscriptionId, customerId, venueId })
    const res = await postWebhook(request, payload)
    expect(res.status()).toBe(200)
    const body = await res.json().catch(() => ({}))
    // Not a duplicate — it should complete processing.
    expect(body.received).toBe(true)
    expect(body.duplicate).toBeUndefined()

    // Side-effects must have run: venue downgraded.
    const { data: venue } = await admin()
      .from('venues')
      .select('plan_tier')
      .eq('id', venueId)
      .single()
    expect(venue?.plan_tier).toBe('starter')

    // processed_at must now be stamped.
    const { data: row } = await admin()
      .from('stripe_events')
      .select('processed_at')
      .eq('id', eventId)
      .maybeSingle()
    expect(row?.processed_at).not.toBeNull()

    // Cleanup
    await admin().from('admin_notifications').delete().eq('venue_id', venueId)
    await admin().from('stripe_events').delete().eq('id', eventId)
  })

  // ---------------------------------------------------------------------------
  // 22b-4: Notification dedup — replaying a fully-processed event does NOT
  //          create a second admin_notification row.
  // ---------------------------------------------------------------------------

  test('22b-4: duplicate webhook delivery does not create a second admin_notification', async ({ request }) => {
    test.setTimeout(60_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })

    const eventId = `evt_22b4_${ctx.testId}`
    const subscriptionId = `sub_22b4_${ctx.testId}`
    const customerId = `cus_22b4_${ctx.testId}`

    await admin()
      .from('venues')
      .update({ stripe_customer_id: customerId, stripe_subscription_id: subscriptionId })
      .eq('id', venueId)

    const payload = makeDeletedEvent({ eventId, subscriptionId, customerId, venueId })

    const first = await postWebhook(request, payload)
    expect(first.status()).toBe(200)

    const second = await postWebhook(request, payload)
    expect(second.status()).toBe(200)

    // There must be exactly ONE admin_notification of type subscription_canceled.
    const { data: notes } = await admin()
      .from('admin_notifications')
      .select('id')
      .eq('venue_id', venueId)
      .eq('type', 'subscription_canceled')

    expect((notes ?? []).length).toBe(1)

    // Cleanup
    await admin().from('admin_notifications').delete().eq('venue_id', venueId)
    await admin().from('stripe_events').delete().eq('id', eventId)
  })

  // ---------------------------------------------------------------------------
  // 22b-5: Downgrade idempotency — delivering customer.subscription.deleted
  //          three times leaves plan_tier='starter' (not toggled back).
  //
  // This closes the specific "strand-venue-forever" bug that migration 209
  // was designed to fix: before the state machine, a retry on an already-
  // downgraded venue would hit the unique-constraint early-return and skip
  // re-applying the downgrade. Now that processed_at drives the guard, the
  // second call returns duplicate=true before touching the venues row.
  // ---------------------------------------------------------------------------

  test('22b-5: three deliveries of subscription.deleted leave venue on starter, not toggled back to intelligence', async ({ request }) => {
    test.setTimeout(90_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })

    const eventId = `evt_22b5_${ctx.testId}`
    const subscriptionId = `sub_22b5_${ctx.testId}`
    const customerId = `cus_22b5_${ctx.testId}`

    await admin()
      .from('venues')
      .update({ stripe_customer_id: customerId, stripe_subscription_id: subscriptionId })
      .eq('id', venueId)

    const payload = makeDeletedEvent({ eventId, subscriptionId, customerId, venueId })

    for (let i = 0; i < 3; i++) {
      const res = await postWebhook(request, payload)
      expect(res.status()).toBe(200)
    }

    const { data: venue } = await admin()
      .from('venues')
      .select('plan_tier')
      .eq('id', venueId)
      .single()

    // After 3 deliveries the venue must be 'starter', not 'intelligence'.
    expect(venue?.plan_tier).toBe('starter')

    // Cleanup
    await admin().from('admin_notifications').delete().eq('venue_id', venueId)
    await admin().from('stripe_events').delete().eq('id', eventId)
  })
})
