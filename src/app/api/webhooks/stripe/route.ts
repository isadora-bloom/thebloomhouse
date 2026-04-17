import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { planTierForPriceId } from '@/lib/billing/plans'
import { getStripe, isStripeConfigured } from '@/lib/stripe'
import type Stripe from 'stripe'

// ---------------------------------------------------------------------------
// Stripe webhook handler
//
// Handles subscription lifecycle events to keep venues.plan_tier in sync
// with Stripe billing status.
//
// Signature validation: Uses Stripe's signing scheme (v1 HMAC-SHA256).
// When STRIPE_SECRET_KEY is set we prefer stripe.webhooks.constructEvent()
// for canonical validation. Otherwise we fall back to a manual HMAC check
// so the endpoint keeps working even if the SDK isn't initialised.
//
// Idempotency: every processed event id is recorded in `stripe_events`
// (migration 054). Repeated deliveries of the same id short-circuit.
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
// POST — Handle Stripe webhook events
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text()

    const sig = request.headers.get('stripe-signature')
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

    let event: Stripe.Event | null = null

    if (webhookSecret) {
      if (!sig) {
        console.warn('[webhook/stripe] Missing stripe-signature header')
        return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
      }

      if (isStripeConfigured()) {
        // Preferred path — SDK-validated construction
        try {
          const stripe = getStripe()
          event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
        } catch (err) {
          console.warn('[webhook/stripe] constructEvent failed:', err)
          return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }
      } else {
        // Fallback — manual HMAC
        if (!verifyStripeSignature(rawBody, sig, webhookSecret)) {
          console.warn('[webhook/stripe] Invalid webhook signature')
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
      return NextResponse.json({ error: 'Invalid event' }, { status: 400 })
    }

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
          return NextResponse.json({ received: true, duplicate: true })
        }
        // Table may not exist yet (migration 054 not applied) — log and continue,
        // falling back to "update is safe to re-run" semantics.
        console.warn('[webhook/stripe] Idempotency insert failed (continuing):', idemErr.message)
      }
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription

        const venueId = subscription.metadata?.venue_id
        if (!venueId) {
          console.warn('[webhook/stripe] Subscription missing venue_id in metadata:', subscription.id)
          break
        }

        const planTier = mapSubscriptionToTier(subscription)

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
          console.error(`[webhook/stripe] Failed to update venue ${venueId}:`, error.message)
        } else {
          console.log(`[webhook/stripe] Updated venue ${venueId} to plan: ${planTier}`)
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
          console.error(`[webhook/stripe] Failed to downgrade venue ${venueId}:`, error.message)
        } else {
          console.log(`[webhook/stripe] Downgraded venue ${venueId} to starter tier`)
        }

        break
      }

      case 'invoice.payment_failed': {
        // Log only — Stripe will retry and eventually transition the
        // subscription to past_due/unpaid/canceled. We let those events
        // drive any downgrade so we don't boot paying customers for a
        // transient card decline.
        const invoice = event.data.object as Stripe.Invoice
        console.warn('[webhook/stripe] invoice.payment_failed', {
          id: invoice.id,
          customer: invoice.customer,
          amount_due: invoice.amount_due,
          attempt_count: invoice.attempt_count,
        })
        break
      }

      default:
        console.log(`[webhook/stripe] Unhandled event type: ${event.type}`)
    }

    // Always return 200 to acknowledge receipt (Stripe retries on non-2xx)
    return NextResponse.json({ received: true })
  } catch (err) {
    console.error('[webhook/stripe] Error processing webhook:', err)
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
