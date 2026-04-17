import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getStripe, isStripeConfigured } from '@/lib/stripe'
import { planTierForPriceId } from '@/lib/billing/plans'
import type Stripe from 'stripe'

// ---------------------------------------------------------------------------
// GET /api/stripe/subscription
//
// Returns the current user's venue subscription summary for the billing page:
//   {
//     tier, hasSubscription, status, cancelAtPeriodEnd,
//     currentPeriodEnd, priceId, cycle, amount, currency
//   }
// No Stripe call if the venue has no stripe_subscription_id.
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest) {
  try {
    const anonSupabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await anonSupabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
    }

    const serviceSupabase = createServiceClient()
    const { data: profile } = await serviceSupabase
      .from('user_profiles')
      .select('venue_id')
      .eq('id', user.id)
      .maybeSingle()

    const venueId = (profile?.venue_id as string | null) ?? null
    if (!venueId) {
      return NextResponse.json({ error: 'No venue.' }, { status: 400 })
    }

    const { data: venue } = await serviceSupabase
      .from('venues')
      .select('id, name, plan_tier, stripe_customer_id, stripe_subscription_id')
      .eq('id', venueId)
      .maybeSingle()

    if (!venue) {
      return NextResponse.json({ error: 'Venue not found.' }, { status: 404 })
    }

    const base = {
      venueId: venue.id as string,
      venueName: venue.name as string,
      tier: (venue.plan_tier as string) || 'starter',
      hasSubscription: false,
      hasCustomer: Boolean(venue.stripe_customer_id),
      status: null as string | null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null as string | null,
      priceId: null as string | null,
      cycle: null as 'monthly' | 'annual' | null,
      amount: null as number | null,
      currency: null as string | null,
    }

    const subscriptionId = venue.stripe_subscription_id as string | null
    if (!subscriptionId || !isStripeConfigured()) {
      return NextResponse.json(base)
    }

    let subscription: Stripe.Subscription
    try {
      const stripe = getStripe()
      subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price'],
      })
    } catch (err) {
      console.warn('[stripe/subscription] retrieve failed:', err)
      return NextResponse.json(base)
    }

    const item = subscription.items.data[0]
    const price = item?.price
    const priceId = price?.id ?? null
    const amount = price?.unit_amount != null ? price.unit_amount / 100 : null
    const currency = price?.currency ?? null
    const interval = price?.recurring?.interval ?? null
    const cycle: 'monthly' | 'annual' | null =
      interval === 'year' ? 'annual' : interval === 'month' ? 'monthly' : null

    // Prefer the subscription's mapped tier if known
    const mappedTier = priceId ? planTierForPriceId(priceId) : null

    // Stripe sometimes exposes current_period_end on items rather than the sub
    const periodEndSec =
      (subscription as unknown as { current_period_end?: number }).current_period_end ??
      (item as unknown as { current_period_end?: number } | undefined)?.current_period_end ??
      null

    return NextResponse.json({
      ...base,
      tier: mappedTier ?? base.tier,
      hasSubscription: true,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodEnd: periodEndSec ? new Date(periodEndSec * 1000).toISOString() : null,
      priceId,
      cycle,
      amount,
      currency,
    })
  } catch (err) {
    console.error('[stripe/subscription] error:', err)
    return NextResponse.json(
      { error: 'Failed to load subscription.' },
      { status: 500 }
    )
  }
}
