import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { CheckCircle2, ArrowRight, AlertCircle, Sparkles } from 'lucide-react'
import { cookies } from 'next/headers'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getStripe, isStripeConfigured } from '@/lib/stripe'
import { planTierForPriceId, planForTier } from '@/lib/billing/plans'
import type { PlanTier } from '@/lib/auth/plan-tiers'
import type Stripe from 'stripe'
import { verifyDemoToken, DEMO_TOKEN_COOKIE } from '@/lib/services/demo-token'

// ---------------------------------------------------------------------------
// /billing/success — server-rendered checkout confirmation (GAP-02).
//
// Stripe redirects here with `?session_id=cs_...` after a successful
// Checkout. We MUST verify the session against the Stripe API server-side
// before showing any plan/amount data — never trust the client param for
// plan_tier (that's how attackers could pretend they bought enterprise
// by editing the URL).
//
// Hardening:
//   - Auth required (anon Supabase). Anonymous visits get 404 to avoid
//     leaking session metadata to an attacker who guessed a session id.
//   - Session.client_reference_id must equal the caller's venue_id.
//     If it doesn't, we return notFound() — the user is asking for
//     someone else's confirmation page.
//   - All amounts/tiers come from the live Stripe session, never the URL.
//   - Webhook is the source of truth for venues.plan_tier; this page just
//     reads it for the "current tier" display. If the webhook hasn't
//     landed yet (eventual consistency), we still show the Stripe
//     amount + plan name and let the user know the sync is in progress.
// ---------------------------------------------------------------------------

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ session_id?: string }>
}

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount == null) return '—'
  const cur = (currency || 'usd').toUpperCase()
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount)
  } catch {
    return `$${amount}`
  }
}

function formatDate(value: number | string | null): string {
  if (value == null) return '—'
  try {
    const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  } catch {
    return '—'
  }
}

export default async function BillingSuccessPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const sessionId = (sp.session_id ?? '').trim()

  // Reject obviously-malformed inputs early without doing a Stripe call.
  if (!sessionId || !sessionId.startsWith('cs_')) {
    notFound()
  }

  // Demo token users don't have real Stripe sessions — send them home.
  const cookieStore = await cookies()
  if (verifyDemoToken(cookieStore.get(DEMO_TOKEN_COOKIE)?.value).ok) {
    redirect('/settings/billing')
  }

  // Auth — anonymous visitors get 404, not a redirect, so a leaked URL
  // can't be used to phish coordinators back through login.
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    notFound()
  }

  if (!isStripeConfigured()) {
    return (
      <NotConfigured />
    )
  }

  // Resolve the user's venue.
  const service = createServiceClient()
  const { data: profile } = await service
    .from('user_profiles')
    .select('venue_id')
    .eq('id', user.id)
    .maybeSingle()

  const venueId = (profile?.venue_id as string | null) ?? null
  if (!venueId) {
    notFound()
  }

  // Retrieve the session from Stripe with the line items + price expanded
  // so we can render the plan/amount without a follow-up call.
  let session: Stripe.Checkout.Session
  try {
    const stripe = getStripe()
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price', 'subscription'],
    })
  } catch (err) {
    console.warn('[billing/success] sessions.retrieve failed:', err)
    return (
      <RetrieveFailed sessionId={sessionId} />
    )
  }

  // CRITICAL — bind the session to the caller's venue. Without this,
  // any logged-in user could pass any session_id and see somebody
  // else's plan/amount.
  if (session.client_reference_id && session.client_reference_id !== venueId) {
    notFound()
  }

  // Pull canonical fields from the live session.
  const lineItem = session.line_items?.data?.[0]
  const price = lineItem?.price ?? null
  const priceId = price?.id ?? null
  const amount =
    price?.unit_amount != null
      ? price.unit_amount / 100
      : session.amount_total != null
        ? session.amount_total / 100
        : null
  const currency = price?.currency ?? session.currency ?? 'usd'
  const interval = price?.recurring?.interval ?? null
  const cycleLabel = interval === 'year' ? 'year' : interval === 'month' ? 'month' : null

  // Plan tier comes from the priceId mapping — never from a URL or DB
  // value the user can influence.
  const stripeTier: PlanTier | null = priceId ? planTierForPriceId(priceId) : null
  const plan = stripeTier ? planForTier(stripeTier) : undefined

  // The webhook is the source of truth for venues.plan_tier — read it,
  // but show a "syncing" hint if it hasn't matched yet.
  const { data: venue } = await service
    .from('venues')
    .select('plan_tier, name')
    .eq('id', venueId)
    .maybeSingle()
  const currentTier = (venue?.plan_tier as PlanTier | undefined) ?? 'starter'
  const syncPending = stripeTier !== null && currentTier !== stripeTier

  const subscription =
    typeof session.subscription === 'object' && session.subscription !== null
      ? (session.subscription as Stripe.Subscription)
      : null
  const startDate =
    subscription?.start_date ??
    subscription?.current_period_start ??
    (session.created as number | undefined) ??
    null
  const renewsAt = subscription?.current_period_end ?? null

  // Payment status guard — if Stripe says the session isn't paid,
  // don't show the celebration UI (could be a bank-pending or test
  // card decline that still 200'd). Respect "no_payment_required" for
  // free trials.
  const payOk =
    session.payment_status === 'paid' ||
    session.payment_status === 'no_payment_required'

  return (
    <div className="min-h-screen bg-warm-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 mb-4">
            <CheckCircle2 className="w-9 h-9 text-green-600" />
          </div>
          <h1 className="font-heading text-4xl font-bold text-sage-900 mb-2">
            {payOk ? "You're in." : 'Subscription pending payment'}
          </h1>
          <p className="text-sage-600">
            {payOk
              ? plan
                ? `${plan.name} is now active for ${venue?.name ?? 'your venue'}.`
                : 'Your subscription is now active.'
              : 'Stripe is still confirming your payment. We will activate your plan as soon as it clears.'}
          </p>
        </div>

        {/* Plan summary card */}
        <div className="bg-white rounded-2xl border border-sage-100 shadow-sm p-8 mb-6">
          <div className="grid sm:grid-cols-2 gap-y-6 gap-x-8">
            <div>
              <div className="text-xs uppercase tracking-wider text-sage-500 mb-1">
                Plan
              </div>
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-sage-500" />
                <span className="text-lg font-semibold text-sage-900">
                  {plan?.name ?? 'Subscription'}
                </span>
              </div>
              {plan?.tagline && (
                <p className="text-sm text-sage-600 mt-1">{plan.tagline}</p>
              )}
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-sage-500 mb-1">
                Amount
              </div>
              <div className="text-lg font-semibold text-sage-900">
                {formatMoney(amount, currency)}
                {cycleLabel && (
                  <span className="text-sm font-normal text-sage-600">
                    {' / '}
                    {cycleLabel}
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-sage-500 mb-1">
                Started
              </div>
              <div className="text-sm font-medium text-sage-900">
                {formatDate(startDate)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-sage-500 mb-1">
                Next renewal
              </div>
              <div className="text-sm font-medium text-sage-900">
                {formatDate(renewsAt)}
              </div>
            </div>
          </div>

          {syncPending && (
            <div className="mt-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                Stripe is still notifying us about your purchase. Plan features
                will unlock within a minute. If they don&apos;t, refresh the
                billing page or contact support with session{' '}
                <code className="font-mono text-xs">{sessionId}</code>.
              </span>
            </div>
          )}
        </div>

        {/* Receipt + next steps */}
        <div className="flex flex-wrap gap-3 justify-center">
          <Link
            href="/settings/billing"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sage-600 text-white text-sm font-medium hover:bg-sage-700 transition-colors"
          >
            Manage subscription
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-sage-200 text-sage-700 text-sm font-medium hover:bg-sage-50 transition-colors"
          >
            Back to dashboard
          </Link>
        </div>

        <p className="text-center text-xs text-sage-500 mt-8">
          Receipt: <code className="font-mono">{sessionId}</code>
        </p>
      </div>
    </div>
  )
}

function NotConfigured() {
  return (
    <div className="min-h-screen bg-warm-white">
      <div className="max-w-2xl mx-auto px-6 py-20 text-center">
        <AlertCircle className="w-10 h-10 text-amber-500 mx-auto mb-4" />
        <h1 className="font-heading text-2xl font-bold text-sage-900 mb-2">
          Billing not configured
        </h1>
        <p className="text-sage-600 mb-6">
          Stripe credentials are missing on this server. Contact your
          administrator.
        </p>
        <Link
          href="/"
          className="text-sage-700 underline"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}

function RetrieveFailed({ sessionId }: { sessionId: string }) {
  return (
    <div className="min-h-screen bg-warm-white">
      <div className="max-w-2xl mx-auto px-6 py-20 text-center">
        <AlertCircle className="w-10 h-10 text-amber-500 mx-auto mb-4" />
        <h1 className="font-heading text-2xl font-bold text-sage-900 mb-2">
          We couldn&apos;t verify your checkout
        </h1>
        <p className="text-sage-600 mb-2">
          Stripe didn&apos;t recognise that session. If you completed a
          payment, our webhook will still pick it up.
        </p>
        <p className="text-xs text-sage-500 mb-6">
          Reference: <code className="font-mono">{sessionId}</code>
        </p>
        <Link
          href="/settings/billing"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sage-600 text-white text-sm font-medium hover:bg-sage-700 transition-colors"
        >
          Go to billing
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </div>
  )
}
