'use client'

import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Check, Sparkles, Loader2, ArrowRight, AlertCircle } from 'lucide-react'
import { PLANS, type Plan } from '@/lib/billing/plans'

type BillingCycle = 'monthly' | 'annual'

function PricingPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const canceled = searchParams.get('canceled') === 'true'

  const [cycle, setCycle] = useState<BillingCycle>('monthly')
  const [loadingTier, setLoadingTier] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Clear the `canceled` flag after first render so refresh doesn't show it again
  useEffect(() => {
    if (canceled) {
      const t = setTimeout(() => setError(null), 8000)
      return () => clearTimeout(t)
    }
  }, [canceled])

  async function startCheckout(plan: Plan) {
    setError(null)

    const priceId = cycle === 'monthly' ? plan.monthlyPriceId : plan.annualPriceId
    if (!priceId) {
      setError(`${plan.name} ${cycle} pricing is not configured yet. Please contact support.`)
      return
    }

    setLoadingTier(plan.tier)
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, billingCycle: cycle }),
      })

      if (res.status === 401) {
        // Not logged in — send to login with a redirect back here
        router.push('/login?redirect=/pricing')
        return
      }

      const data = await res.json()
      if (!res.ok || !data.url) {
        setError(data.error || 'Could not start checkout. Please try again.')
        setLoadingTier(null)
        return
      }

      // Redirect to Stripe Checkout
      window.location.href = data.url
    } catch (err) {
      console.error('[pricing] checkout error:', err)
      setError('Network error. Please try again.')
      setLoadingTier(null)
    }
  }

  return (
    <div className="min-h-screen bg-warm-white">
      {/* Top bar */}
      <header className="border-b border-sage-100">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <img src="/brand/wordmark-sage.png" alt="The Bloom House" className="h-7 w-auto" />
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/login" className="text-sage-700 hover:text-sage-900">Log in</Link>
            <Link
              href="/signup"
              className="px-4 py-2 rounded-lg bg-sage-600 text-white hover:bg-sage-700 transition-colors"
            >
              Start free
            </Link>
          </nav>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-16">
        {/* Heading */}
        <div className="text-center mb-12">
          <h1 className="font-heading text-4xl md:text-5xl font-bold text-sage-900 mb-4">
            Pricing that grows with your venue
          </h1>
          <p className="text-lg text-sage-600 max-w-2xl mx-auto">
            Every plan includes the full Bloom platform. Capacity is the only
            difference.
          </p>
        </div>

        {/* Canceled notice */}
        {canceled && !error && (
          <div className="max-w-xl mx-auto mb-8 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Checkout canceled. No changes were made to your subscription.</span>
          </div>
        )}

        {/* Error notice */}
        {error && (
          <div className="max-w-xl mx-auto mb-8 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Billing cycle toggle */}
        <div className="flex items-center justify-center mb-12">
          <div className="inline-flex rounded-full bg-sage-100 p-1">
            <button
              type="button"
              onClick={() => setCycle('monthly')}
              className={`px-5 py-2 rounded-full text-sm font-medium transition-colors ${
                cycle === 'monthly'
                  ? 'bg-white text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setCycle('annual')}
              className={`px-5 py-2 rounded-full text-sm font-medium transition-colors ${
                cycle === 'annual'
                  ? 'bg-white text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              Annual
              <span className="ml-2 text-xs text-gold-600 font-semibold">Save 15%</span>
            </button>
          </div>
        </div>

        {/* Plan cards. 5 tiers — 2 rows on lg (3 + 2) so cards stay legible. */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6">
          {PLANS.map((plan) => {
            const price = cycle === 'monthly' ? plan.monthly : plan.annual
            const priceLabel = cycle === 'monthly' ? '/mo' : '/yr'
            const isContact = plan.contactSales === true || price === 0
            const isLoading = loadingTier === plan.tier

            return (
              <div
                key={plan.tier}
                className={`relative rounded-2xl border-2 p-6 flex flex-col ${
                  plan.featured
                    ? 'border-sage-500 bg-white shadow-lg'
                    : 'border-sage-100 bg-white'
                }`}
              >
                {plan.featured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-sage-600 text-white text-xs font-semibold tracking-wide flex items-center gap-1">
                    <Sparkles className="w-3 h-3" />
                    MOST POPULAR
                  </div>
                )}

                <div className="mb-6">
                  <h3 className="font-heading text-2xl font-bold text-sage-900 mb-1">
                    {plan.name}
                  </h3>
                  <p className="text-sm text-sage-600 leading-relaxed">
                    {plan.tagline}
                  </p>
                </div>

                <div className="mb-6">
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold text-sage-900">
                      {plan.tier === 'enterprise'
                        ? 'Custom'
                        : cycle === 'annual' && plan.annual === 0
                        ? `$${plan.monthly.toLocaleString()}`
                        : `$${price.toLocaleString()}`}
                    </span>
                    {plan.tier !== 'enterprise' && (
                      <span className="text-sage-500 text-sm">
                        {cycle === 'annual' && plan.annual === 0 ? '/mo' : priceLabel}
                      </span>
                    )}
                  </div>
                  {cycle === 'annual' && plan.annual === 0 && plan.tier !== 'enterprise' && (
                    <p className="text-xs text-sage-500 mt-1">
                      Monthly only — annual prepay not available on this tier.
                    </p>
                  )}
                  {!isContact && cycle === 'annual' && plan.annual > 0 && (
                    <p className="text-xs text-sage-500 mt-1">
                      ${(plan.annual / 12).toFixed(0)} per month, billed annually
                    </p>
                  )}
                </div>

                {/* Capacity row */}
                <div className="mb-6 -mt-3 text-xs text-sage-600 space-y-0.5">
                  <div>{plan.capacity.inquiries} inquiries</div>
                  <div>{plan.capacity.venues === '1' ? '1 venue' : plan.capacity.venues}</div>
                  <div>{plan.capacity.couples} couples</div>
                </div>

                {isContact ? (
                  <Link
                    href="/contact"
                    className="w-full text-center px-4 py-2.5 rounded-lg bg-sage-100 text-sage-800 text-sm font-medium hover:bg-sage-200 transition-colors mb-6"
                  >
                    Contact us
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => startCheckout(plan)}
                    disabled={isLoading}
                    className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors mb-6 disabled:opacity-60 disabled:cursor-not-allowed ${
                      plan.featured
                        ? 'bg-sage-600 text-white hover:bg-sage-700'
                        : 'bg-sage-800 text-white hover:bg-sage-900'
                    }`}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Redirecting...
                      </>
                    ) : (
                      <>
                        Choose {plan.name}
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                )}

                <ul className="space-y-2.5 text-sm text-sage-700">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check className="w-4 h-4 text-sage-500 mt-0.5 shrink-0" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>

        {/* Footer note */}
        <div className="text-center mt-12 text-sm text-sage-500">
          Questions about Enterprise or need a custom plan?{' '}
          <a href="mailto:hello@thebloomhouse.ai" className="text-sage-700 underline">
            Contact us
          </a>
          .
        </div>
      </div>
    </div>
  )
}

export default function PricingPage() {
  return (
    <Suspense fallback={null}>
      <PricingPageInner />
    </Suspense>
  )
}
