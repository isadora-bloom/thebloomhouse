import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { planTierForPriceId } from '@/lib/billing/plans'
import { getStripe, isStripeConfigured } from '@/lib/stripe'
import { redact, redactError } from '@/lib/observability/redact'
import { recordCounter } from '@/lib/observability/metrics'
import type Stripe from 'stripe'

// ---------------------------------------------------------------------------
// Stripe webhook handler (GAP-02)
//
// Handles subscription lifecycle events to keep venues.plan_tier in sync
// with Stripe billing status, and writes admin_notifications rows so
// coordinators see plan changes / payment failures in their feed.
//
// Signature validation: Uses Stripe's signing scheme (v1 HMAC-SHA256).
// When STRIPE_SECRET_KEY is set we prefer stripe.webhooks.constructEvent()
// for canonical validation. Otherwise we fall back to a manual HMAC check
// so the endpoint keeps working even if the SDK isn't initialised.
//
// Idempotency: every processed event id is recorded in `stripe_events`
// (migration 054). Repeated deliveries of the same id short-circuit BEFORE
// any side effects fire. All DB writes are also individually safe to
// re-run if the idempotency table is missing or the row insert raced.
//
// Observability:
//   - recordCounter('stripe_webhook_event', { dimension: { type, outcome } })
//     fires on every event so the metrics-aggregate view shows
//     processed / duplicate / unhandled / error counts per type.
//   - All catches use redactError() to keep PII out of stdout (Stripe
//     errors can echo signature material + payload fragments).
// ---------------------------------------------------------------------------

/**
 * Fallback verifier used when the Stripe SDK can't be constructed
 * (e.g. STRIPE_SECRET_KEY missing but STRIPE_WEBHOOK_SECRET set).
 */
function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  try {
    const parts = signatureHeader.split(',')
    const tsPart = parts.find((p) => p.startsWith('t='))
    const v1Parts = parts.filter((p) => p.startsWith('v1='))

    if (!tsPart || v1Parts.length === 0) return false

    const timestamp = parseInt(tsPart.replace('t=', ''), 10)
    if (isNaN(timestamp)) return false

    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - timestamp) > toleranceSeconds) return false

    const signedPayload = `${timestamp}.${rawBody}`
    const expectedSig = createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex')

    const expectedBuf = Buffer.from(expectedSig, 'hex')
    for (const v1 of v1Parts) {
      const actual = v1.replace('v1=', '')
      const actualBuf = Buffer.from(actual, 'hex')
      if (expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf)) {
        return true
      }
    }

    return false
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Notification helper — writes a coordinator notification with idempotency.
// We use a stable composite key (venue_id + type + entity reference) so
// repeated webhook deliveries don't spam the feed.
// ---------------------------------------------------------------------------

interface NotifyOpts {
  venueId: string
  type: string
  title: string
  body: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  /**
   * Stable dedup key — typically the Stripe object id (e.g. sub_..., in_...).
   * If a notification with the same venue + type + dedupKey already exists
   * within the last 24h we skip the insert. This handles webhook replays
   * for events we've already surfaced (idempotency table is the primary
   * guard — this is a belt-and-braces secondary).
   */
  dedupKey?: string
}

async function writeAdminNotification(
  supabase: ReturnType<typeof createServiceClient>,
  opts: NotifyOpts
): Promise<void> {
  try {
    if (opts.dedupKey) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { data: existing } = await supabase
        .from('admin_notifications')
        .select('id')
        .eq('venue_id', opts.venueId)
        .eq('type', opts.type)
        .gte('created_at', since)
        .ilike('body', `%${opts.dedupKey}%`)
        .limit(1)
      if (existing && existing.length > 0) {
        return
      }
    }

    await supabase.from('admin_notifications').insert({
      venue_id: opts.venueId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      priority: opts.priority ?? 'normal',
    })
  } catch (err) {
    // Notification writes are best-effort — never block a webhook ack.
    console.warn('[webhook/stripe] writeAdminNotification failed:', redactError(err))
  }
}

// ---------------------------------------------------------------------------
// POST — Handle Stripe webhook events
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let outcome: 'processed' | 'duplicate' | 'unhandled' | 'invalid_signature' | 'invalid_event' | 'error' = 'processed'
  let eventType: string | null = null
  try {
    const rawBody = await request.text()

    const sig = request.headers.get('stripe-signature')
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

    let event: Stripe.Event | null = null

    if (webhookSecret) {
      if (!sig) {
        console.warn('[webhook/stripe] Missing stripe-signature header')
        outcome = 'invalid_signature'
        await recordCounter('stripe_webhook_event', { dimension: { type: 'unknown', outcome } })
        return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
      }

      if (isStripeConfigured()) {
        // Preferred path — SDK-validated construction
        try {
          const stripe = getStripe()
          event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
        } catch (err) {
          // Stripe constructEvent errors can echo signature material
          // and (less commonly) payload fragments. Redact before stdout.
          console.warn('[webhook/stripe] constructEvent failed:', redactError(err))
          outcome = 'invalid_signature'
          await recordCounter('stripe_webhook_event', { dimension: { type: 'unknown', outcome } })
          return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }
      } else {
        // Fallback — manual HMAC
        if (!verifyStripeSignature(rawBody, sig, webhookSecret)) {
          console.warn('[webhook/stripe] Invalid webhook signature')
          outcome = 'invalid_signature'
          await recordCounter('stripe_webhook_event', { dimension: { type: 'unknown', outcome } })
          return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }
        event = JSON.parse(rawBody) as Stripe.Event
      }
    } else {
      console.warn(
        '[webhook/stripe] STRIPE_WEBHOOK_SECRET not set — skipping signature validation. ' +
        'Set this env var in production.'
      )
      event = JSON.parse(rawBody) as Stripe.Event
    }

    if (!event) {
      outcome = 'invalid_event'
      await recordCounter('stripe_webhook_event', { dimension: { type: 'unknown', outcome } })
      return NextResponse.json({ error: 'Invalid event' }, { status: 400 })
    }

    eventType = event.type

    console.log(`[webhook/stripe] Received event: ${event.type}`, {
      id: event.id,
      type: event.type,
    })

    const supabase = createServiceClient()

    // ---- Idempotency: short-circuit duplicate deliveries ----
    // Insert the event id; if it already exists we've processed it before.
    {
      const { error: idemErr } = await supabase
        .from('stripe_events')
        .insert({
          id: event.id,
          type: event.type,
          payload: event as unknown as Record<string, unknown>,
        })

      if (idemErr) {
        // 23505 = unique violation = already processed
        const code = (idemErr as unknown as { code?: string }).code
        if (code === '23505') {
          console.log(`[webhook/stripe] Duplicate event ${event.id} — acknowledging`)
          outcome = 'duplicate'
          await recordCounter('stripe_webhook_event', { dimension: { type: event.type, outcome } })
          return NextResponse.json({ received: true, duplicate: true })
        }
        // Table may not exist yet (migration 054 not applied) — log and continue,
        // falling back to "update is safe to re-run" semantics.
        // Redact: idempotency insert errors can include constraint
        // detail referencing the event payload.
        console.warn('[webhook/stripe] Idempotency insert failed (continuing):', redact(idemErr.message))
      }
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session

        // client_reference_id is the venue id we set during checkout creation.
        // Fall back to subscription metadata if missing.
        const venueId =
          (session.client_reference_id as string | null) ||
          (session.metadata?.venue_id as string | undefined) ||
          null

        if (!venueId) {
          console.warn('[webhook/stripe] checkout.session.completed missing venue_id:', session.id)
          break
        }

        // Persist customer + subscription IDs eagerly so the success page
        // and /api/stripe/subscription have something to read even if the
        // subsequent customer.subscription.created event is delayed.
        const customerId =
          typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id ?? null
        const subscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id ?? null

        const update: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        }
        if (customerId) update.stripe_customer_id = customerId
        if (subscriptionId) update.stripe_subscription_id = subscriptionId

        if (Object.keys(update).length > 1) {
          const { error } = await supabase
            .from('venues')
            .update(update)
            .eq('id', venueId)
          if (error) {
            console.error(
              `[webhook/stripe] checkout.session.completed venue update failed for ${venueId}:`,
              redact(error.message)
            )
          }
        }

        await writeAdminNotification(supabase, {
          venueId,
          type: 'subscription_activated',
          title: 'Subscription activated',
          body: `Checkout completed (session ${session.id}). Plan features will unlock momentarily as we sync with Stripe.`,
          priority: 'normal',
          dedupKey: session.id,
        })

        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription

        const venueId = subscription.metadata?.venue_id
        if (!venueId) {
          console.warn('[webhook/stripe] Subscription missing venue_id in metadata:', subscription.id)
          break
        }

        const planTier = mapSubscriptionToTier(subscription)

        // Read the current tier first so we can detect a change and notify.
        const { data: existing } = await supabase
          .from('venues')
          .select('plan_tier')
          .eq('id', venueId)
          .maybeSingle()
        const previousTier = (existing?.plan_tier as string | undefined) ?? null

        const { error } = await supabase
          .from('venues')
          .update({
            plan_tier: planTier,
            stripe_subscription_id: subscription.id,
            stripe_customer_id:
              typeof subscription.customer === 'string'
                ? subscription.customer
                : subscription.customer.id,
            updated_at: new Date().toISOString(),
          })
          .eq('id', venueId)

        if (error) {
          // Update errors can reference column values including
          // stripe_customer_id (PII-adjacent). Redact before stdout.
          console.error(`[webhook/stripe] Failed to update venue ${venueId}:`, redact(error.message))
          throw error
        }

        console.log(`[webhook/stripe] Updated venue ${venueId} to plan: ${planTier}`)

        // Notify on a tier change (upgrade or downgrade). Skip notifications
        // for "noise" updates that don't change the visible plan.
        if (previousTier && previousTier !== planTier) {
          const direction =
            (previousTier === 'starter' && planTier !== 'starter') ||
            (previousTier === 'intelligence' && planTier === 'enterprise')
              ? 'upgraded'
              : 'changed'
          await writeAdminNotification(supabase, {
            venueId,
            type: `subscription_${direction}`,
            title: `Plan ${direction}: ${previousTier} → ${planTier}`,
            body:
              `Your venue plan is now ${planTier}. ` +
              `Manage billing at /settings/billing. (subscription ${subscription.id})`,
            priority: 'normal',
            dedupKey: subscription.id,
          })
        }

        if (subscription.cancel_at_period_end) {
          await writeAdminNotification(supabase, {
            venueId,
            type: 'subscription_cancellation_scheduled',
            title: 'Subscription cancellation scheduled',
            body:
              `Your ${planTier} plan is set to cancel at the end of the current billing period. ` +
              `You can resume anytime from /settings/billing. (subscription ${subscription.id})`,
            priority: 'high',
            dedupKey: `${subscription.id}:cancel_scheduled`,
          })
        }

        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription

        const venueId = subscription.metadata?.venue_id
        if (!venueId) {
          console.warn('[webhook/stripe] Deleted subscription missing venue_id:', subscription.id)
          break
        }

        // Downgrade to starter tier on cancellation.
        // NOTE: 'starter' is the free/baseline tier in our schema. The
        // venues.plan_tier CHECK constraint only allows
        // ('starter', 'intelligence', 'enterprise') — there is no 'free' value.
        const { error } = await supabase
          .from('venues')
          .update({
            plan_tier: 'starter',
            stripe_subscription_id: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', venueId)

        if (error) {
          console.error(`[webhook/stripe] Failed to downgrade venue ${venueId}:`, redact(error.message))
          throw error
        }

        console.log(`[webhook/stripe] Downgraded venue ${venueId} to starter tier`)

        await writeAdminNotification(supabase, {
          venueId,
          type: 'subscription_canceled',
          title: 'Subscription canceled — downgraded to Starter',
          body:
            'Your paid subscription has ended and your venue is back on the Starter plan. ' +
            'Re-subscribe anytime at /pricing. (subscription ' + subscription.id + ')',
          priority: 'high',
          dedupKey: subscription.id,
        })

        break
      }

      case 'invoice.payment_failed': {
        // Stripe retries automatically — we surface the failure to the
        // coordinator so they can update their card before the eventual
        // past_due → canceled transition (which downgrades the plan).
        const invoice = event.data.object as Stripe.Invoice
        const customerId =
          typeof invoice.customer === 'string'
            ? invoice.customer
            : invoice.customer?.id ?? null

        console.warn('[webhook/stripe] invoice.payment_failed', {
          id: invoice.id,
          customer: customerId,
          amount_due: invoice.amount_due,
          attempt_count: invoice.attempt_count,
        })

        // Resolve venue via stripe_customer_id. The invoice doesn't carry
        // venue metadata directly so we need this lookup.
        if (customerId) {
          const { data: venue } = await supabase
            .from('venues')
            .select('id, name')
            .eq('stripe_customer_id', customerId)
            .maybeSingle()

          if (venue?.id) {
            const amount = (invoice.amount_due ?? 0) / 100
            const currency = (invoice.currency ?? 'usd').toUpperCase()
            await writeAdminNotification(supabase, {
              venueId: venue.id as string,
              type: 'payment_failed',
              title: 'Payment failed — action required',
              body:
                `Stripe could not collect ${currency} ${amount.toFixed(2)} (invoice ${invoice.id}). ` +
                `Attempt ${invoice.attempt_count ?? 1}. Update your payment method at /settings/billing ` +
                `to keep your subscription active.`,
              priority: 'high',
              dedupKey: invoice.id ?? `${customerId}:payment_failed`,
            })
          } else {
            console.warn(
              `[webhook/stripe] payment_failed: no venue found for customer ${customerId}`
            )
          }
        }

        break
      }

      default:
        console.log(`[webhook/stripe] Unhandled event type: ${event.type}`)
        outcome = 'unhandled'
    }

    // Always return 200 to acknowledge receipt (Stripe retries on non-2xx)
    await recordCounter('stripe_webhook_event', { dimension: { type: event.type, outcome } })
    return NextResponse.json({ received: true })
  } catch (err) {
    // Top-level catch can include serialized event payloads with PII.
    // Redact before stdout — this is the highest-risk surface in the
    // Stripe webhook for accidental leakage.
    console.error('[webhook/stripe] Error processing webhook:', redactError(err))
    outcome = 'error'
    await recordCounter('stripe_webhook_event', { dimension: { type: eventType ?? 'unknown', outcome } })
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// Helper: map Stripe subscription to plan tier
// ---------------------------------------------------------------------------

function mapSubscriptionToTier(subscription: Stripe.Subscription): 'starter' | 'intelligence' | 'enterprise' {
  const status = subscription.status

  // If subscription is not active, default to the baseline tier.
  // NOTE: 'starter' is the free/baseline tier in our schema. The
  // venues.plan_tier CHECK constraint only allows
  // ('starter', 'intelligence', 'enterprise') — there is no 'free' value.
  if (status !== 'active' && status !== 'trialing') {
    return 'starter'
  }

  // Explicit override via metadata wins (useful for manual/grandfathered tiers)
  const explicitTier = subscription.metadata?.plan_tier
  if (
    explicitTier === 'starter' ||
    explicitTier === 'intelligence' ||
    explicitTier === 'enterprise'
  ) {
    return explicitTier
  }

  // Map price ID → tier via the shared plan catalog
  const priceId = subscription.items.data[0]?.price?.id
  if (priceId) {
    const mapped = planTierForPriceId(priceId)
    if (mapped) return mapped
  }

  // Unknown price — default to starter rather than silently granting a paid tier
  return 'starter'
}
