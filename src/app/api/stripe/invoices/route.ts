import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getStripe, isStripeConfigured } from '@/lib/stripe'
import { redactError } from '@/lib/observability/redact'
import type Stripe from 'stripe'

// ---------------------------------------------------------------------------
// GET /api/stripe/invoices
//
// Returns the venue's last 10 invoices (paid + unpaid) for the
// /settings/billing invoice history table. Always reads from Stripe —
// we never cache invoice rows in our own DB to avoid drift.
// ---------------------------------------------------------------------------

export interface InvoiceRow {
  id: string
  number: string | null
  status: string | null
  amountDue: number
  amountPaid: number
  currency: string
  created: string | null
  paidAt: string | null
  hostedInvoiceUrl: string | null
  invoicePdfUrl: string | null
}

export async function GET(_request: NextRequest) {
  try {
    if (!isStripeConfigured()) {
      return NextResponse.json({ invoices: [] })
    }

    const anonSupabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await anonSupabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
    }

    const service = createServiceClient()
    const { data: profile } = await service
      .from('user_profiles')
      .select('venue_id')
      .eq('id', user.id)
      .maybeSingle()
    const venueId = (profile?.venue_id as string | null) ?? null
    if (!venueId) {
      return NextResponse.json({ invoices: [] })
    }

    const { data: venue } = await service
      .from('venues')
      .select('stripe_customer_id')
      .eq('id', venueId)
      .maybeSingle()
    const customerId = (venue?.stripe_customer_id as string | null) ?? null
    if (!customerId) {
      return NextResponse.json({ invoices: [] })
    }

    const stripe = getStripe()
    const list = await stripe.invoices.list({
      customer: customerId,
      limit: 10,
    })

    const invoices: InvoiceRow[] = list.data.map((inv: Stripe.Invoice) => ({
      id: inv.id ?? '',
      number: inv.number ?? null,
      status: inv.status ?? null,
      amountDue: (inv.amount_due ?? 0) / 100,
      amountPaid: (inv.amount_paid ?? 0) / 100,
      currency: (inv.currency ?? 'usd').toUpperCase(),
      created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      paidAt: inv.status_transitions?.paid_at
        ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
        : null,
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      invoicePdfUrl: inv.invoice_pdf ?? null,
    }))

    return NextResponse.json({ invoices })
  } catch (err) {
    console.error('[stripe/invoices] error:', redactError(err))
    return NextResponse.json(
      { error: 'Failed to load invoices.' },
      { status: 500 }
    )
  }
}
