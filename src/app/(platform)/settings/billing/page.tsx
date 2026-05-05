'use client'

import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  CreditCard,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Sparkles,
  ExternalLink,
  Calendar,
  Download,
  Receipt,
} from 'lucide-react'
import { PLANS, planForTier } from '@/lib/billing/plans'
import type { PlanTier } from '@/lib/hooks/use-plan-tier'

interface InvoiceRow {
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

interface SubscriptionSummary {
  venueId: string
  venueName: string
  tier: PlanTier
  hasSubscription: boolean
  hasCustomer: boolean
  status: string | null
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: string | null
  priceId: string | null
  cycle: 'monthly' | 'annual' | null
  amount: number | null
  currency: string | null
}

function statusLabel(status: string | null): { label: string; tone: 'ok' | 'warn' | 'err' | 'idle' } {
  if (!status) return { label: 'Free tier', tone: 'idle' }
  switch (status) {
    case 'active':
      return { label: 'Active', tone: 'ok' }
    case 'trialing':
      return { label: 'Trial', tone: 'ok' }
    case 'past_due':
      return { label: 'Past due', tone: 'warn' }
    case 'canceled':
      return { label: 'Canceled', tone: 'err' }
    case 'incomplete':
    case 'incomplete_expired':
      return { label: 'Incomplete', tone: 'warn' }
    case 'unpaid':
      return { label: 'Unpaid', tone: 'err' }
    default:
      return { label: status, tone: 'idle' }
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  } catch {
    return iso
  }
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

function BillingPageInner() {
  const searchParams = useSearchParams()
  const successFlag = searchParams.get('success') === 'true'

  const [loading, setLoading] = useState(true)
  const [sub, setSub] = useState<SubscriptionSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [portalLoading, setPortalLoading] = useState(false)
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [invoicesLoading, setInvoicesLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/stripe/subscription')
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to load subscription.')
        if (!cancelled) setSub(data as SubscriptionSummary)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    async function loadInvoices() {
      setInvoicesLoading(true)
      try {
        const res = await fetch('/api/stripe/invoices')
        const data = await res.json()
        if (res.ok && Array.isArray(data?.invoices)) {
          if (!cancelled) setInvoices(data.invoices as InvoiceRow[])
        }
      } catch {
        // Invoice history is supplementary — don't surface errors.
      } finally {
        if (!cancelled) setInvoicesLoading(false)
      }
    }
    load()
    loadInvoices()
    return () => { cancelled = true }
  }, [])

  async function openPortal() {
    setPortalLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Could not open billing portal.')
      }
      window.location.href = data.url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open billing portal.')
      setPortalLoading(false)
    }
  }

  const plan = sub ? planForTier(sub.tier) : undefined
  const status = statusLabel(sub?.status ?? null)

  return (
    <div className="flex-1 bg-warm-white">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Billing & Subscription
          </h1>
          <p className="text-sage-600 text-sm">
            Manage your plan, payment methods, and invoices.
          </p>
        </div>

        {/* Success banner after checkout */}
        {successFlag && (
          <div className="mb-6 rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Subscription activated.</div>
              <div className="text-green-700 mt-0.5">
                It may take a few seconds for plan features to unlock while we sync with Stripe.
              </div>
            </div>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Current plan card */}
        <div className="bg-white rounded-xl border border-sage-100 p-6 mb-6">
          <div className="flex items-start justify-between mb-6">
            <div>
              <div className="text-xs uppercase tracking-wider text-sage-500 mb-1">
                Current plan
              </div>
              <div className="flex items-center gap-3">
                <h2 className="font-heading text-2xl font-bold text-sage-900">
                  {plan?.name ?? 'Starter'}
                </h2>
                <span
                  className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                    status.tone === 'ok'
                      ? 'bg-green-100 text-green-700'
                      : status.tone === 'warn'
                        ? 'bg-amber-100 text-amber-700'
                        : status.tone === 'err'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-sage-100 text-sage-600'
                  }`}
                >
                  {status.label}
                </span>
              </div>
              {plan?.tagline && (
                <p className="text-sm text-sage-600 mt-1.5">{plan.tagline}</p>
              )}
            </div>

            <CreditCard className="w-6 h-6 text-sage-400" />
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-sage-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading subscription...
            </div>
          ) : (
            <>
              <div className="grid sm:grid-cols-3 gap-4 mb-6">
                <div>
                  <div className="text-xs text-sage-500 mb-1">Price</div>
                  <div className="text-sm font-medium text-sage-900">
                    {sub?.hasSubscription && sub?.amount != null
                      ? `${formatMoney(sub.amount, sub.currency)} / ${sub.cycle === 'annual' ? 'year' : 'month'}`
                      : plan && plan.monthly > 0
                        ? `$${plan.monthly} / month`
                        : 'Free'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-sage-500 mb-1">Billing cycle</div>
                  <div className="text-sm font-medium text-sage-900 capitalize">
                    {sub?.cycle ?? '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-sage-500 mb-1 flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {sub?.cancelAtPeriodEnd ? 'Ends on' : 'Next invoice'}
                  </div>
                  <div className="text-sm font-medium text-sage-900">
                    {formatDate(sub?.currentPeriodEnd ?? null)}
                  </div>
                </div>
              </div>

              {sub?.cancelAtPeriodEnd && (
                <div className="mb-6 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                  This subscription is set to cancel at the end of the current period.
                  You&apos;ll be downgraded to Starter on{' '}
                  <strong>{formatDate(sub.currentPeriodEnd)}</strong>.
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                {sub?.hasSubscription || sub?.hasCustomer ? (
                  <button
                    type="button"
                    onClick={openPortal}
                    disabled={portalLoading}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sage-600 text-white text-sm font-medium hover:bg-sage-700 transition-colors disabled:opacity-60"
                  >
                    {portalLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Opening portal...
                      </>
                    ) : (
                      <>
                        <ExternalLink className="w-4 h-4" />
                        Manage subscription
                      </>
                    )}
                  </button>
                ) : (
                  <Link
                    href="/pricing"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sage-600 text-white text-sm font-medium hover:bg-sage-700 transition-colors"
                  >
                    <Sparkles className="w-4 h-4" />
                    Upgrade plan
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                )}
                <Link
                  href="/pricing"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-sage-200 text-sage-700 text-sm font-medium hover:bg-sage-50 transition-colors"
                >
                  Compare plans
                </Link>
              </div>
            </>
          )}
        </div>

        {/* Invoice history */}
        <div className="bg-white rounded-xl border border-sage-100 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-heading text-lg font-bold text-sage-900 flex items-center gap-2">
              <Receipt className="w-5 h-5 text-sage-500" />
              Invoices
            </h3>
            {invoices.length > 0 && (
              <span className="text-xs text-sage-500">
                Last {invoices.length} {invoices.length === 1 ? 'invoice' : 'invoices'}
              </span>
            )}
          </div>

          {invoicesLoading ? (
            <div className="flex items-center gap-2 text-sm text-sage-500 py-3">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading invoices...
            </div>
          ) : invoices.length === 0 ? (
            <p className="text-sm text-sage-500 py-3">
              No invoices yet. Once you start a paid plan, your receipts will
              appear here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-sage-500 border-b border-sage-100">
                    <th className="py-2 pr-4 font-medium">Invoice</th>
                    <th className="py-2 pr-4 font-medium">Date</th>
                    <th className="py-2 pr-4 font-medium">Amount</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium text-right">Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const statusTone =
                      inv.status === 'paid'
                        ? 'bg-green-100 text-green-700'
                        : inv.status === 'open' || inv.status === 'uncollectible'
                          ? 'bg-amber-100 text-amber-700'
                          : inv.status === 'void' || inv.status === 'draft'
                            ? 'bg-sage-100 text-sage-600'
                            : 'bg-sage-100 text-sage-600'
                    return (
                      <tr key={inv.id} className="border-b border-sage-100 last:border-0">
                        <td className="py-3 pr-4 font-mono text-xs text-sage-700">
                          {inv.number ?? inv.id.slice(0, 12)}
                        </td>
                        <td className="py-3 pr-4 text-sage-700">
                          {formatDate(inv.created)}
                        </td>
                        <td className="py-3 pr-4 text-sage-900 font-medium">
                          {formatMoney(
                            inv.status === 'paid' ? inv.amountPaid : inv.amountDue,
                            inv.currency
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          <span
                            className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusTone}`}
                          >
                            {inv.status ?? '—'}
                          </span>
                        </td>
                        <td className="py-3 text-right">
                          <div className="inline-flex items-center gap-3">
                            {inv.hostedInvoiceUrl && (
                              <a
                                href={inv.hostedInvoiceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sage-700 hover:text-sage-900 inline-flex items-center gap-1 text-xs"
                              >
                                <ExternalLink className="w-3 h-3" />
                                View
                              </a>
                            )}
                            {inv.invoicePdfUrl && (
                              <a
                                href={inv.invoicePdfUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sage-700 hover:text-sage-900 inline-flex items-center gap-1 text-xs"
                              >
                                <Download className="w-3 h-3" />
                                PDF
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Available plans summary */}
        <div className="bg-white rounded-xl border border-sage-100 p-6">
          <h3 className="font-heading text-lg font-bold text-sage-900 mb-4">
            Other plans
          </h3>
          <div className="space-y-3">
            {PLANS.filter((p) => p.tier !== (sub?.tier ?? 'starter')).map((p) => (
              <div
                key={p.tier}
                className="flex items-center justify-between rounded-lg border border-sage-100 px-4 py-3"
              >
                <div>
                  <div className="font-medium text-sage-900">{p.name}</div>
                  <div className="text-xs text-sage-500">{p.tagline}</div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="text-sm font-semibold text-sage-900">
                      {p.monthly === 0 ? 'Free' : `$${p.monthly}/mo`}
                    </div>
                    {p.annual > 0 && (
                      <div className="text-xs text-sage-500">
                        ${p.annual}/yr
                      </div>
                    )}
                  </div>
                  <Link
                    href="/pricing"
                    className="text-sm text-sage-700 hover:text-sage-900 font-medium whitespace-nowrap"
                  >
                    View
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingPageInner />
    </Suspense>
  )
}
