'use client'

/**
 * Identity-backtrack coordinator review (Stream T5-Rixey-CCC, 2026-05-02).
 *
 * Lists medium-confidence storefront candidates the backtrack runner
 * has matched to a wedding but couldn't auto-link. Coordinator picks
 * Link / Reject / Defer per row. Mirrors the
 * /onboarding/identity-reconciliation Tier-2 card layout.
 *
 * Data source: GET /api/intel/identity-backtrack returns BacktrackReviewItem[]
 * computed in-memory by listPendingBacktrackReview. POST handles
 * Link (action='link'), Reject (action='reject'), and a Run-now button
 * that re-fires the venue-wide backtrack scan (action='run').
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Loader2, AlertTriangle, CheckCircle2, RefreshCw, ArrowRight,
  X, Sparkles, Calendar, MapPin,
} from 'lucide-react'

interface CandidateRow {
  id: string
  venue_id: string
  source_platform: string
  first_name: string | null
  last_initial: string | null
  state: string | null
  first_seen: string | null
  last_seen: string | null
  signal_count: number
  funnel_depth: number
}

interface WeddingRow {
  id: string
  venue_id: string
  inquiry_date: string | null
  source: string | null
  partner1_first_name: string | null
  partner1_last_name: string | null
  partner2_first_name: string | null
  partner2_last_name: string | null
  state: string | null
}

interface MatchRow {
  candidateId: string
  weddingId: string
  score: number
  evidence: string[]
  confidence: 'high' | 'medium' | 'low'
  matchedPartner: 'partner1' | 'partner2'
}

interface ReviewItem {
  candidate: CandidateRow
  wedding: WeddingRow
  match: MatchRow
}

interface Summary {
  venueId: string
  weddingsScanned: number
  candidatesEvaluated: number
  highAutoLinked: number
  mediumQueued: number
  lowSkipped: number
  noMatch: number
  ambiguousDeferred: number
  errors: string[]
}

export default function IdentityBacktrackPage() {
  const [items, setItems] = useState<ReviewItem[] | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const fetchItems = useCallback(async (run = false) => {
    setLoading(true)
    setError(null)
    try {
      const url = run ? '/api/intel/identity-backtrack?run=1' : '/api/intel/identity-backtrack'
      const res = await fetch(url)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { items: ReviewItem[]; summary: Summary | null }
      setItems(data.items ?? [])
      if (data.summary) setSummary(data.summary)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchItems(false) }, [fetchItems])

  async function handleRun() {
    if (busy) return
    if (!confirm('Run backtrack scan now? Existing high-confidence matches will be auto-linked.')) return
    setBusy(true)
    try {
      await fetchItems(true)
    } finally {
      setBusy(false)
    }
  }

  async function handleLink(item: ReviewItem) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/intel/identity-backtrack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'link',
          candidateId: item.candidate.id,
          weddingId: item.wedding.id,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setDismissed((prev) => new Set([...prev, item.candidate.id]))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Link failed')
    } finally { setBusy(false) }
  }

  async function handleReject(item: ReviewItem) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/intel/identity-backtrack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', candidateId: item.candidate.id }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setDismissed((prev) => new Set([...prev, item.candidate.id]))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reject failed')
    } finally { setBusy(false) }
  }

  function handleDefer(item: ReviewItem) {
    setDismissed((prev) => new Set([...prev, item.candidate.id]))
  }

  if (loading && !items) {
    return (
      <div className="p-8 max-w-4xl">
        <div className="flex items-center gap-2 text-sage-600">
          <Loader2 className="w-5 h-5 animate-spin" />
          Loading backtrack queue…
        </div>
      </div>
    )
  }

  const visible = (items ?? []).filter((it) => !dismissed.has(it.candidate.id))

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-heading text-2xl font-semibold text-sage-900">
          Identity backtrack
        </h1>
        <p className="text-sm text-sage-600 max-w-2xl">
          Storefront candidates the backtrack scan thinks could be a wedding but
          couldn&apos;t auto-link with full confidence. Pick Link to attribute,
          Reject to dismiss, or Defer to leave for later. Anchored on the
          Bloom Constitution Point-Zero attribution rules.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 text-sm">
          <AlertTriangle className="inline w-4 h-4 mr-2" />
          {error}
        </div>
      )}

      <div className="rounded-lg border border-sage-200 bg-white p-4 flex items-center justify-between gap-3">
        <div className="text-sm text-sage-600">
          {summary
            ? `Last scan: ${summary.candidatesEvaluated} candidate(s) evaluated across ${summary.weddingsScanned} wedding(s) — ${summary.highAutoLinked} auto-linked, ${summary.mediumQueued} queued, ${summary.ambiguousDeferred} deferred (ambiguous).`
            : 'Daily cron runs at 04:00 UTC. Run now to refresh.'}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchItems(false)}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded border border-sage-300 hover:bg-sage-50 disabled:opacity-50 text-sm font-medium px-3 py-1.5"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          <button
            onClick={handleRun}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Run scan
          </button>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <SummaryCard label="Auto-linked" value={summary.highAutoLinked} accent="sage" />
          <SummaryCard label="Queued" value={summary.mediumQueued} accent="amber" />
          <SummaryCard label="Ambiguous" value={summary.ambiguousDeferred} accent="amber" />
          <SummaryCard label="Low / no match" value={summary.lowSkipped + summary.noMatch} accent="muted" />
          <SummaryCard label="Errors" value={summary.errors.length} accent={summary.errors.length > 0 ? 'red' : 'muted'} />
        </div>
      )}

      {visible.length === 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-emerald-900">Queue empty</h3>
            <p className="text-sm text-emerald-700 mt-1">
              No medium-confidence backtrack matches need review. The cron
              re-evaluates every 24h; click Run scan to retry now.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Needs review ({visible.length})
          </h2>
          {visible.map((item) => (
            <ReviewCard
              key={item.candidate.id}
              item={item}
              onLink={handleLink}
              onReject={handleReject}
              onDefer={handleDefer}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SummaryCard({
  label,
  value,
  accent = 'muted',
}: { label: string; value: number; accent?: 'sage' | 'amber' | 'muted' | 'red' }) {
  const cls =
    accent === 'sage'
      ? 'border-sage-300 bg-sage-50'
      : accent === 'amber'
        ? 'border-amber-300 bg-amber-50'
        : accent === 'red'
          ? 'border-red-300 bg-red-50'
          : 'border-sage-200 bg-white'
  return (
    <div className={`rounded-lg border ${cls} p-3`}>
      <div className="text-xs text-sage-500">{label}</div>
      <div className="text-xl font-heading font-semibold text-sage-900 mt-0.5">{value}</div>
    </div>
  )
}

interface ReviewCardProps {
  item: ReviewItem
  onLink: (it: ReviewItem) => void
  onReject: (it: ReviewItem) => void
  onDefer: (it: ReviewItem) => void
  busy: boolean
}

function ReviewCard({ item, onLink, onReject, onDefer, busy }: ReviewCardProps) {
  const { candidate, wedding, match } = item
  const partnerName = match.matchedPartner === 'partner1'
    ? [wedding.partner1_first_name, wedding.partner1_last_name].filter(Boolean).join(' ')
    : [wedding.partner2_first_name, wedding.partner2_last_name].filter(Boolean).join(' ')
  const candidateLabel = `${candidate.first_name ?? '?'} ${(candidate.last_initial ?? '').toUpperCase()}.`

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <Sparkles className="w-4 h-4 text-amber-600" />
            <span className="font-medium text-sage-900">
              {candidateLabel}
            </span>
            <span className="rounded-full bg-sage-100 text-sage-700 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
              {candidate.source_platform}
            </span>
            {candidate.state && (
              <span className="text-xs text-sage-600 inline-flex items-center gap-1">
                <MapPin className="w-3 h-3" /> {candidate.state}
              </span>
            )}
            <span className="text-xs text-sage-500">
              · {candidate.signal_count} signal{candidate.signal_count === 1 ? '' : 's'},
              funnel depth {candidate.funnel_depth}
            </span>
          </div>
          <p className="text-sm text-amber-800 mt-1">
            score {match.score.toFixed(2)} — {match.evidence.join(', ')}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-sage-300 bg-white p-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium text-sage-900">
              Wedding: {partnerName || '(unnamed)'} — matches {match.matchedPartner}
            </div>
            <div className="mt-1 text-xs text-sage-600 flex items-center gap-3 flex-wrap">
              {wedding.inquiry_date && (
                <span className="inline-flex items-center gap-1">
                  <Calendar className="w-3 h-3" /> inquiry {wedding.inquiry_date.slice(0, 10)}
                </span>
              )}
              {wedding.source && <span>source: {wedding.source}</span>}
              {wedding.state && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> {wedding.state}
                </span>
              )}
            </div>
          </div>
          <a
            href={`/intel/clients/${wedding.id}`}
            className="text-xs text-sage-600 hover:text-sage-900 underline"
          >
            view lead
          </a>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={() => onDefer(item)}
          disabled={busy}
          className="text-sm text-sage-600 hover:text-sage-900 px-3 py-1.5 rounded hover:bg-sage-100"
        >
          I&apos;ll review later
        </button>
        <button
          onClick={() => onReject(item)}
          disabled={busy}
          className="inline-flex items-center gap-1 text-sm text-sage-700 hover:text-sage-900 border border-sage-300 hover:bg-sage-50 px-3 py-1.5 rounded"
        >
          <X className="w-3 h-3" /> Reject
        </button>
        <button
          onClick={() => onLink(item)}
          disabled={busy}
          className="inline-flex items-center gap-1 text-sm bg-sage-700 hover:bg-sage-800 text-white px-3 py-1.5 rounded disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
          Link to wedding
        </button>
      </div>
    </div>
  )
}
