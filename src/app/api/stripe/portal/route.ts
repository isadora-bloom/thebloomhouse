import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getStripe, isStripeConfigured } from '@/lib/stripe'

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
    if (!isStripeConfigured()) {
      return NextResponse.json(
        { error: 'Stripe is not configured on this server.' },
        { status: 500 }
      )
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

    // ---- Resolve venue / customer ----
    const serviceSupabase = createServiceClient()
    const { data: profile } = await serviceSupabase
      .from('user_profiles')
      .select('id, venue_id')
      .eq('id', user.id)
      .maybeSingle()

    const venueId = (profile?.venue_id as string | null) ?? null
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

    const origin =
      process.env.NEXT_PUBLIC_APP_URL ||
      request.headers.get('origin') ||
      `https://${request.headers.get('host') ?? 'localhost:3000'}`

    const stripe = getStripe()
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/settings/billing`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error('[stripe/portal] error:', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json(
      { error: `Portal session failed: ${message}` },
      { status: 500 }
    )
  }
}
