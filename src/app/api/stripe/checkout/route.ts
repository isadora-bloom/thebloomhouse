import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { MANAGER_ROLES } from '@/lib/auth/roles'
import { getStripe, isStripeConfigured } from '@/lib/stripe'
import { isConfiguredPriceId, planTierForPriceId } from '@/lib/billing/plans'
import { appUrl } from '@/lib/app-url'
import { redactError } from '@/lib/observability/redact'

// ---------------------------------------------------------------------------
// POST /api/stripe/checkout
//
// Body: { priceId: string, billingCycle: 'monthly' | 'annual' }
// Returns: { url: string }
//
// - Requires an authenticated user (401 otherwise — client redirects to /login).
// - Resolves the user's venue via user_profiles.
// - Reuses the venue's existing Stripe customer if present, otherwise
//   creates a new Customer and persists stripe_customer_id.
// - Creates a Checkout Session with mode=subscription.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    if (!isStripeConfigured()) {
      return NextResponse.json(
        { error: 'Stripe is not configured on this server.' },
        { status: 500 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const { priceId, billingCycle } = body as {
      priceId?: string
      billingCycle?: 'monthly' | 'annual'
    }

    if (!priceId || typeof priceId !== 'string') {
      return NextResponse.json({ error: 'priceId is required.' }, { status: 400 })
    }
    if (billingCycle !== 'monthly' && billingCycle !== 'annual') {
      return NextResponse.json(
        { error: 'billingCycle must be "monthly" or "annual".' },
        { status: 400 }
      )
    }

    // Validate priceId against our configured plans so clients can't pass
    // arbitrary Stripe prices (e.g. a $0.01 price they created themselves).
    if (!isConfiguredPriceId(priceId)) {
      return NextResponse.json({ error: 'Unknown priceId.' }, { status: 400 })
    }

    // ---- Auth ----
    const anonSupabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await anonSupabase.auth.getUser()

    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required.' },
        { status: 401 }
      )
    }

    // ---- Resolve venue ----
    const serviceSupabase = createServiceClient()
    const { data: profile, error: profileError } = await serviceSupabase
      .from('user_profiles')
      .select('id, venue_id, org_id, role')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError || !profile) {
      return NextResponse.json(
        { error: 'User profile not found.' },
        { status: 404 }
      )
    }

    // Billing is an owner's decision. Anyone signed in used to be able to
    // start a subscription, open the billing portal or read what the venue
    // pays — coordinators included, and a coordinator is often somebody the
    // venue hired last month. Restricted to the roles that own the account.
    if (!(MANAGER_ROLES as readonly string[]).includes(profile.role as string)) {
      return NextResponse.json(
        { error: 'Billing is managed by your venue manager or organisation admin.' },
        { status: 403 }
      )
    }

    const venueId = profile.venue_id as string | null
    if (!venueId) {
      return NextResponse.json(
        { error: 'No venue associated with this user.' },
        { status: 400 }
      )
    }

    const { data: venue, error: venueError } = await serviceSupabase
      .from('venues')
      .select('id, name, stripe_customer_id, stripe_subscription_id')
      .eq('id', venueId)
      .maybeSingle()

    if (venueError || !venue) {
      return NextResponse.json({ error: 'Venue not found.' }, { status: 404 })
    }

    // ---- Stripe customer ----
    const stripe = getStripe()
    let customerId = (venue.stripe_customer_id as string | null) || null

    if (!customerId) {
      // Race-condition guard: another concurrent request may also be creating
      // a customer for this venue. We create the customer, then attempt the
      // update only if stripe_customer_id is still null. If the update
      // affects zero rows, someone else already wrote a customer — re-read
      // and delete the duplicate we just made to avoid orphan customers.
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name: (venue.name as string) || undefined,
        metadata: {
          venue_id: venueId,
          org_id: (profile.org_id as string | null) ?? '',
        },
      })

      const { data: updated, error: updateError } = await serviceSupabase
        .from('venues')
        .update({
          stripe_customer_id: customer.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', venueId)
        .is('stripe_customer_id', null)
        .select('stripe_customer_id')
        .maybeSingle()

      if (updateError) {
        console.error('[stripe/checkout] venue update failed:', updateError)
        // Best-effort cleanup of the orphan customer
        try { await stripe.customers.del(customer.id) } catch { /* ignore */ }
        return NextResponse.json(
          { error: 'Failed to save customer.' },
          { status: 500 }
        )
      }

      if (!updated) {
        // Another request beat us. Read the real customer id, delete ours.
        const { data: refreshed } = await serviceSupabase
          .from('venues')
          .select('stripe_customer_id')
          .eq('id', venueId)
          .maybeSingle()
        customerId = (refreshed?.stripe_customer_id as string | null) ?? null
        try { await stripe.customers.del(customer.id) } catch { /* ignore */ }
        if (!customerId) {
          return NextResponse.json(
            { error: 'Could not resolve Stripe customer.' },
            { status: 500 }
          )
        }
      } else {
        customerId = customer.id
      }
    }

    // ---- Checkout session ----
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: venueId,
      subscription_data: {
        metadata: {
          venue_id: venueId,
          org_id: (profile.org_id as string | null) ?? '',
          plan_tier: planTierForPriceId(priceId) ?? '',
          billing_cycle: billingCycle,
        },
      },
      allow_promotion_codes: true,
      // Send the user to a dedicated server-rendered success page that
      // re-fetches the session from Stripe before showing anything. This
      // page must NEVER trust client-side state for plan_tier / amount.
      success_url: appUrl(`/billing/success?session_id={CHECKOUT_SESSION_ID}`),
      cancel_url: appUrl('/pricing?canceled=true'),
    })

    if (!session.url) {
      return NextResponse.json(
        { error: 'Stripe did not return a checkout URL.' },
        { status: 500 }
      )
    }

    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error('[stripe/checkout] error:', redactError(err))
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json(
      { error: `Checkout failed: ${message}` },
      { status: 500 }
    )
  }
}
