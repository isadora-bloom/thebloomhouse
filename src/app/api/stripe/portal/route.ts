import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { MANAGER_ROLES } from '@/lib/auth/roles'
import { getStripe, isStripeConfigured } from '@/lib/stripe'
import { appUrl } from '@/lib/app-url'
import { redactError } from '@/lib/observability/redact'

// ---------------------------------------------------------------------------
// POST /api/stripe/portal
//
// Creates a Stripe Billing Portal session so the venue can upgrade,
// downgrade, swap payment methods, or cancel from within the app.
//
// Returns: { url: string }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {

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

    // ---- Resolve venue / customer ----
    const serviceSupabase = createServiceClient()
    const { data: profile } = await serviceSupabase
      .from('user_profiles')
      .select('id, venue_id, role')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile) {
      return NextResponse.json({ error: 'User profile not found.' }, { status: 404 })
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

    const venueId = (profile.venue_id as string | null) ?? null
    if (!venueId) {
      return NextResponse.json(
        { error: 'No venue associated with this user.' },
        { status: 400 }
      )
    }

    const { data: venue } = await serviceSupabase
      .from('venues')
      .select('id, stripe_customer_id')
      .eq('id', venueId)
      .maybeSingle()

    const customerId = (venue?.stripe_customer_id as string | null) ?? null
    if (!customerId) {
      return NextResponse.json(
        { error: 'No billing account yet. Choose a plan on the pricing page first.' },
        { status: 400 }
      )
    }

    // After auth and the billing-account check, not before: an anonymous caller learns nothing about the
    // server's configuration, the validation errors keep their 4xx, and a
    // missing Stripe key is a 503 (unavailable), not a 500 (2026-09-15).
    if (!isStripeConfigured()) {
      return NextResponse.json(
        { error: 'Stripe is not configured on this server.' },
        { status: 503 }
      )
    }

    const stripe = getStripe()
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: appUrl('/settings/billing'),
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error('[stripe/portal] error:', redactError(err))
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json(
      { error: `Portal session failed: ${message}` },
      { status: 500 }
    )
  }
}
