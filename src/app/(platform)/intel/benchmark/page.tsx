'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  BarChart3,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  Building2,
  Trophy,
  AlertTriangle,
  Activity,
  CalendarCheck,
  ArrowRightLeft,
} from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'
import { UpgradeGate } from '@/components/ui/upgrade-gate'

// ---------------------------------------------------------------------------
// Phase 4 Task 45 — Multi-venue Benchmark
//
// The KPI showcase the checklist calls "the feature that justifies Bloom
// for any multi-property operator". One row per venue in scope (group or
// company), sortable on every KPI, with a rollup header summarising the
// best/weakest performers and portfolio averages.
//
// At venue scope the page renders a polite nudge to switch scope. White-
// label compliance: every venue label comes from the API response (which
// reads the DB), never from a hardcoded fallback.
// ---------------------------------------------------------------------------

interface BenchmarkVenue {
  venueId: string
  venueName: string
  overallScore: number | null
  bookingRate: number | null
  avgRevenue: number | null
  responseTimeMinutes: number | null
  availabilityFillRate: number | null
  tourConversionRate: number | null
}

interface BenchmarkResponse {
  venues: BenchmarkVenue[]
  rollup: {
    avgHealth: number | null
    bestVenueId: string | null
    weakestVenueId: string | null
    totalBookings: number
  }
}

type SortKey =
  | 'venueName'
  | 'overallScore'
  | 'bookingRate'
  | 'avgRevenue'
  | 'responseTimeMinutes'
  | 'availabilityFillRate'
  | 'tourConversionRate'
type SortDir = 'asc' | 'desc'

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtPct(v: number | null): string {
  if (v == null) return '--'
  return `${(v * 100).toFixed(1)}%`
}

function fmt$(v: number | null): string {
  if (v == null) return '--'
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  return `$${Math.round(v).toLocaleString()}`
}

function fmtResponse(mins: number | null): string {
  if (mins == null) return '--'
  if (mins < 60) return `${Math.round(mins)}m`
  return `${(mins / 60).toFixed(1)}h`
}

function fmtScore(score: number | null): string {
  if (score == null) return '--'
  return String(Math.round(score))
}

function healthColor(score: number): string {
  if (score > 70) return 'text-emerald-600'
  if (score > 40) return 'text-amber-600'
  return 'text-red-600'
}

function healthBg(score: number): string {
  if (score > 70) return 'bg-emerald-50 border-emerald-200'
  if (score > 40) return 'bg-amber-50 border-amber-200'
  return 'bg-red-50 border-red-200'
}

// ---------------------------------------------------------------------------
// Scope cookie helper (matches scope-selector.tsx)
// ---------------------------------------------------------------------------

function switchToVenueScope(venueId: string, venueName: string, companyName?: string) {
  const scope = {
    level: 'venue' as const,
    venueId,
    venueName,
    companyName,
  }
  document.cookie = `bloom_scope=${encodeURIComponent(JSON.stringify(scope))}; path=/; max-age=${60 * 60 * 24 * 365}`
  document.cookie = `bloom_venue=${venueId}; path=/; max-age=${60 * 60 * 24 * 365}`
}

// ---------------------------------------------------------------------------
// Wrapper + Gate
// ---------------------------------------------------------------------------

export default function BenchmarkPageWrapper() {
  return (
    <UpgradeGate requiredTier="intelligence" featureName="Venue Benchmark">
      <BenchmarkInner />
    </UpgradeGate>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function BenchmarkInner() {
  const router = useRouter()
  const scope = useScope()

  const [data, setData] = useState<BenchmarkResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('overallScore')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const isCrossVenueScope = scope.level === 'group' || scope.level === 'company'

  const fetchData = useCallback(async () => {
    if (scope.loading) return
    if (!isCrossVenueScope) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ scope: scope.level })
      if (scope.level === 'group' && scope.groupId) {
        qs.set('groupId', scope.groupId)
      }
      const res = await fetch(`/api/intel/benchmark?${qs.toString()}`, {
        credentials: 'include',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message || body?.error || 'Failed to load benchmark')
      }
      const json = (await res.json()) as BenchmarkResponse
      setData(json)
    } catch (err) {
      console.error('Benchmark fetch failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to load benchmark')
    } finally {
      setLoading(false)
    }
  }, [scope.loading, scope.level, scope.groupId, isCrossVenueScope])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ----- Venue-scope empty state ------------------------------------------
  if (!scope.loading && !isCrossVenueScope) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Venue Benchmark
          </h1>
          <p className="text-sage-600">
            Compare every venue in your portfolio side by side across health, booking rate, revenue, and response time.
          </p>
        </div>

        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <div className="w-14 h-14 rounded-full bg-sage-50 flex items-center justify-center mx-auto mb-4">
            <ArrowRightLeft className="w-7 h-7 text-sage-400" />
          </div>
          <h2 className="font-heading text-xl font-semibold text-sage-900 mb-2">
            Switch to a group or company scope to see cross-venue benchmarks
          </h2>
          <p className="text-sm text-sage-600 max-w-md mx-auto mb-5">
            Benchmarking compares venues against each other. Pick a group or your full portfolio from the scope selector to line them up.
          </p>
          <p className="text-xs text-sage-400">
            Use the scope selector in the top-left sidebar to change scope.
          </p>
        </div>
      </div>
    )
  }

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortedVenues = useMemo(() => {
    const venues = data?.venues ?? []
    return [...venues].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      // Null sinks to the bottom regardless of direction — blank rows
      // should never headline a sorted list.
      const aNull = av == null
      const bNull = bv == null
      if (aNull && bNull) return 0
      if (aNull) return 1
      if (bNull) return -1
      const an = av as number
      const bn = bv as number
      return sortDir === 'asc' ? an - bn : bn - an
    })
  }, [data, sortKey, sortDir])

  const rollup = data?.rollup
  const bestVenue = data?.venues.find((v) => v.venueId === rollup?.bestVenueId)
  const weakestVenue = data?.venues.find((v) => v.venueId === rollup?.weakestVenueId)

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="w-3 h-3 text-sage-400" />
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3 h-3 text-sage-700" />
    ) : (
      <ChevronDown className="w-3 h-3 text-sage-700" />
    )
  }

  const scopeLabel = scope.level === 'group'
    ? scope.groupName || 'this group'
    : scope.companyName || 'your portfolio'

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
          <BarChart3 className="w-7 h-7 text-sage-500" />
          Venue Benchmark
        </h1>
        <p className="text-sage-600">
          Every venue in {scopeLabel}, lined up on the KPIs that matter. Sort any column to surface leaders and laggards.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700 flex-1">{error}</p>
          <button
            onClick={() => fetchData()}
            className="text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Rollup cards */}
      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <div className="animate-pulse space-y-3">
                <div className="h-4 w-24 bg-sage-100 rounded" />
                <div className="h-8 w-20 bg-sage-100 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : rollup ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <RollupCard
            icon={Activity}
            label="Average Health"
            value={fmtScore(rollup.avgHealth)}
            accent={rollup.avgHealth != null ? healthColor(rollup.avgHealth) : 'text-sage-400'}
            subtitle={`${data?.venues.length ?? 0} venues`}
          />
          <RollupCard
            icon={Trophy}
            label="Best Performer"
            value={bestVenue?.venueName || '--'}
            accent="text-emerald-600"
            subtitle={
              bestVenue?.overallScore != null
                ? `Health score ${Math.round(bestVenue.overallScore)}`
                : 'No scored venues'
            }
          />
          <RollupCard
            icon={AlertTriangle}
            label="Needs Attention"
            value={weakestVenue?.venueName || '--'}
            accent="text-amber-600"
            subtitle={
              weakestVenue?.overallScore != null
                ? `Health score ${Math.round(weakestVenue.overallScore)}`
                : 'No scored venues'
            }
          />
          <RollupCard
            icon={CalendarCheck}
            label="Total Bookings"
            value={String(rollup.totalBookings)}
            accent="text-gold-600"
            subtitle="Last 90 days"
          />
        </div>
      ) : null}

      {/* Table */}
      {loading ? (
        <div className="bg-surface border border-border rounded-xl p-8 shadow-sm">
          <div className="animate-pulse space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 bg-sage-50 rounded" />
            ))}
          </div>
        </div>
      ) : sortedVenues.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Building2 className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No venues to benchmark
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {scope.level === 'group'
              ? 'This group has no venues yet. Add venues to the group in Settings to compare them here.'
              : 'Venues will appear here once onboarded.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Venue Comparison
            </h2>
            <p className="text-xs text-sage-500">
              Click any venue name to switch scope. Click a header to sort.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-warm-white">
                  {(
                    [
                      ['venueName', 'Venue'],
                      ['overallScore', 'Health'],
                      ['bookingRate', 'Booking Rate'],
                      ['avgRevenue', 'Avg Revenue'],
                      ['responseTimeMinutes', 'Response Time'],
                      ['availabilityFillRate', 'Fill Rate'],
                      ['tourConversionRate', 'Tour Conv.'],
                    ] as [SortKey, string][]
                  ).map(([key, label]) => (
                    <th
                      key={key}
                      onClick={() => handleSort(key)}
                      className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600 cursor-pointer select-none hover:text-sage-900 transition-colors"
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        <SortIcon col={key} />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedVenues.map((v) => (
                  <tr key={v.venueId} className="hover:bg-sage-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <button
                        onClick={() => {
                          switchToVenueScope(v.venueId, v.venueName, scope.companyName)
                          router.push('/intel/dashboard')
                          window.location.reload()
                        }}
                        className="font-medium text-sage-900 hover:text-sage-700 hover:underline transition-colors text-left"
                      >
                        {v.venueName}
                      </button>
                    </td>
                    <td className="px-6 py-4">
                      <HealthChip score={v.overallScore} />
                    </td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">
                      {fmtPct(v.bookingRate)}
                    </td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">
                      {fmt$(v.avgRevenue)}
                    </td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">
                      {fmtResponse(v.responseTimeMinutes)}
                    </td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">
                      {fmtPct(v.availabilityFillRate)}
                    </td>
                    <td className="px-6 py-4 text-sage-700 tabular-nums">
                      {fmtPct(v.tourConversionRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rollup card
// ---------------------------------------------------------------------------

function RollupCard({
  icon: Icon,
  label,
  value,
  accent,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  accent: string
  subtitle?: string
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <div className="p-2 rounded-lg bg-sage-50">
          <Icon className={`w-4 h-4 ${accent}`} />
        </div>
        <span className="text-xs font-medium text-sage-500 uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className={`text-xl font-bold ${accent} tabular-nums truncate`} title={value}>
        {value}
      </p>
      {subtitle && (
        <p className="text-xs text-sage-400 mt-1">{subtitle}</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Health chip
// ---------------------------------------------------------------------------

function HealthChip({ score }: { score: number | null }) {
  if (score == null) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-sage-50 text-sage-500 border-sage-200">
        No data
      </span>
    )
  }
  const rounded = Math.round(score)
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border tabular-nums ${healthBg(rounded)} ${healthColor(rounded)}`}
    >
      {rounded}
    </span>
  )
}
