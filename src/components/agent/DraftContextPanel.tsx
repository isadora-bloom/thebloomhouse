'use client'

import { useEffect, useState } from 'react'
import { Sparkles, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'

// ---------------------------------------------------------------------------
// Types (must match src/lib/services/draft-context-summary.ts)
// ---------------------------------------------------------------------------

interface DraftContextSummary {
  venueName: string
  region: string | null
  aiName: string
  demandSummary: string | null
  topTrend: string | null
  weatherNote: string | null
  seasonalContext: string | null
  activeAnomaly: string | null
  oneLiner: string
}

interface Props {
  venueId: string
}

// ---------------------------------------------------------------------------
// Row rendering helper
// ---------------------------------------------------------------------------

function SignalRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <div className="flex items-start gap-3 text-xs">
      <span className="shrink-0 w-20 font-medium text-sage-500">{label}</span>
      <span className="text-sage-700 leading-relaxed">{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DraftContextPanel({ venueId }: Props) {
  const [summary, setSummary] = useState<DraftContextSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(
          `/api/agent/draft-context-summary?venueId=${encodeURIComponent(venueId)}`,
          { cache: 'no-store' }
        )
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const data = (await res.json()) as { summary: DraftContextSummary }
        if (!cancelled) {
          setSummary(data.summary)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load context')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [venueId])

  if (loading) {
    return (
      <div className="bg-sage-50 border border-sage-200 rounded-lg px-4 py-3 flex items-center gap-2 text-xs text-sage-600">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Loading context</span>
      </div>
    )
  }

  if (error || !summary) {
    return null
  }

  const aiName = summary.aiName || 'Sage'
  const hasAnySignal =
    summary.demandSummary ||
    summary.topTrend ||
    summary.weatherNote ||
    summary.seasonalContext ||
    summary.activeAnomaly

  return (
    <div className="bg-sage-50 border border-sage-200 rounded-lg overflow-hidden">
      {/* Collapsed header bar */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        disabled={!hasAnySignal}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-sage-100/60 transition-colors disabled:hover:bg-sage-50 disabled:cursor-default"
      >
        <Sparkles className="w-4 h-4 text-sage-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-sage-700 leading-tight">
            What {aiName} considered
          </p>
          <p className="text-xs text-sage-600 mt-0.5 leading-snug">
            {summary.oneLiner}
          </p>
        </div>
        {hasAnySignal && (
          <span className="shrink-0 text-sage-500">
            {expanded ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </span>
        )}
      </button>

      {/* Expanded rows */}
      {expanded && hasAnySignal && (
        <div className="px-4 pt-1 pb-3 space-y-2 border-t border-sage-200/70 bg-sage-50/60">
          <SignalRow label="Demand" value={summary.demandSummary} />
          <SignalRow label="Trend" value={summary.topTrend} />
          <SignalRow label="Weather" value={summary.weatherNote} />
          <SignalRow label="Seasonal" value={summary.seasonalContext} />
          <SignalRow label="Alert" value={summary.activeAnomaly} />
        </div>
      )}
    </div>
  )
}

export default DraftContextPanel
