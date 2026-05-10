'use client'

/**
 * Wave 6C — embeddable preview of the top 3 pending recommendations.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (6C: surface a preview on
 * Wave 6B's marketing-roi dashboard so the operator sees actionable
 * recommendations alongside the heatmap. Click-through goes to the
 * deep-dive page at /intel/marketing-roi/recommendations.)
 *
 * Read-only — decide / measure live on the deep-dive page.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Loader2,
  Sparkles,
  ArrowRight,
  AlertTriangle,
  ExternalLink,
  DollarSign,
  Target,
} from 'lucide-react'

interface PanelRecommendationRow {
  id: string
  recommendation_title: string
  action_type: string
  source_channel: string | null
  target_channel: string | null
  target_persona: string | null
  estimated_monthly_dollar_impact_cents: number | null
  confidence_0_100: number
  n_too_small_warning: boolean
  generated_at: string
  status: string
}

interface ListResponse {
  ok: true
  recommendations: PanelRecommendationRow[]
}

function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  const abs = Math.abs(cents) / 100
  const sign = cents < 0 ? '-' : ''
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

function formatChannelLabel(c: string | null | undefined): string {
  if (!c) return '—'
  const map: Record<string, string> = {
    google_ads: 'Google Ads',
    meta_ads: 'Meta Ads',
    tiktok_ads: 'TikTok Ads',
    theknot_fee: 'The Knot',
    weddingwire_fee: 'WeddingWire',
    organic_seo: 'Organic SEO',
    vendor_referral: 'Vendor Referral',
    other: 'Other',
  }
  return (
    map[c] ?? c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
  )
}

function formatPersonaLabel(p: string | null | undefined): string {
  if (!p) return '—'
  return p.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function actionBadgeStyle(action: string): string {
  switch (action) {
    case 'reallocate':
      return 'bg-amber-50 text-amber-800 border-amber-200'
    case 'pause':
      return 'bg-rose-50 text-rose-800 border-rose-200'
    case 'scale':
      return 'bg-emerald-50 text-emerald-800 border-emerald-200'
    case 'investigate':
      return 'bg-sky-50 text-sky-800 border-sky-200'
    case 'other':
    default:
      return 'bg-stone-50 text-stone-700 border-stone-200'
  }
}

export function MarketingRecommendationsPanel() {
  const [recs, setRecs] = useState<PanelRecommendationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const resp = await fetch(
          '/api/admin/intel/marketing-recommendations/list?status=pending',
        )
        const j = (await resp.json()) as
          | ListResponse
          | { ok: false; error: string }
        if (cancelled) return
        if (!resp.ok || !('ok' in j) || j.ok !== true) {
          setErr(
            'error' in j && typeof j.error === 'string'
              ? j.error
              : 'Failed to load recommendations',
          )
          return
        }
        setRecs(j.recommendations.slice(0, 3))
      } catch (e) {
        if (cancelled) return
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg text-stone-900">
          <Sparkles className="mr-1 inline h-4 w-4 text-amber-500" />
          Pending recommendations
        </h2>
        <Link
          href="/intel/marketing-roi/recommendations"
          className="inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700"
        >
          See all <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
      <p className="mt-1 text-xs text-stone-500">
        Top 3 reallocation moves the analyst suggests. Decide on the deep-dive
        page.
      </p>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : null}

      {err ? (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {err}
        </div>
      ) : null}

      {!loading && !err && recs.length === 0 ? (
        <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-500">
          No pending recommendations.{' '}
          <Link
            href="/intel/marketing-roi/recommendations"
            className="text-stone-700 underline-offset-2 hover:underline"
          >
            Generate now
          </Link>{' '}
          to ask the analyst.
        </div>
      ) : null}

      {recs.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {recs.map((rec) => {
            const impact = rec.estimated_monthly_dollar_impact_cents
            const impactPositive = impact !== null && impact > 0
            const impactNegative = impact !== null && impact < 0
            return (
              <li
                key={rec.id}
                className="rounded-md border border-stone-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${actionBadgeStyle(
                      rec.action_type,
                    )}`}
                  >
                    {rec.action_type}
                  </span>
                  {rec.n_too_small_warning ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                      <AlertTriangle className="h-3 w-3" />
                      n &lt; 10
                    </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs text-stone-700">
                    <Target className="h-3 w-3" />
                    {rec.confidence_0_100}%
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-stone-900">
                      {rec.recommendation_title}
                    </div>
                    {(rec.source_channel ||
                      rec.target_channel ||
                      rec.target_persona) ? (
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-stone-600">
                        {rec.source_channel ? (
                          <span className="rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5">
                            {formatChannelLabel(rec.source_channel)}
                          </span>
                        ) : null}
                        {rec.source_channel && rec.target_channel ? (
                          <ArrowRight className="h-3 w-3 text-stone-400" />
                        ) : null}
                        {rec.target_channel ? (
                          <span className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-emerald-800">
                            {formatChannelLabel(rec.target_channel)}
                          </span>
                        ) : null}
                        {rec.target_persona ? (
                          <span className="text-stone-500">
                            · {formatPersonaLabel(rec.target_persona)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {impact !== null ? (
                    <div className="text-right">
                      <div
                        className={`text-base font-semibold tabular-nums ${
                          impactPositive
                            ? 'text-emerald-700'
                            : impactNegative
                              ? 'text-rose-700'
                              : 'text-stone-700'
                        }`}
                      >
                        <DollarSign className="inline h-3 w-3 align-baseline" />
                        {formatCents(Math.abs(impact))}
                      </div>
                      <div className="text-[11px] text-stone-500">/ month</div>
                    </div>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
