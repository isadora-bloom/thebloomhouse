'use client'

import { useState, useEffect, useCallback } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createBrowserClient } from '@supabase/ssr'
import {
  BarChart3,
  DollarSign,
  TrendingUp,
  ArrowUpDown,
  Megaphone,
  Award,
} from 'lucide-react'
import { InsightPanel, type InsightItem } from '@/components/intel/insight-panel'
import { InlineInsightBanner } from '@/components/intel/inline-insight-banner'
import { VenueChip } from '@/components/intel/venue-chip'
import { SpendImporter } from '@/components/intel/spend-importer'
import Link from 'next/link'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AttributionModel = 'first_touch' | 'last_touch' | 'linear'

interface FunnelApiRow {
  source: string | null
  inquiries: number
  tours_booked: number
  tours_conducted: number
  proposals_sent: number
  bookings: number
  revenue: number
  inquiry_to_tour_rate: number
  tour_to_booking_rate: number
  inquiry_to_booking_rate: number
  venueId: string
  venueName: string
}

interface MarketingSpend {
  id: string
  venue_id: string
  source: string
  month: string
  amount: number
  venues?: { name: string | null } | null
}

interface SourceRow {
  source_key: string
  source_name: string
  venue_id: string | null
  venue_name: string | null
  spend: number
  inquiries: number
  tours_booked: number
  tours_conducted: number
  proposals_sent: number
  bookings: number
  revenue: number
  cost_per_inquiry: number
  cost_per_tour: number
  cost_per_booking: number
  conversion_rate: number
  roi: number
}

type SortKey = keyof SourceRow
type SortDir = 'asc' | 'desc'

// ---------------------------------------------------------------------------
// Source label mapping — turn raw enum values into human-readable names
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  the_knot: 'The Knot',
  instagram: 'Instagram',
  weddingwire: 'Wedding Wire',
  wedding_wire: 'Wedding Wire',
  google: 'Google',
  referral: 'Word of Mouth',
  direct: 'Direct',
  website: 'Website',
  walk_in: 'Walk-in',
  facebook: 'Facebook',
  zola: 'Zola',
  phone: 'Phone',
  calendly: 'Calendly',
  acuity: 'Acuity',
  honeybook: 'HoneyBook',
  here_comes_the_guide: 'Here Comes The Guide',
  venue_calculator: 'Venue Calculator',
  other: 'Other',
}

function formatSource(source: string): string {
  const key = source.toLowerCase()
  return (
    SOURCE_LABELS[key] ??
    source.charAt(0).toUpperCase() + source.slice(1).replace(/_/g, ' ')
  )
}

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  return `$${Math.round(value).toLocaleString()}`
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/** Linear attribution can produce fractional counts; show 1dp when not
 *  a whole number, integer otherwise. */
function fmtCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

const SOURCE_COLORS: Record<string, string> = {
  'The Knot':             '#E8927C',
  'Wedding Wire':         '#7EAAA0',
  'Google':               '#A6894A',
  'Instagram':            '#C084A0',
  'Word of Mouth':        '#7D8471',
  'Direct':               '#5D7A7A',
  'Website':              '#8FA48D',
  'Walk-in':              '#B29A6A',
  'Facebook':             '#6A89B7',
  'Zola':                 '#9B8EC4',
  'Phone':                '#C99B7A',
  'Calendly':             '#5C8DBC',
  'Acuity':               '#7AA9B7',
  'HoneyBook':            '#D4A24C',
  'Here Comes The Guide': '#B287C2',
  'Venue Calculator':     '#9D8B6E',
  'Other':                '#9AA098',
}

function getSourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? '#7D8471'
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function ChartSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="h-5 w-40 bg-sage-100 rounded" />
        <div className="h-64 bg-sage-50 rounded-lg" />
      </div>
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-5 w-48 bg-sage-100 rounded" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 bg-sage-50 rounded" />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Source Quality Scorecard — Phase 4 Task 39
// ---------------------------------------------------------------------------

interface QualityApiRow {
  source: string
  bookedCount: number
  avgRevenue: number
  avgEmailsExchanged: number
  avgPortalActivity: number
  avgReviewScore: number | null
  referralCount: number
  frictionRate: number
  venueId: string
  venueName: string
}

type QualitySortKey =
  | 'source'
  | 'bookedCount'
  | 'avgRevenue'
  | 'avgEmailsExchanged'
  | 'avgPortalActivity'
  | 'avgReviewScore'
  | 'referralCount'
  | 'frictionRate'

interface ScorecardProps {
  scope: ReturnType<typeof useScope>
}

function SourceQualityScorecard({ scope }: ScorecardProps) {
  const [rows, setRows] = useState<QualityApiRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<QualitySortKey>('bookedCount')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  useEffect(() => {
    if (scope.loading) return
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const params = new URLSearchParams()
        if (scope.level === 'venue' && scope.venueId) {
          params.set('venue_id', scope.venueId)
        } else if (scope.level === 'group' && scope.groupId) {
          params.set('group_id', scope.groupId)
        } else if (scope.orgId) {
          params.set('org_id', scope.orgId)
        }
        const res = await fetch(`/api/intel/source-quality?${params.toString()}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as { rows?: QualityApiRow[] }
        if (cancelled) return
        setRows(json.rows ?? [])
        setError(null)
      } catch (err) {
        if (cancelled) return
        console.error('Failed to load source quality:', err)
        setError('Failed to load source quality')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [scope.level, scope.venueId, scope.groupId, scope.orgId, scope.loading])

  function handleSort(key: QualitySortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortedRows = [...rows].sort((a, b) => {
    const aVal = a[sortKey]
    const bVal = b[sortKey]
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
    }
    const aNum = typeof aVal === 'number' ? aVal : aVal === null ? -1 : 0
    const bNum = typeof bVal === 'number' ? bVal : bVal === null ? -1 : 0
    return sortDir === 'asc' ? aNum - bNum : bNum - aNum
  })

  if (loading) {
    return <TableSkeleton />
  }

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-border">
        <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
          <Award className="w-5 h-5 text-sage-600" />
          Source Quality
        </h2>
        <p className="text-xs text-sage-500 mt-1">
          Quality-of-lead signals per source, measured from weddings that
          actually booked. Higher review scores and lower friction rates
          mean better-fit couples.
        </p>
      </div>

      {error && (
        <div className="px-6 py-4 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-sage-50/50">
              {([
                ['source', 'Source'],
                ['bookedCount', 'Booked'],
                ['avgRevenue', 'Avg Revenue'],
                ['avgEmailsExchanged', 'Emails Exchanged'],
                ['avgPortalActivity', 'Portal Activity'],
                ['avgReviewScore', 'Review Score'],
                ['referralCount', 'Referrals'],
                ['frictionRate', 'Friction Rate'],
              ] as [QualitySortKey, string][]).map(([key, label]) => (
                <th
                  key={key}
                  className="px-4 py-3 text-left font-medium text-sage-600 cursor-pointer hover:text-sage-900 transition-colors select-none whitespace-nowrap"
                  onClick={() => handleSort(key)}
                >
                  <span className="inline-flex items-center gap-1">
                    {label}
                    {sortKey === key && (
                      <ArrowUpDown className="w-3 h-3 text-sage-400" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sortedRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-sage-500">
                  Not enough booked weddings yet to score source quality.
                  Need at least 2 bookings per source.
                </td>
              </tr>
            ) : (
              sortedRows.map((row, i) => (
                <tr
                  key={`${row.venueId}-${row.source}-${i}`}
                  className="hover:bg-sage-50/30 transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-sage-900 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: getSourceColor(formatSource(row.source)) }}
                      />
                      {formatSource(row.source)}
                      {scope.level !== 'venue' && (
                        <VenueChip venueName={row.venueName} />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sage-700 tabular-nums">
                    {row.bookedCount}
                  </td>
                  <td className="px-4 py-3 text-sage-700 tabular-nums font-medium">
                    {fmt$(row.avgRevenue)}
                  </td>
                  <td className="px-4 py-3 text-sage-700 tabular-nums">
                    {row.avgEmailsExchanged.toFixed(1)}
                  </td>
                  <td className="px-4 py-3 text-sage-700 tabular-nums">
                    {row.avgPortalActivity.toFixed(1)}
                  </td>
                  <td className="px-4 py-3 text-sage-700 tabular-nums">
                    {row.avgReviewScore !== null
                      ? row.avgReviewScore.toFixed(2)
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-sage-700 tabular-nums">
                    {row.referralCount}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    <span
                      className={`font-medium ${
                        row.frictionRate === 0
                          ? 'text-emerald-600'
                          : row.frictionRate < 0.25
                          ? 'text-sage-700'
                          : 'text-red-600'
                      }`}
                    >
                      {fmtPct(row.frictionRate)}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function SourceAttributionPage() {
  const scope = useScope()
  const [funnelRows, setFunnelRows] = useState<FunnelApiRow[]>([])
  const [spendData, setSpendData] = useState<MarketingSpend[]>([])
  const [model, setModel] = useState<AttributionModel>('first_touch')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('inquiries')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // ---- Fetch data ----
  // Funnel rows come from the multi-touch attribution endpoint (reads
  // wedding_touchpoints + applies the chosen model). Spend overlay
  // still comes from marketing_spend directly so we can layer
  // cost-per-X math on top without giving the API spend visibility.
  const fetchData = useCallback(async () => {
    if (scope.loading) return
    const supabase = getSupabase()

    try {
      // ---- Resolve scope params for the funnel API ----
      const apiParams = new URLSearchParams()
      apiParams.set('model', model)
      if (scope.level === 'venue' && scope.venueId) {
        apiParams.set('venue_id', scope.venueId)
      } else if (scope.level === 'group' && scope.groupId) {
        apiParams.set('group_id', scope.groupId)
      } else if (scope.orgId) {
        apiParams.set('org_id', scope.orgId)
      }

      // ---- Resolve venue IDs for the spend query (still browser-side)
      let venueIds: string[] | null = null
      if (scope.level === 'venue' && scope.venueId) {
        venueIds = [scope.venueId]
      } else if (scope.level === 'group' && scope.groupId) {
        const { data: members } = await supabase
          .from('venue_group_members')
          .select('venue_id')
          .eq('group_id', scope.groupId)
        venueIds = (members ?? []).map((m) => m.venue_id as string)
      } else if (scope.orgId) {
        const { data: orgVenues } = await supabase
          .from('venues')
          .select('id')
          .eq('org_id', scope.orgId)
        venueIds = (orgVenues ?? []).map((v) => v.id as string)
      }

      const spendQuery = supabase
        .from('marketing_spend')
        .select('*, venues:venue_id(name)')
        .order('month', { ascending: true })
      if (venueIds && venueIds.length > 0) {
        spendQuery.in('venue_id', venueIds)
      }

      const [funnelRes, spendRes] = await Promise.all([
        fetch(`/api/intel/sources/funnel?${apiParams.toString()}`),
        spendQuery,
      ])

      if (!funnelRes.ok) throw new Error(`Funnel HTTP ${funnelRes.status}`)
      const funnelJson = (await funnelRes.json()) as { rows?: FunnelApiRow[] }
      if (spendRes.error) throw spendRes.error

      setFunnelRows(funnelJson.rows ?? [])
      setSpendData((spendRes.data ?? []) as unknown as MarketingSpend[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch source attribution data:', err)
      setError('Failed to load source attribution data')
    } finally {
      setLoading(false)
    }
  }, [scope.level, scope.venueId, scope.groupId, scope.orgId, scope.loading, model])

  useEffect(() => {
    setLoading(true)
    fetchData()
  }, [fetchData])

  // ---- Build aggregated source rows ----
  // At venue scope: aggregate by source. At company/group scope:
  // aggregate by source × venue so each row shows which venue the
  // attribution is from. Funnel counts come from the API; spend is
  // overlayed from marketing_spend. Cost-per-X is derived here.
  const sourceRows: SourceRow[] = (() => {
    const showByVenue = scope.level !== 'venue'

    interface Agg {
      inquiries: number
      tours_booked: number
      tours_conducted: number
      proposals_sent: number
      bookings: number
      revenue: number
      spend: number
      venue_id: string | null
      venue_name: string | null
      source_key: string
    }

    const sourceMap = new Map<string, Agg>()

    const makeKey = (sourceKey: string, venueId: string | null) =>
      showByVenue ? `${sourceKey}|${venueId ?? 'unknown'}` : sourceKey

    const ensure = (
      sourceKey: string,
      venueId: string | null,
      venueName: string | null
    ): Agg => {
      const key = makeKey(sourceKey, venueId)
      const existing = sourceMap.get(key)
      if (existing) return existing
      const fresh: Agg = {
        inquiries: 0,
        tours_booked: 0,
        tours_conducted: 0,
        proposals_sent: 0,
        bookings: 0,
        revenue: 0,
        spend: 0,
        venue_id: showByVenue ? venueId : null,
        venue_name: showByVenue ? venueName : null,
        source_key: sourceKey,
      }
      sourceMap.set(key, fresh)
      return fresh
    }

    // 1) Funnel counts from the attribution endpoint
    for (const r of funnelRows) {
      const sourceKey = (r.source ?? 'unknown').toLowerCase()
      const row = ensure(sourceKey, r.venueId ?? null, r.venueName ?? null)
      row.inquiries += Number(r.inquiries ?? 0)
      row.tours_booked += Number(r.tours_booked ?? 0)
      row.tours_conducted += Number(r.tours_conducted ?? 0)
      row.proposals_sent += Number(r.proposals_sent ?? 0)
      row.bookings += Number(r.bookings ?? 0)
      row.revenue += Number(r.revenue ?? 0)
    }

    // 2) Layer spend from marketing_spend (amount column)
    for (const s of spendData) {
      const sourceKey = (s.source || 'unknown').toLowerCase()
      const row = ensure(sourceKey, s.venue_id ?? null, s.venues?.name ?? null)
      row.spend += Number(s.amount ?? 0)
    }

    const rows: SourceRow[] = []
    for (const [rowKey, data] of sourceMap) {
      rows.push({
        source_key: rowKey,
        source_name: formatSource(data.source_key),
        venue_id: data.venue_id,
        venue_name: data.venue_name,
        spend: data.spend,
        inquiries: data.inquiries,
        tours_booked: data.tours_booked,
        tours_conducted: data.tours_conducted,
        proposals_sent: data.proposals_sent,
        bookings: data.bookings,
        revenue: data.revenue,
        cost_per_inquiry: data.inquiries > 0 ? data.spend / data.inquiries : 0,
        cost_per_tour: data.tours_booked > 0 ? data.spend / data.tours_booked : 0,
        cost_per_booking: data.bookings > 0 ? data.spend / data.bookings : 0,
        conversion_rate: data.inquiries > 0 ? data.bookings / data.inquiries : 0,
        roi: data.spend > 0 ? (data.revenue - data.spend) / data.spend : 0,
      })
    }

    return rows
  })()

  // ---- Sort ----
  const sortedRows = [...sourceRows].sort((a, b) => {
    const aVal = a[sortKey]
    const bVal = b[sortKey]
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
    }
    const aNum = typeof aVal === 'number' ? aVal : 0
    const bNum = typeof bVal === 'number' ? bVal : 0
    return sortDir === 'asc' ? aNum - bNum : bNum - aNum
  })

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  // ---- Cost per booking chart data ----
  const costPerBookingData = sortedRows
    .filter((r) => r.bookings > 0)
    .sort((a, b) => a.cost_per_booking - b.cost_per_booking)
    .map((r) => ({
      source:
        scope.level !== 'venue' && r.venue_name
          ? `${r.source_name} · ${r.venue_name}`
          : r.source_name,
      costPerBooking: Math.round(r.cost_per_booking),
      fill: getSourceColor(r.source_name),
    }))

  // ---- Spend over time chart data ----
  const spendOverTimeData = (() => {
    const monthMap = new Map<string, Record<string, number>>()
    const allSources = new Set<string>()

    for (const s of spendData) {
      const label = formatSource(s.source || 'unknown')
      allSources.add(label)
      const existing = monthMap.get(s.month) ?? {}
      existing[label] = (existing[label] ?? 0) + Number(s.amount ?? 0)
      monthMap.set(s.month, existing)
    }

    const months = Array.from(monthMap.keys()).sort()
    return months.map((month) => {
      const row: Record<string, unknown> = {
        month: new Date(month).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      }
      for (const source of allSources) {
        row[source] = monthMap.get(month)?.[source] ?? 0
      }
      return row
    })
  })()

  const allSpendSources = Array.from(
    new Set(spendData.map((s) => formatSource(s.source || 'unknown')))
  )

  // ---- Summary stats ----
  const totalSpend = sourceRows.reduce((sum, r) => sum + r.spend, 0)
  const totalRevenue = sourceRows.reduce((sum, r) => sum + r.revenue, 0)
  const totalBookings = sourceRows.reduce((sum, r) => sum + r.bookings, 0)
  const overallCPB = totalBookings > 0 ? totalSpend / totalBookings : 0

  // ---- Compute insights from source data ----
  const sourceInsights: InsightItem[] = (() => {
    if (sourceRows.length === 0) return []
    const items: InsightItem[] = []

    // Best performing source (by revenue per inquiry)
    const withInquiries = sourceRows.filter((r) => r.inquiries > 0)
    if (withInquiries.length > 0) {
      const best = [...withInquiries].sort((a, b) => {
        const aRev = a.inquiries > 0 ? a.revenue / a.inquiries : 0
        const bRev = b.inquiries > 0 ? b.revenue / b.inquiries : 0
        return bRev - aRev
      })[0]
      const revPerLead = best.inquiries > 0 ? Math.round(best.revenue / best.inquiries) : 0
      items.push({
        icon: 'trend_up',
        text: `${best.source_name} is your best channel at $${revPerLead.toLocaleString()}/lead in revenue`,
        priority: 'high',
      })
    }

    // Worst ROI source (among those with spend)
    const withSpend = sourceRows.filter((r) => r.spend > 0)
    if (withSpend.length > 1) {
      const worst = [...withSpend].sort((a, b) => a.roi - b.roi)[0]
      items.push({
        icon: 'trend_down',
        text: `${worst.source_name} has the lowest ROI at ${worst.roi >= 0 ? '+' : ''}${(worst.roi * 100).toFixed(0)}% — consider reallocating spend`,
        priority: 'medium',
      })
    }

    // Sources with inquiries but zero bookings
    const zeroBookings = sourceRows.filter((r) => r.inquiries > 0 && r.bookings === 0)
    for (const src of zeroBookings) {
      items.push({
        icon: 'warning',
        text: `${src.source_name} generated ${src.inquiries} inquiries but no bookings — investigate conversion blockers`,
        priority: 'medium',
      })
    }

    return items
  })()

  return (
    <div className="space-y-8">
      {/* ---- Header ---- */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Source Attribution
        </h1>
        <p className="text-sage-600">
          Compare lead sources head-to-head — which channels bring the most inquiries, the highest quality leads, and the best conversion rates. Allocate your marketing budget based on real data.
        </p>
        {scope.level === 'company' && (
          <p className="text-xs text-sage-500 mt-2">
            Showing across all venues — {scope.companyName}
          </p>
        )}
        {scope.level === 'group' && (
          <p className="text-xs text-sage-500 mt-2">
            Showing across {scope.groupName}
          </p>
        )}
        {scope.level === 'venue' && (
          <p className="text-xs text-sage-500 mt-2">
            Showing for {scope.venueName}
          </p>
        )}
      </div>

      {/* ---- Attribution model selector + backtrace link ---- */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-sage-700">Attribution:</span>
          {([
            ['first_touch', 'First-touch', 'Credit the source that first introduced the couple.'],
            ['last_touch', 'Last-touch', 'Credit the source of the most recent touch before booking.'],
            ['linear', 'Linear', 'Split credit equally across every source the couple touched.'],
          ] as [AttributionModel, string, string][]).map(([key, label, hint]) => (
            <button
              key={key}
              onClick={() => setModel(key)}
              title={hint}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
                model === key
                  ? 'bg-sage-700 text-white border-sage-700'
                  : 'bg-surface text-sage-700 border-border hover:bg-sage-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Link
          href="/settings/sources"
          className="text-xs font-medium text-sage-600 hover:text-sage-900 underline-offset-2 hover:underline"
          title="Find the real first-touch source for couples whose first source is a scheduling tool."
        >
          Re-attribute scheduling-tool bookings →
        </Link>
      </div>

      {/* ---- Spend importer — Phase 3 Task 33 ---- */}
      <SpendImporter onImported={() => window.location.reload()} />


      {/* ---- Inline insight banner ---- */}
      <InlineInsightBanner category="source_attribution" />

      {/* ---- Error state ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Megaphone className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchData() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Summary Stats ---- */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <div className="animate-pulse space-y-3">
                <div className="h-4 w-24 bg-sage-100 rounded" />
                <div className="h-8 w-16 bg-sage-100 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-red-50 rounded-lg">
                <DollarSign className="w-4 h-4 text-red-500" />
              </div>
              <span className="text-sm font-medium text-sage-600">Total Spend</span>
            </div>
            <p className="text-3xl font-bold text-sage-900">{fmt$(totalSpend)}</p>
          </div>

          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-emerald-50 rounded-lg">
                <TrendingUp className="w-4 h-4 text-emerald-600" />
              </div>
              <span className="text-sm font-medium text-sage-600">Total Revenue</span>
            </div>
            <p className="text-3xl font-bold text-sage-900">{fmt$(totalRevenue)}</p>
          </div>

          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-teal-50 rounded-lg">
                <BarChart3 className="w-4 h-4 text-teal-600" />
              </div>
              <span className="text-sm font-medium text-sage-600">Total Bookings</span>
            </div>
            <p className="text-3xl font-bold text-sage-900">{totalBookings}</p>
          </div>

          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-gold-50 rounded-lg">
                <DollarSign className="w-4 h-4 text-gold-600" />
              </div>
              <span className="text-sm font-medium text-sage-600">Avg Cost / Booking</span>
            </div>
            <p className="text-3xl font-bold text-sage-900">{fmt$(overallCPB)}</p>
          </div>
        </div>
      )}

      {/* ---- AI Insights ---- */}
      {!loading && sourceInsights.length > 0 && (
        <InsightPanel insights={sourceInsights} />
      )}

      {/* ---- Source Quality Scorecard (Phase 4 Task 39) ---- */}
      <SourceQualityScorecard scope={scope} />

      {/* ---- Cost per Booking Chart ---- */}
      {loading ? (
        <ChartSkeleton />
      ) : costPerBookingData.length > 0 ? (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-sage-600" />
            Cost per Booking by Source
          </h2>
          <p className="text-xs text-sage-500 mb-4 mt-1">
            Showing:{' '}
            {scope.level === 'company'
              ? `all venues — ${scope.companyName}`
              : scope.level === 'group'
              ? scope.groupName
              : scope.venueName}
          </p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={costPerBookingData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" vertical={false} />
                <XAxis
                  dataKey="source"
                  tick={{ fontSize: 12, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    border: '1px solid #E8E4DF',
                    borderRadius: '8px',
                    fontSize: '13px',
                  }}
                  formatter={(value) => [`$${Number(value).toLocaleString()}`, 'Cost per Booking']}
                />
                <Bar
                  dataKey="costPerBooking"
                  radius={[6, 6, 0, 0]}
                  fill="#7D8471"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}

      {/* ---- Source Comparison Table ---- */}
      {loading ? (
        <TableSkeleton />
      ) : sortedRows.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Megaphone className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No source attribution data yet
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            Source attribution data will appear here once inquiries and marketing spend are tracked.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
              <ArrowUpDown className="w-5 h-5 text-sage-600" />
              Source Comparison
            </h2>
            <p className="text-xs text-sage-500 mt-1">
              Showing:{' '}
              {scope.level === 'company'
                ? `all venues — ${scope.companyName}`
                : scope.level === 'group'
                ? scope.groupName
                : scope.venueName}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-sage-50/50">
                  {([
                    ['source_name', 'Source'],
                    ['spend', 'Spend'],
                    ['inquiries', 'Inquiries'],
                    ['tours_booked', 'Tours Booked'],
                    ['tours_conducted', 'Tours Held'],
                    ['proposals_sent', 'Proposals'],
                    ['bookings', 'Bookings'],
                    ['revenue', 'Revenue'],
                    ['cost_per_inquiry', 'Cost / Lead'],
                    ['cost_per_tour', 'Cost / Tour'],
                    ['cost_per_booking', 'Cost / Booking'],
                    ['conversion_rate', 'Conv. Rate'],
                    ['roi', 'ROI'],
                  ] as [SortKey, string][]).map(([key, label]) => (
                    <th
                      key={key}
                      className="px-4 py-3 text-left font-medium text-sage-600 cursor-pointer hover:text-sage-900 transition-colors select-none whitespace-nowrap"
                      onClick={() => handleSort(key)}
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        {sortKey === key && (
                          <ArrowUpDown className="w-3 h-3 text-sage-400" />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedRows.map((row) => (
                  <tr key={row.source_key} className="hover:bg-sage-50/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-sage-900 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: getSourceColor(row.source_name) }}
                        />
                        {row.source_name}
                        {scope.level !== 'venue' && (
                          <VenueChip venueName={row.venue_name} />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmt$(row.spend)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmtCount(row.inquiries)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmtCount(row.tours_booked)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmtCount(row.tours_conducted)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmtCount(row.proposals_sent)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmtCount(row.bookings)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums font-medium">{fmt$(row.revenue)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmt$(row.cost_per_inquiry)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{row.tours_booked > 0 ? fmt$(row.spend / row.tours_booked) : '—'}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmt$(row.cost_per_booking)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmtPct(row.conversion_rate)}</td>
                    <td className="px-4 py-3 tabular-nums">
                      <span className={`font-semibold ${row.roi >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {row.roi > 0 ? '+' : ''}{fmtPct(row.roi)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Funnel by Source ---- */}
      {!loading && sortedRows.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-sage-600" />
            Funnel by Source
          </h2>
          <p className="text-xs text-sage-500 mb-4 mt-1">
            Inquiry → Tour Booked → Tour Held → Proposal → Booked, attributed by{' '}
            {model === 'first_touch' ? 'first-touch' : model === 'last_touch' ? 'last-touch' : 'linear'} model.
          </p>
          <div className="space-y-3">
            {sortedRows
              .filter((r) => r.inquiries > 0)
              .slice(0, 8)
              .map((row) => {
                const max = row.inquiries || 1
                const cells: Array<[string, number]> = [
                  ['Inquiries', row.inquiries],
                  ['Tours Booked', row.tours_booked],
                  ['Tours Held', row.tours_conducted],
                  ['Proposals', row.proposals_sent],
                  ['Booked', row.bookings],
                ]
                return (
                  <div key={row.source_key}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <div
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: getSourceColor(row.source_name) }}
                      />
                      <span className="text-sm font-medium text-sage-900">
                        {row.source_name}
                      </span>
                      {scope.level !== 'venue' && (
                        <VenueChip venueName={row.venue_name} />
                      )}
                      <span className="text-xs text-sage-500">
                        · {fmtPct(row.conversion_rate)} conversion
                      </span>
                    </div>
                    <div className="grid grid-cols-5 gap-1.5">
                      {cells.map(([label, value]) => {
                        const pct = (value / max) * 100
                        return (
                          <div key={label} className="relative">
                            <div className="h-8 bg-sage-50 rounded overflow-hidden">
                              <div
                                className="h-full rounded transition-all"
                                style={{
                                  width: `${Math.max(pct, 4)}%`,
                                  backgroundColor: getSourceColor(row.source_name),
                                  opacity: 0.7,
                                }}
                              />
                            </div>
                            <div className="flex items-center justify-between mt-1 px-0.5">
                              <span className="text-[10px] uppercase tracking-wide text-sage-500">{label}</span>
                              <span className="text-xs font-medium text-sage-700 tabular-nums">{fmtCount(value)}</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {/* ---- Spend Over Time Chart ---- */}
      {loading ? (
        <ChartSkeleton />
      ) : spendOverTimeData.length > 0 ? (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-xl font-semibold text-sage-900 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-sage-600" />
            Monthly Spend by Source
          </h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={spendOverTimeData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 12, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    border: '1px solid #E8E4DF',
                    borderRadius: '8px',
                    fontSize: '13px',
                  }}
                  formatter={(value, name) => [`$${Number(value).toLocaleString()}`, name]}
                />
                <Legend
                  wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
                />
                {allSpendSources.map((source) => (
                  <Line
                    key={source}
                    type="monotone"
                    dataKey={source}
                    stroke={getSourceColor(source)}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}
    </div>
  )
}
