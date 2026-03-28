import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'

// ---------------------------------------------------------------------------
// Stripe webhook handler
//
// Handles subscription lifecycle events to keep venues.plan_tier in sync
// with Stripe billing status.
//
// TODO: In production, validate the webhook signature using Stripe's
// `stripe.webhooks.constructEvent()` with STRIPE_WEBHOOK_SECRET.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST — Handle Stripe webhook events
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text()

    // TODO: Validate webhook signature in production
    // const sig = request.headers.get('stripe-signature')
    // if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    //   return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
    // }
    // const event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)

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

        // Downgrade to free tier on cancellation
        const { error } = await supabase
          .from('venues')
          .update({
            plan_tier: 'free',
            stripe_subscription_id: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', venueId)

        if (error) {
          console.error(`[webhook/stripe] Failed to downgrade venue ${venueId}:`, error.message)
        } else {
          console.log(`[webhook/stripe] Downgraded venue ${venueId} to free tier`)
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

  // If subscription is not active, default to free
  if (status !== 'active' && status !== 'trialing') {
    return 'free'
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
