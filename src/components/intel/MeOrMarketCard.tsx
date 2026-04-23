'use client'

import { useEffect, useState } from 'react'
import { Compass, TrendingUp, TrendingDown, Minus, Search, Gauge, CalendarCheck } from 'lucide-react'

// ---------------------------------------------------------------------------
// Types matching /api/intel/me-or-market response
// ---------------------------------------------------------------------------

type Verdict = 'market' | 'venue' | 'mixed' | 'insufficient_data'

interface Diagnosis {
  venueId: string
  verdict: Verdict
  headline: string
  signals: {
    inquiryVolumeDelta: number | null
    regionalSearchDelta: number | null
    econTrend: 'up' | 'flat' | 'down' | null
    availabilityFillDelta: number | null
  }
  explanation: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verdictPalette(verdict: Verdict): {
  chipBg: string
  chipText: string
  headline: string
  border: string
} {
  switch (verdict) {
    case 'market':
      return {
        chipBg: 'bg-amber-50',
        chipText: 'text-amber-800',
        headline: 'text-amber-900',
        border: 'border-amber-200',
      }
    case 'venue':
      return {
        chipBg: 'bg-rose-50',
        chipText: 'text-rose-800',
        headline: 'text-rose-900',
        border: 'border-rose-200',
      }
    case 'mixed':
      return {
        chipBg: 'bg-sage-50',
        chipText: 'text-sage-800',
        headline: 'text-sage-900',
        border: 'border-sage-200',
      }
    default:
      return {
        chipBg: 'bg-gray-50',
        chipText: 'text-gray-600',
        headline: 'text-gray-600',
        border: 'border-gray-200',
      }
  }
}

function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case 'market': return 'Market'
    case 'venue': return 'Venue'
    case 'mixed': return 'Mixed'
    default: return 'Collecting data'
  }
}

function formatDelta(n: number | null): string {
  if (n == null) return 'no data'
  const sign = n > 0 ? '+' : ''
  return `${sign}${Math.round(n)}%`
}

function deltaIcon(n: number | null) {
  if (n == null) return Minus
  if (n > 1) return TrendingUp
  if (n < -1) return TrendingDown
  return Minus
}

function econLabel(trend: 'up' | 'flat' | 'down' | null): string {
  if (trend == null) return 'no data'
  if (trend === 'up') return 'trending up'
  if (trend === 'down') return 'trending down'
  return 'holding flat'
}

function econIcon(trend: 'up' | 'flat' | 'down' | null) {
  if (trend === 'up') return TrendingUp
  if (trend === 'down') return TrendingDown
  return Minus
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MeOrMarketCard() {
  const [data, setData] = useState<Diagnosis | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function fetchDiagnosis() {
      try {
        const res = await fetch('/api/intel/me-or-market')
        if (!res.ok) {
          if (!cancelled) setError(true)
          return
        }
        const json = await res.json()
        if (!cancelled) setData(json.diagnosis ?? null)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchDiagnosis()
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return null

  const palette = data ? verdictPalette(data.verdict) : verdictPalette('insufficient_data')
  const isInsufficient = !data || data.verdict === 'insufficient_data'

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-sage-50/30">
        <div className="flex items-center gap-2">
          <Compass className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Is it me or the market?
          </h2>
          {data && !isInsufficient && (
            <span
              className={`ml-auto text-[11px] font-semibold px-2 py-0.5 rounded-full ${palette.chipBg} ${palette.chipText}`}
            >
              {verdictLabel(data.verdict)}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="p-6 space-y-3">
          <div className="h-6 bg-sage-100 rounded animate-pulse w-3/4" />
          <div className="h-4 bg-sage-50 rounded animate-pulse w-full" />
          <div className="h-4 bg-sage-50 rounded animate-pulse w-5/6" />
        </div>
      ) : (
        <div className="p-6 space-y-5">
          {/* Verdict headline */}
          <div>
            <p className={`font-heading text-xl font-semibold leading-snug ${palette.headline}`}>
              {data?.headline ?? 'Not enough data yet to diagnose.'}
            </p>
            {data && !isInsufficient && data.explanation && (
              <p className="text-sm text-sage-700 mt-2 leading-relaxed">
                {data.explanation}
              </p>
            )}
          </div>

          {/* Empty state copy */}
          {isInsufficient && (
            <p className="text-sm text-muted leading-relaxed">
              We&apos;ll surface a diagnosis once your venue has 30 days of
              inquiry data plus regional trends.
            </p>
          )}

          {/* Signal chips */}
          {data && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <SignalChip
                icon={deltaIcon(data.signals.inquiryVolumeDelta)}
                label="Inquiry volume"
                value={formatDelta(data.signals.inquiryVolumeDelta)}
                sub="30d vs prior 30d"
              />
              <SignalChip
                icon={Search}
                label="Regional search"
                value={formatDelta(data.signals.regionalSearchDelta)}
                sub="4w vs prior 4w"
              />
              <SignalChip
                icon={econIcon(data.signals.econTrend)}
                label="Consumer sentiment"
                value={econLabel(data.signals.econTrend)}
                sub="latest FRED reading"
              />
              <SignalChip
                icon={CalendarCheck}
                label="Availability fill"
                value={formatDelta(data.signals.availabilityFillDelta)}
                sub="next 90d vs last year"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-component: signal chip
// ---------------------------------------------------------------------------

function SignalChip({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Gauge
  label: string
  value: string
  sub: string
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 border border-border rounded-lg bg-surface">
      <div className="bg-sage-50 p-1.5 rounded-lg shrink-0">
        <Icon className="w-3.5 h-3.5 text-sage-500" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted truncate">{label}</p>
        <p className="text-sm font-semibold text-sage-900">{value}</p>
        <p className="text-[10px] text-muted">{sub}</p>
      </div>
    </div>
  )
}
