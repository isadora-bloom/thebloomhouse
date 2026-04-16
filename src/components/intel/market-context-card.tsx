'use client'

import { useEffect, useState } from 'react'
import { Globe, TrendingUp, Clock, BarChart3, MapPin, Users, DollarSign, CalendarDays, AlertTriangle, Compass } from 'lucide-react'
import { getEventsInRange, getSeasonalAdvisory, type CalendarEvent } from '@/lib/services/calendar-ingest'

// ---------------------------------------------------------------------------
// Types matching the API response
// ---------------------------------------------------------------------------

interface MarketData {
  regionKey: string
  regionType: string
  regionName: string
  marriagesPerYear: number | null
  venueCountEstimate: number | null
  avgWeddingCost: number | null
  avgVenuePrice: number | null
  nearbyVenueDensity: string | null
  pricePosition: string | null
}

interface BenchmarkComparison {
  benchmarkKey: string
  label: string
  venueValue: number | null
  industryMedian: number | null
  percentileEstimate: number | null
  unit: string | null
  verdict: 'excellent' | 'good' | 'average' | 'below_average' | 'no_data'
}

interface MarketContextResponse {
  market: MarketData | null
  comparisons: BenchmarkComparison[]
  venueTier: string
  seasonalIndex: number | null
  seasonalLabel: string | null
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`
  return n.toLocaleString()
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)} hrs`
  return `${(minutes / 1440).toFixed(1)} days`
}

function formatBenchmarkValue(value: number, unit: string | null): string {
  if (!unit) return String(Math.round(value))
  switch (unit) {
    case 'minutes': return formatMinutes(value)
    case 'percent': return `${(value * 100).toFixed(0)}%`
    case 'dollars': return `$${formatNumber(value)}`
    case 'days': return `${Math.round(value)} days`
    case 'count': return String(Math.round(value * 10) / 10)
    default: return String(Math.round(value))
  }
}

function verdictColor(verdict: string): string {
  switch (verdict) {
    case 'excellent': return 'text-emerald-600'
    case 'good': return 'text-sage-600'
    case 'average': return 'text-amber-600'
    case 'below_average': return 'text-red-600'
    default: return 'text-muted'
  }
}

function verdictBg(verdict: string): string {
  switch (verdict) {
    case 'excellent': return 'bg-emerald-50'
    case 'good': return 'bg-sage-50'
    case 'average': return 'bg-amber-50'
    case 'below_average': return 'bg-red-50'
    default: return 'bg-gray-50'
  }
}

function verdictLabel(verdict: string): string {
  switch (verdict) {
    case 'excellent': return 'Excellent'
    case 'good': return 'Good'
    case 'average': return 'Average'
    case 'below_average': return 'Needs attention'
    default: return ''
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MarketContextCard() {
  const [data, setData] = useState<MarketContextResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    async function fetchMarketContext() {
      try {
        const res = await fetch('/api/intel/market-context')
        if (!res.ok) {
          setError(true)
          return
        }
        const json = await res.json()
        setData(json)
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    }
    fetchMarketContext()
  }, [])

  // Don't render if we have no data and aren't loading
  if (error || (!loading && !data?.market)) return null

  const market = data?.market
  const comparisons = data?.comparisons ?? []
  const seasonalLabel = data?.seasonalLabel
  const hasComparisons = comparisons.some((c) => c.verdict !== 'no_data')

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-sage-50/30">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Market Intelligence
          </h2>
          {market && (
            <span className="ml-auto text-xs text-muted">
              {market.regionName} &middot; {(data as MarketContextResponse).venueTier !== 'all' ? `${(data as MarketContextResponse).venueTier} tier` : ''} &middot; {market.regionType} data
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="p-6 space-y-3">
          <div className="h-5 bg-sage-100 rounded animate-pulse w-3/4" />
          <div className="h-5 bg-sage-100 rounded animate-pulse w-1/2" />
          <div className="h-5 bg-sage-100 rounded animate-pulse w-2/3" />
        </div>
      ) : (
        <div className="p-6 space-y-5">
          {/* Market overview row */}
          {market && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <MarketStat
                icon={MapPin}
                label="Venues in market"
                value={market.venueCountEstimate ? formatNumber(market.venueCountEstimate) : '--'}
                sub={market.nearbyVenueDensity ? `${market.nearbyVenueDensity} density` : undefined}
              />
              <MarketStat
                icon={Users}
                label="Weddings / year"
                value={market.marriagesPerYear ? formatNumber(market.marriagesPerYear) : '--'}
              />
              <MarketStat
                icon={DollarSign}
                label="Avg wedding cost"
                value={market.avgWeddingCost ? `$${formatNumber(market.avgWeddingCost)}` : '--'}
              />
              <MarketStat
                icon={TrendingUp}
                label="Avg venue price"
                value={market.avgVenuePrice ? `$${formatNumber(market.avgVenuePrice)}` : '--'}
                sub={market.pricePosition ?? undefined}
              />
            </div>
          )}

          {/* Seasonal context */}
          {seasonalLabel && (
            <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg">
              <BarChart3 className="w-4 h-4 text-blue-500 shrink-0" />
              <p className="text-sm text-blue-800">
                This month&apos;s inquiry volume is <span className="font-semibold">{seasonalLabel}</span> for your region
              </p>
            </div>
          )}

          {/* Benchmark comparisons (only if venue has operational data) */}
          {hasComparisons && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
                Your Performance vs Industry
              </h3>
              <div className="grid gap-2">
                {comparisons.filter((c) => c.verdict !== 'no_data').map((c) => (
                  <div
                    key={c.benchmarkKey}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${verdictBg(c.verdict)}`}
                  >
                    <Clock className="w-4 h-4 text-sage-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-sage-800">
                        <span className="font-medium">{c.label}:</span>{' '}
                        {c.venueValue !== null
                          ? formatBenchmarkValue(c.venueValue, c.unit)
                          : '--'}
                        {c.percentileEstimate !== null && (
                          <span className="text-muted">
                            {' '}(better than {c.percentileEstimate}% of {(data as MarketContextResponse).venueTier !== 'all' ? `${(data as MarketContextResponse).venueTier}` : ''} venues)
                          </span>
                        )}
                      </p>
                    </div>
                    <span className={`text-xs font-semibold shrink-0 ${verdictColor(c.verdict)}`}>
                      {verdictLabel(c.verdict)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Upcoming date conflicts */}
          <DateConflicts />

          {/* Seasonal advisory */}
          <SeasonalAdvisorySection />

          {/* If no operational data yet, show the "immediate value" message */}
          {!hasComparisons && market && (
            <div className="flex items-start gap-2 px-3 py-2 bg-sage-50 border border-sage-100 rounded-lg">
              <TrendingUp className="w-4 h-4 text-sage-500 mt-0.5 shrink-0" />
              <p className="text-sm text-sage-700">
                As you process inquiries and book weddings, we&apos;ll benchmark your performance against{' '}
                {market.venueCountEstimate ? `${formatNumber(market.venueCountEstimate)} venues` : 'the industry'}{' '}
                in {market.regionName}.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-component: single market stat
// ---------------------------------------------------------------------------

function MarketStat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof MapPin
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="bg-sage-50 p-1.5 rounded-lg shrink-0">
        <Icon className="w-3.5 h-3.5 text-sage-500" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted truncate">{label}</p>
        <p className="text-base font-bold text-sage-900">{value}</p>
        {sub && <p className="text-[10px] text-muted capitalize">{sub}</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-component: Upcoming Date Conflicts
// ---------------------------------------------------------------------------

function impactBadge(impact: string): { bg: string; text: string; label: string } {
  switch (impact) {
    case 'high': return { bg: 'bg-red-50', text: 'text-red-700', label: 'High impact' }
    case 'medium': return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Medium' }
    default: return { bg: 'bg-gray-50', text: 'text-gray-600', label: 'Low' }
  }
}

function DateConflicts() {
  const [events, setEvents] = useState<CalendarEvent[]>([])

  useEffect(() => {
    // Compute on client to avoid hydration issues with dates
    const now = new Date()
    const start = now.toISOString().split('T')[0]
    const sixtyDays = new Date()
    sixtyDays.setDate(now.getDate() + 60)
    const end = sixtyDays.toISOString().split('T')[0]

    const upcoming = getEventsInRange(start, end, { minImpact: 'medium' })
    setEvents(upcoming.slice(0, 5)) // Show at most 5
  }, [])

  if (events.length === 0) return null

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
        <CalendarDays className="w-3.5 h-3.5" />
        Upcoming Date Conflicts
      </h3>
      <div className="grid gap-1.5">
        {events.map((event) => {
          const badge = impactBadge(event.impact)
          const eventDate = new Date(event.date + 'T12:00:00')
          const formatted = eventDate.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            weekday: 'short',
          })

          return (
            <div
              key={`${event.date}-${event.name}`}
              className={`flex items-start gap-2.5 px-3 py-2 rounded-lg ${badge.bg}`}
            >
              <AlertTriangle className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${badge.text}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className={`text-sm font-medium ${badge.text}`}>{event.name}</p>
                  <span className="text-[10px] text-muted">{formatted}</span>
                </div>
                <p className="text-xs text-muted mt-0.5 line-clamp-2">
                  {event.impact_notes}
                </p>
              </div>
              <span className={`text-[10px] font-semibold shrink-0 mt-0.5 ${badge.text}`}>
                {badge.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-component: Seasonal Advisory
// ---------------------------------------------------------------------------

function trendIcon(trend: string): string {
  switch (trend) {
    case 'peak': return 'Peak'
    case 'rising': return 'Rising'
    case 'declining': return 'Declining'
    case 'low': return 'Low'
    default: return ''
  }
}

function trendColor(trend: string): string {
  switch (trend) {
    case 'peak': return 'text-emerald-600'
    case 'rising': return 'text-blue-600'
    case 'declining': return 'text-amber-600'
    case 'low': return 'text-red-600'
    default: return 'text-muted'
  }
}

function SeasonalAdvisorySection() {
  const [advisory, setAdvisory] = useState<ReturnType<typeof getSeasonalAdvisory> | null>(null)

  useEffect(() => {
    setAdvisory(getSeasonalAdvisory())
  }, [])

  if (!advisory) return null

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
        <Compass className="w-3.5 h-3.5" />
        Seasonal Advisory
      </h3>
      <div className="px-3 py-3 bg-sage-50/50 border border-sage-100 rounded-lg space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-sage-900">{advisory.label}</p>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted">
              Inquiries: <span className={`font-semibold ${trendColor(advisory.inquiry_trend)}`}>{trendIcon(advisory.inquiry_trend)}</span>
            </span>
            <span className="text-muted">
              Bookings: <span className={`font-semibold ${trendColor(advisory.booking_trend)}`}>{trendIcon(advisory.booking_trend)}</span>
            </span>
          </div>
        </div>
        <p className="text-xs text-sage-700 leading-relaxed">{advisory.description}</p>
      </div>
    </div>
  )
}
