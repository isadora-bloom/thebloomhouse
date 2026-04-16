import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'

// ---------------------------------------------------------------------------
// Stripe webhook handler
//
// Handles subscription lifecycle events to keep venues.plan_tier in sync
// with Stripe billing status.
//
// Signature validation: Uses Stripe's signing scheme (v1 HMAC-SHA256).
// When the `stripe` npm package is installed AND STRIPE_WEBHOOK_SECRET is
// set, prefer `stripe.webhooks.constructEvent()`.  As a fallback we
// implement the same scheme manually so no extra dependency is required.
// ---------------------------------------------------------------------------

/**
 * Verify a Stripe webhook signature (v1 scheme) without the Stripe SDK.
 * Returns true if the signature is valid, false otherwise.
 */
function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  try {
    // Parse the header: "t=<timestamp>,v1=<sig>[,v0=<sig>]..."
    const parts = signatureHeader.split(',')
    const tsPart = parts.find((p) => p.startsWith('t='))
    const v1Parts = parts.filter((p) => p.startsWith('v1='))

    if (!tsPart || v1Parts.length === 0) return false

    const timestamp = parseInt(tsPart.replace('t=', ''), 10)
    if (isNaN(timestamp)) return false

    // Reject events older than tolerance
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - timestamp) > toleranceSeconds) return false

    // Compute expected signature
    const signedPayload = `${timestamp}.${rawBody}`
    const expectedSig = createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex')

    // Timing-safe comparison against any v1 signature
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

    // ---- Signature validation ----
    const sig = request.headers.get('stripe-signature')
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

    if (webhookSecret) {
      // Production: validate signature
      if (!sig) {
        console.warn('[webhook/stripe] Missing stripe-signature header')
        return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
      }

      if (!verifyStripeSignature(rawBody, sig, webhookSecret)) {
        console.warn('[webhook/stripe] Invalid webhook signature')
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }
    } else {
      // Development: log a warning but allow through
      console.warn(
        '[webhook/stripe] STRIPE_WEBHOOK_SECRET not set — skipping signature validation. ' +
        'Set this env var in production.'
      )
    }

    const event = JSON.parse(rawBody)

    console.log(`[webhook/stripe] Received event: ${event.type}`, {
      id: event.id,
      type: event.type,
    })

    const supabase = createServiceClient()

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data?.object
        if (!subscription) break

        // Extract venue ID from subscription metadata
        const venueId = subscription.metadata?.venue_id
        if (!venueId) {
          console.warn('[webhook/stripe] Subscription missing venue_id in metadata:', subscription.id)
          break
        }

        // Map Stripe price/product to plan tier
        const planTier = mapSubscriptionToTier(subscription)

        // Update venue plan
        const { error } = await supabase
          .from('venues')
          .update({
            plan_tier: planTier,
            stripe_subscription_id: subscription.id,
            stripe_customer_id: subscription.customer,
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
        const subscription = event.data?.object
        if (!subscription) break

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

// TODO: Map actual Stripe price IDs to plan tiers once products are set up
function mapSubscriptionToTier(subscription: Record<string, unknown>): string {
  const status = subscription.status as string

  // If subscription is not active, default to the baseline tier.
  // NOTE: 'starter' is the free/baseline tier in our schema. The
  // venues.plan_tier CHECK constraint only allows
  // ('starter', 'intelligence', 'enterprise') — there is no 'free' value.
  if (status !== 'active' && status !== 'trialing') {
    return 'starter'
  }

  // Check metadata for explicit tier override
  const metadata = subscription.metadata as Record<string, string> | undefined
  if (metadata?.plan_tier) {
    return metadata.plan_tier
  }

  // TODO: Map price IDs to tiers when Stripe products are configured
  // const items = subscription.items as { data?: Array<{ price?: { id?: string } }> } | undefined
  // const priceId = items?.data?.[0]?.price?.id
  // switch (priceId) {
  //   case 'price_starter_monthly':  return 'starter'
  //   case 'price_pro_monthly':      return 'pro'
  //   case 'price_enterprise_monthly': return 'enterprise'
  //   default: return 'starter'
  // }

  return 'starter'
}
