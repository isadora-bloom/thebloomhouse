'use client'

/**
 * Backfill checklist — paid-venue 12-month historical context tracker
 * (ARCH-18.2 / 18.3-C / 18.3-D / LIMB-16.3).
 *
 * Mounts on /onboarding/project Day 5. Fetches per-category coverage
 * via GET /api/onboarding/backfill and renders one row per category
 * with status + action button. External Context categories (weather,
 * search_trends, fred) have a "Run backfill" trigger; Internal
 * categories link out to the admin UI where coordinator entry happens.
 *
 * Every category has a "Skip" affordance with a reason field — for
 * brand-new venues that genuinely have no history.
 */

import { useState, useEffect, useCallback } from 'react'
import { Loader2, CheckCircle2, AlertTriangle, Clock, ExternalLink, Play } from 'lucide-react'

type Status = 'not_started' | 'partial' | 'complete' | 'skipped'

interface Coverage {
  category: string
  status: Status
  oldest_at: string | null
  newest_at: string | null
  row_count: number
  coverage_days: number
  hint: string
}

interface BackfillResponse {
  venueId: string
  score: number
  coverages: Coverage[]
  categoriesRequired: string[]
}

const CATEGORY_LABELS: Record<string, string> = {
  email_history: 'Email history (12mo Gmail backfill)',
  marketing_spend: 'Marketing spend (monthly)',
  pricing_history: 'Pricing changes',
  absences: 'Coordinator absences',
  property_state: 'Renovations / closures',
  marketing_channels: 'Marketing channels (with activated_at)',
  weather: 'Weather (12mo NOAA)',
  search_trends: 'Search trends (12mo SerpAPI)',
  fred: 'FRED economic indicators',
  cultural_moments: 'Cultural moments (manual)',
}

/** Categories that have an auto-trigger in /api/onboarding/backfill POST. */
const AUTO_FETCHABLE = new Set(['weather', 'search_trends', 'fred'])

/** Internal Context admin pages — coordinator does the data entry. */
const INTERNAL_LINKS: Record<string, string> = {
  marketing_spend: '/portal/marketing-channels-config',
  pricing_history: '/agent/settings',
  absences: '/portal/absences-config',
  property_state: '/portal/property-state-config',
  marketing_channels: '/portal/marketing-channels-config',
  cultural_moments: '/intel/cultural-moments',
  email_history: '/onboarding/project',  // Day 1 backfill button
}

function statusColor(status: Status): string {
  switch (status) {
    case 'complete': return 'text-emerald-700 bg-emerald-50 border-emerald-200'
    case 'skipped':  return 'text-sage-600 bg-sage-50 border-sage-200'
    case 'partial':  return 'text-amber-700 bg-amber-50 border-amber-200'
    case 'not_started':
    default:         return 'text-sage-500 bg-sage-50 border-sage-200'
  }
}

function statusLabel(status: Status, coverageDays: number): string {
  if (status === 'complete') return `Complete (${coverageDays}d)`
  if (status === 'skipped') return 'Skipped'
  if (status === 'partial') return `Partial (${coverageDays}d / 365d)`
  return 'Not started'
}

export function BackfillChecklist({ venueId }: { venueId?: string }) {
  const [data, setData] = useState<BackfillResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [skipFor, setSkipFor] = useState<string | null>(null)
  const [skipReason, setSkipReason] = useState('')

  const url = venueId ? `/api/onboarding/backfill?venueId=${venueId}` : '/api/onboarding/backfill'

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as BackfillResponse
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [url])

  useEffect(() => { refresh() }, [refresh])

  async function trigger(category: string) {
    setBusy(category)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Trigger failed')
    } finally {
      setBusy(null)
    }
  }

  async function commitSkip(category: string) {
    if (skipReason.trim().length < 4) {
      setError('Reason must be at least 4 characters')
      return
    }
    setBusy(category)
    try {
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}action=skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, reason: skipReason.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setSkipFor(null)
      setSkipReason('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Skip failed')
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-sage-200 bg-warm-white p-4 flex items-center gap-2 text-sm text-sage-600">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading backfill status…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Backfill checklist unavailable{error ? ` — ${error}` : ''}
      </div>
    )
  }

  const requiredSet = new Set(data.categoriesRequired)
  const required = data.coverages.filter((c) => requiredSet.has(c.category))
  const optional = data.coverages.filter((c) => !requiredSet.has(c.category))
  const scoreColor = data.score >= 80 ? 'text-emerald-700' : data.score >= 50 ? 'text-amber-700' : 'text-red-700'

  return (
    <div className="rounded-lg border border-sage-300 bg-warm-white p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-heading text-lg font-semibold text-sage-900">12-month backfill</h3>
          <p className="text-xs text-sage-600 mt-1">
            Paid venues need <strong>≥ 80</strong> to Go Live. Each category counts when it has 12+ months of coverage or is explicitly skipped.
          </p>
        </div>
        <div className="text-right">
          <div className={`text-3xl font-bold ${scoreColor}`}>{data.score}<span className="text-sm font-normal text-sage-500">/100</span></div>
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">Required</h4>
        <ul className="space-y-2">
          {required.map((c) => (
            <CategoryRow
              key={c.category}
              coverage={c}
              busy={busy === c.category}
              onTrigger={AUTO_FETCHABLE.has(c.category) ? () => trigger(c.category) : null}
              internalLink={INTERNAL_LINKS[c.category]}
              onSkipRequest={() => { setSkipFor(c.category); setSkipReason('') }}
              isSkipping={skipFor === c.category}
              skipReason={skipReason}
              onSkipReasonChange={setSkipReason}
              onSkipCommit={() => commitSkip(c.category)}
              onSkipCancel={() => { setSkipFor(null); setSkipReason('') }}
            />
          ))}
        </ul>
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">Optional (bonus only — won&apos;t block Go Live)</h4>
        <ul className="space-y-2">
          {optional.map((c) => (
            <CategoryRow
              key={c.category}
              coverage={c}
              busy={busy === c.category}
              onTrigger={AUTO_FETCHABLE.has(c.category) ? () => trigger(c.category) : null}
              internalLink={INTERNAL_LINKS[c.category]}
              onSkipRequest={() => { setSkipFor(c.category); setSkipReason('') }}
              isSkipping={skipFor === c.category}
              skipReason={skipReason}
              onSkipReasonChange={setSkipReason}
              onSkipCommit={() => commitSkip(c.category)}
              onSkipCancel={() => { setSkipFor(null); setSkipReason('') }}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}

interface CategoryRowProps {
  coverage: Coverage
  busy: boolean
  onTrigger: (() => void) | null
  internalLink: string | undefined
  onSkipRequest: () => void
  isSkipping: boolean
  skipReason: string
  onSkipReasonChange: (s: string) => void
  onSkipCommit: () => void
  onSkipCancel: () => void
}

function CategoryRow({
  coverage, busy, onTrigger, internalLink,
  onSkipRequest, isSkipping, skipReason, onSkipReasonChange, onSkipCommit, onSkipCancel,
}: CategoryRowProps) {
  const Icon = coverage.status === 'complete' ? CheckCircle2
    : coverage.status === 'skipped' ? Clock
    : AlertTriangle

  return (
    <li className={`rounded border p-3 ${statusColor(coverage.status)} flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2`}>
      <div className="flex items-center gap-3 min-w-0">
        <Icon className="w-4 h-4 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-sage-900 truncate">{CATEGORY_LABELS[coverage.category] ?? coverage.category}</div>
          <div className="text-xs">
            {statusLabel(coverage.status, coverage.coverage_days)}
            {coverage.row_count > 0 && coverage.status !== 'skipped' && (
              <span className="ml-2 text-sage-500">· {coverage.row_count} rows</span>
            )}
          </div>
          {coverage.status !== 'complete' && coverage.status !== 'skipped' && (
            <div className="text-xs text-sage-600 italic mt-1">{coverage.hint}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!isSkipping ? (
          <>
            {onTrigger && coverage.status !== 'complete' && coverage.status !== 'skipped' && (
              <button
                onClick={onTrigger}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-sage-700 hover:bg-sage-800 text-white disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                Run backfill
              </button>
            )}
            {internalLink && coverage.status !== 'complete' && coverage.status !== 'skipped' && (
              <a
                href={internalLink}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-sage-300 hover:bg-sage-100 text-sage-700"
              >
                <ExternalLink className="w-3 h-3" />
                Open admin
              </a>
            )}
            {coverage.status !== 'complete' && coverage.status !== 'skipped' && (
              <button
                onClick={onSkipRequest}
                className="text-xs px-2 py-1 rounded border border-sage-300 hover:bg-sage-100 text-sage-600"
              >
                Skip
              </button>
            )}
          </>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={skipReason}
              onChange={(e) => onSkipReasonChange(e.target.value)}
              placeholder="Reason (e.g. brand-new venue, no history)"
              className="text-xs px-2 py-1 rounded border border-sage-300 w-64"
              autoFocus
            />
            <button
              onClick={onSkipCommit}
              disabled={busy}
              className="text-xs px-2 py-1 rounded bg-sage-700 hover:bg-sage-800 text-white disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              onClick={onSkipCancel}
              className="text-xs px-2 py-1 rounded border border-sage-300 hover:bg-sage-100 text-sage-600"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </li>
  )
}
