'use client'

/**
 * /agent/analytics — how the email agent is doing.
 *
 * W63: four of the numbers on this page were derived here, in the page
 * body, out of `interactions` and `weddings`. Mail volume, median reply
 * time, whether the first reply landed, and how long a couple takes to
 * decide. Each had its own arithmetic and its own idea of what counted,
 * and none of them matched what /today or /intel said about the same
 * venue.
 *
 * They now come from the spine: `loadMessageVolume`,
 * `loadFollowThrough` and `loadDecisionTimeline` under
 * `src/lib/intel/readers/`, plus `getCohortFunnel` (the canonical
 * reader) for reply time, through /api/intel/canonical/cohort-funnel.
 * Drafts, temperature and AI cost are unchanged: none of those lives on
 * the legacy stack.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import type { CohortFunnel } from '@/lib/intel/canonical'
import {
  loadDecisionTimeline,
  loadFollowThrough,
  loadMessageVolume,
} from '@/lib/intel/readers/agent-activity'
import {
  BarChart3,
  Mail,
  FileCheck,
  Send,
  Zap,
  Clock,
  TrendingUp,
  AlertTriangle,
  Calendar,
} from 'lucide-react'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
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

type Period = 'today' | 'this_week' | 'this_month' | 'last_month'

interface DailyVolume {
  date: string
  inbound: number
  outbound: number
}

interface DraftPerformance {
  status: string
  count: number
}

interface TierCount {
  tier: string
  count: number
}

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This Week' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
]

const HEAT_COLORS: Record<string, string> = {
  hot: '#EF4444',
  warm: '#F59E0B',
  cool: '#3B82F6',
  cold: '#1E40AF',
  frozen: '#6B7280',
}

const PIE_COLORS = ['#7D8471', '#5D7A7A', '#A6894A', '#B8908A']

// ---------------------------------------------------------------------------
// Lead Engagement Intelligence — seeded values
// Engagement metrics are now computed from real data in fetchAnalytics
// (see EngagementMetrics state + computeEngagementMetrics).

function getPeriodRange(period: Period): { start: string; end: string } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  switch (period) {
    case 'today':
      return {
        start: today.toISOString(),
        end: new Date(today.getTime() + 86400000).toISOString(),
      }
    case 'this_week': {
      const dayOfWeek = today.getDay()
      const startOfWeek = new Date(today.getTime() - dayOfWeek * 86400000)
      return {
        start: startOfWeek.toISOString(),
        end: new Date(startOfWeek.getTime() + 7 * 86400000).toISOString(),
      }
    }
    case 'this_month': {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      return { start: startOfMonth.toISOString(), end: endOfMonth.toISOString() }
    }
    case 'last_month': {
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      return { start: startOfLastMonth.toISOString(), end: endOfLastMonth.toISOString() }
    }
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function StatCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-2">
        <div className="h-4 w-20 bg-sage-100 rounded" />
        <div className="h-8 w-16 bg-sage-100 rounded" />
        <div className="h-3 w-24 bg-sage-50 rounded" />
      </div>
    </div>
  )
}

function ChartSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="h-5 w-40 bg-sage-100 rounded" />
        <div className="h-64 w-full bg-sage-50 rounded-lg" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sparkline (lightweight inline SVG)
// ---------------------------------------------------------------------------

function Sparkline({
  data,
  color = '#7D8471',
  height = 32,
}: {
  data: number[]
  color?: string
  height?: number
}) {
  if (!data.length) return null
  const width = 140
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const stepX = width / (data.length - 1 || 1)
  const points = data
    .map((v, i) => {
      const x = i * stepX
      const y = height - ((v - min) / range) * (height - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className="block"
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Stat Card
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon,
  iconBg,
  iconColor,
  label,
  value,
  sub,
}: {
  icon: typeof Mail
  iconBg: string
  iconColor: string
  label: string
  value: string | number
  sub?: string
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 rounded-lg ${iconBg} flex items-center justify-center`}>
          <Icon className={`w-5 h-5 ${iconColor}`} />
        </div>
        <div>
          <p className="text-2xl font-bold text-sage-900">{value}</p>
          <p className="text-xs text-sage-500">{label}</p>
          {sub && <p className="text-[10px] text-sage-400 mt-0.5">{sub}</p>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function AgentAnalyticsPage() {
  const scope = useScope()
  const [period, setPeriod] = useState<Period>('this_month')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Data
  const [emailVolume, setEmailVolume] = useState<DailyVolume[]>([])
  const [draftPerformance, setDraftPerformance] = useState<DraftPerformance[]>([])
  const [tierDist, setTierDist] = useState<TierCount[]>([])
  const [totalInbound, setTotalInbound] = useState(0)
  const [totalOutbound, setTotalOutbound] = useState(0)
  const [autoSentCount, setAutoSentCount] = useState(0)
  const [manualCount, setManualCount] = useState(0)
  /** The canonical cohort funnel for the venue in scope. Null at group
   *  or company scope, and null when the read failed. */
  const [cohort, setCohort] = useState<CohortFunnel | null>(null)
  /** Messages in the window whose direction was never stamped. Shown
   *  rather than folded into a side of the chart. */
  const [unstampedMessages, setUnstampedMessages] = useState(0)

  // Engagement intelligence — computed from real interactions/weddings
  // for the venue scope. nulls render as "not enough data yet" in the UI.
  const [firstEmailActionRate, setFirstEmailActionRate] = useState<number | null>(null)
  const [firstEmailActionSample, setFirstEmailActionSample] = useState(0)
  // Connective II / fix #10: AI cost breakdown by task type.
  const [aiCostTotal, setAiCostTotal] = useState(0)
  const [aiCostBreakdown, setAiCostBreakdown] = useState<Array<{ taskType: string; calls: number; cost: number }>>([])
  const [decisionDays, setDecisionDays] = useState<number | null>(null)
  const [decisionFastPct, setDecisionFastPct] = useState(0)
  const [decisionTypicalPct, setDecisionTypicalPct] = useState(0)
  const [decisionSlowPct, setDecisionSlowPct] = useState(0)
  const [decisionBookedSample, setDecisionBookedSample] = useState(0)
  /** Couples with a contract but no first sight recorded, so no span
   *  could be measured. Said out loud rather than dropped. */
  const [decisionUnmeasurable, setDecisionUnmeasurable] = useState(0)

  const supabase = createClient()

  const fetchAnalytics = useCallback(async () => {
    setLoading(true)
    const { start, end } = getPeriodRange(period)

    try {
      // Resolve scope → venueIds. At venue level this is [scope.venueId];
      // at group/company level it expands so totals actually sum across
      // the user's venues instead of silently showing one venue's slice.
      let venueIds: string[] | null = null
      if (scope.level === 'venue' && scope.venueId) {
        venueIds = [scope.venueId]
      } else if (scope.level === 'group' && scope.groupId) {
        const { data } = await supabase
          .from('venue_group_members')
          .select('venue_id')
          .eq('group_id', scope.groupId)
        venueIds = (data ?? []).map((r) => r.venue_id as string)
      } else if (scope.orgId) {
        const { data: orgVenues } = await supabase
          .from('venues')
          .select('id')
          .eq('org_id', scope.orgId)
        venueIds = (orgVenues ?? []).map((v) => v.id as string)
      }
      if (!venueIds || venueIds.length === 0) {
        setEmailVolume([])
        setDraftPerformance([])
        setTierDist([])
        setTotalInbound(0)
        setTotalOutbound(0)
        setAutoSentCount(0)
        setManualCount(0)
        setUnstampedMessages(0)
        setCohort(null)
        setLoading(false)
        return
      }

      // 1. Message volume, off the spine. Inbound and outbound come from
      //    `touchpoints.direction`, stamped at write time by migration
      //    381 — the page does not infer a direction from anything.
      const volume = await loadMessageVolume(supabase, venueIds, start, end)
      setEmailVolume(
        volume.days.map((d) => ({
          // The chart labels a day; the reader hands back the date.
          date: new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          }),
          inbound: d.inbound,
          outbound: d.outbound,
        }))
      )
      setTotalInbound(volume.totalInbound)
      setTotalOutbound(volume.totalOutbound)
      setUnstampedMessages(volume.totalUnknown)

      // 2. Draft performance
      const { data: drafts } = await supabase
        .from('drafts')
        .select('status, auto_sent')
        .in('venue_id', venueIds)
        .gte('created_at', start)
        .lt('created_at', end)

      const statusCounts: Record<string, number> = {}
      let auto = 0
      let manual = 0

      for (const d of drafts ?? []) {
        statusCounts[d.status] = (statusCounts[d.status] || 0) + 1
        if (d.auto_sent) auto++
        else manual++
      }

      setDraftPerformance(
        Object.entries(statusCounts).map(([status, count]) => ({
          status: status.charAt(0).toUpperCase() + status.slice(1),
          count,
        }))
      )
      setAutoSentCount(auto)
      setManualCount(manual)

      // 3. Temperature distribution.
      // Migration 316: temperature_tier moved to wedding_heat view.
      const { data: heatData } = await supabase
        .from('wedding_heat')
        .select('temperature_tier')
        .in('venue_id', venueIds)

      const tierMap: Record<string, number> = {}
      for (const h of heatData ?? []) {
        const t = h.temperature_tier || 'cool'
        tierMap[t] = (tierMap[t] || 0) + 1
      }

      setTierDist(
        ['hot', 'warm', 'cool', 'cold', 'frozen']
          .filter((t) => tierMap[t])
          .map((t) => ({ tier: t.charAt(0).toUpperCase() + t.slice(1), count: tierMap[t] }))
      )

      // 5. AI cost — Connective II / fix #10 (2026-04-30): used to
      // be fetched and dropped. Now grouped by context (taskType) so
      // coordinators see where AI spend is going. Was a real
      // visibility gap — admins had no breakdown of which feature
      // consumed AI budget.
      const { data: costRows } = await supabase
        .from('api_costs')
        .select('cost, context, created_at, model')
        .in('venue_id', venueIds)
        .gte('created_at', start)
        .lt('created_at', end)
      const aiCostByTask: Record<string, { calls: number; cost: number }> = {}
      let aiCostTotal = 0
      for (const r of (costRows ?? []) as Array<{ cost: number | null; context: string | null }>) {
        const c = Number(r.cost ?? 0)
        const ctx = r.context ?? 'unknown'
        aiCostTotal += c
        if (!aiCostByTask[ctx]) aiCostByTask[ctx] = { calls: 0, cost: 0 }
        aiCostByTask[ctx].calls++
        aiCostByTask[ctx].cost += c
      }
      const aiCostBreakdownLocal = Object.entries(aiCostByTask)
        .map(([taskType, v]) => ({ taskType, calls: v.calls, cost: v.cost }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 8)
      setAiCostTotal(aiCostTotal)
      setAiCostBreakdown(aiCostBreakdownLocal)

      // 6. Median reply time — the canonical reader, not a second
      //    calculation of the same thing. Venue-scoped on purpose: a
      //    median of medians is not a median, which is the same reason
      //    src/lib/intel/adapters/scope-merge.ts refuses to merge
      //    ratios. At group or company scope the tile says so.
      if (scope.level === 'venue' && scope.venueId) {
        try {
          const res = await fetch(
            `/api/intel/canonical/cohort-funnel?venueId=${encodeURIComponent(scope.venueId)}&sinceDays=365`,
            { cache: 'no-store' },
          )
          const body = (await res.json()) as { ok: boolean; funnel?: CohortFunnel }
          setCohort(body.ok && body.funnel ? body.funnel : null)
        } catch {
          setCohort(null)
        }
      } else {
        setCohort(null)
      }

      // 7. Did the first reply land — of the couples first seen in the
      //    last ninety days, how many wrote in more than once.
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString()
      const follow = await loadFollowThrough(supabase, venueIds, ninetyDaysAgo)
      setFirstEmailActionRate(follow.rate)
      setFirstEmailActionSample(follow.sample)

      // 8. Decision timeline — first sight to contract, for couples who
      //    signed in the last hundred and eighty days.
      const oneEightyAgo = new Date(Date.now() - 180 * 86400000).toISOString()
      const decision = await loadDecisionTimeline(supabase, venueIds, oneEightyAgo)
      setDecisionDays(decision.averageDays)
      setDecisionFastPct(decision.fastPct)
      setDecisionTypicalPct(decision.typicalPct)
      setDecisionSlowPct(decision.slowPct)
      setDecisionBookedSample(decision.sample)
      setDecisionUnmeasurable(decision.unmeasurable)

      setError(null)
    } catch (err) {
      console.error('Failed to fetch analytics:', err)
      setError('Failed to load analytics data')
    } finally {
      setLoading(false)
    }
  }, [period, scope.level, scope.venueId, scope.groupId, scope.orgId, supabase])

  useEffect(() => {
    if (scope.loading) return
    fetchAnalytics()
  }, [fetchAnalytics, scope.loading])

  const totalDrafts = draftPerformance.reduce((sum, d) => sum + d.count, 0)

  // Reply time, straight off the canonical reader's Distribution. The
  // value is already a median in hours; the honesty flags ride with it,
  // so a thin sample says it is thin instead of printing a confident
  // number nobody should act on.
  const responseDist = cohort?.responseTime ?? null
  const responseHours =
    responseDist && responseDist.value !== null
      ? Math.round(responseDist.value * 10) / 10
      : null
  const responseNote =
    scope.level !== 'venue'
      ? 'Pick a single venue to see this. A median across venues is not a median of anything.'
      : responseDist === null
        ? 'This one would not load just now.'
        : responseHours === null
          ? 'No couple has both written in and had a reply back yet.'
          : responseDist.enoughData
            ? `Across ${responseDist.n} couples.`
            : `Across ${responseDist.n} couples, which is still a small number to read much into.`

  // Scope label. Show what the operator is actually looking at so a
  // confused "wait, which venue is this for?" never happens. Mirrors the
  // resolution order: venue, group, company, then company-wide fallback.
  const scopeLabel =
    scope.level === 'venue'
      ? scope.venueName ?? 'Current venue'
      : scope.level === 'group'
        ? scope.groupName ?? 'Current group'
        : scope.companyName ?? 'All venues'
  const periodLabel =
    PERIOD_OPTIONS.find((p) => p.value === period)?.label ?? period

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Agent Analytics
          </h1>
          <p className="text-sage-600">
            Track how your AI email agent is performing — response times, draft accuracy, and lead conversion rates. Use this to spot trends and measure the impact of your communication strategy.
          </p>
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
          className="text-sm border border-sage-200 rounded-lg px-4 py-2 text-sage-700 bg-warm-white focus:outline-none focus:ring-2 focus:ring-sage-300"
        >
          {PERIOD_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* ---- Scope banner ---- */}
      <div className="bg-sage-50 border border-sage-200 rounded-lg px-4 py-2.5 flex items-center gap-2 text-sm">
        <BarChart3 className="w-4 h-4 text-sage-700 shrink-0" />
        <span className="text-sage-700">
          Showing: <span className="font-semibold text-sage-900">{scopeLabel}</span>
          <span className="text-sage-400 mx-2">·</span>
          <span className="font-semibold text-sage-900">{periodLabel}</span>
        </span>
      </div>

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => {
              setError(null)
              fetchAnalytics()
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Stat Cards ---- */}
      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <StatCard
            icon={Mail}
            iconBg="bg-teal-50"
            iconColor="text-teal-600"
            label="Messages In"
            value={totalInbound}
          />
          <StatCard
            icon={Send}
            iconBg="bg-sage-50"
            iconColor="text-sage-600"
            label="Messages Out"
            value={totalOutbound}
          />
          <StatCard
            icon={Zap}
            iconBg="bg-amber-50"
            iconColor="text-amber-600"
            label="Auto-Sent"
            value={autoSentCount}
            sub={`${manualCount} manual`}
          />
        </div>
      )}

      {/* ---- Charts Row 1: Volume + Draft Performance ---- */}
      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ChartSkeleton />
          <ChartSkeleton />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Message Volume */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-base font-semibold text-sage-900 mb-4">
              Message Volume
            </h2>
            {emailVolume.length === 0 ? (
              <div className="h-64 flex items-center justify-center">
                <p className="text-sm text-sage-400">Nothing came in or went out in this period</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={emailVolume}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8E6E1" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#7D8471' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#7D8471' }} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: '8px',
                      border: '1px solid #E8E6E1',
                      fontSize: '12px',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Line
                    type="monotone"
                    dataKey="inbound"
                    stroke="#5D7A7A"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    name="Inbound"
                  />
                  <Line
                    type="monotone"
                    dataKey="outbound"
                    stroke="#7D8471"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    name="Outbound"
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
            {unstampedMessages > 0 && (
              <p className="mt-3 text-[11px] text-sage-500">
                {unstampedMessages} message{unstampedMessages === 1 ? '' : 's'} in this period
                carry no direction, so they are in neither line. They are older than the change
                that started recording which way a message went.
              </p>
            )}
          </div>

          {/* Draft Performance Pie */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-base font-semibold text-sage-900 mb-4">
              Draft Performance
            </h2>
            {draftPerformance.length === 0 ? (
              <div className="h-64 flex items-center justify-center">
                <p className="text-sm text-sage-400">No draft data for this period</p>
              </div>
            ) : (
              <div className="flex items-center gap-6">
                <ResponsiveContainer width="50%" height={240}>
                  <PieChart>
                    <Pie
                      data={draftPerformance}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={4}
                      dataKey="count"
                      nameKey="status"
                    >
                      {draftPerformance.map((_, idx) => (
                        <Cell
                          key={idx}
                          fill={PIE_COLORS[idx % PIE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        borderRadius: '8px',
                        border: '1px solid #E8E6E1',
                        fontSize: '12px',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2">
                  {draftPerformance.map((d, idx) => (
                    <div key={d.status} className="flex items-center gap-2">
                      <span
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: PIE_COLORS[idx % PIE_COLORS.length] }}
                      />
                      <span className="text-sm text-sage-700">
                        {d.status}{' '}
                        <span className="font-semibold text-sage-900">
                          {d.count}
                        </span>
                        <span className="text-sage-400 ml-1">
                          ({totalDrafts > 0 ? Math.round((d.count / totalDrafts) * 100) : 0}%)
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- Lead Engagement Intelligence ---- */}
      {loading ? (
        <ChartSkeleton />
      ) : (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <div className="mb-5">
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Lead Engagement Intelligence
            </h2>
            <p className="text-sm text-sage-600 mt-1">
              How prospects actually behave after your agent reaches out — action rates,
              response speed, and decision timelines.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Metric 1: First-email action rate (REAL) */}
            <div className="border border-border rounded-xl p-5 bg-warm-white">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-teal-50 flex items-center justify-center">
                  <Mail className="w-5 h-5 text-teal-600" />
                </div>
                <span className="text-xs font-medium uppercase tracking-wider text-sage-500">
                  First-Email Action Rate
                </span>
              </div>
              <p className="mt-4 text-4xl font-bold text-sage-900">
                {firstEmailActionRate === null ? '—' : `${firstEmailActionRate}%`}
              </p>
              <p className="mt-1 text-sm text-sage-600">
                of couples replied more than once after their first email
              </p>
              <p className="mt-3 text-[10px] text-sage-400">
                {firstEmailActionSample > 0
                  ? `Based on ${firstEmailActionSample} couple${firstEmailActionSample === 1 ? '' : 's'} first seen in the last 90 days`
                  : 'Nobody new has written in over the last 90 days, so there is nothing to measure'}
              </p>
            </div>

            {/* Metric 2: Median reply time — getCohortFunnel, the
                canonical reader. One venue at a time, because a median
                across venues is not a median of anything. */}
            <div className="border border-border rounded-xl p-5 bg-warm-white">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-sage-50 flex items-center justify-center">
                  <Clock className="w-5 h-5 text-sage-600" />
                </div>
                <span className="text-xs font-medium uppercase tracking-wider text-sage-500">
                  Median Reply Time
                </span>
              </div>
              <p className="mt-4 text-4xl font-bold text-sage-900">
                {responseHours === null ? '—' : `${responseHours} hours`}
              </p>
              <p className="mt-1 text-sm text-sage-600">
                Typical time from a couple&apos;s message to your reply
              </p>
              <p className="mt-3 text-[10px] text-sage-400">{responseNote}</p>
            </div>

            {/* Metric 3: Decision timeline (REAL — booked weddings, last 180d) */}
            <div className="border border-border rounded-xl p-5 bg-warm-white md:col-span-2">
              <div className="flex items-center gap-2">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: '#F5EFE0' }}
                >
                  <Calendar className="w-5 h-5" style={{ color: '#A6894A' }} />
                </div>
                <span className="text-xs font-medium uppercase tracking-wider text-sage-500">
                  Decision Timeline
                </span>
              </div>
              <p className="mt-4 text-4xl font-bold text-sage-900">
                {decisionDays === null ? '—' : `${decisionDays} days`}
              </p>
              <p className="mt-1 text-sm text-sage-600">
                Average from first contact to booking
              </p>
              {decisionDays === null ? (
                <p className="mt-3 text-[10px] text-sage-400">
                  No bookings yet in the last 180 days
                </p>
              ) : (
                <>
                  <div className="mt-4">
                    <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-sage-50">
                      <div className="bg-emerald-400" style={{ width: `${decisionFastPct}%` }} title={`Fast: ${decisionFastPct}%`} />
                      <div className="bg-sage-500" style={{ width: `${decisionTypicalPct}%` }} title={`Typical: ${decisionTypicalPct}%`} />
                      <div className="bg-amber-400" style={{ width: `${decisionSlowPct}%` }} title={`Slow: ${decisionSlowPct}%`} />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[10px] text-sage-500">
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-emerald-400" />
                        {decisionFastPct}% fast (&lt;7d)
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-sage-500" />
                        {decisionTypicalPct}% typical (7–30d)
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-amber-400" />
                        {decisionSlowPct}% slow (30d+)
                      </span>
                    </div>
                  </div>
                  <p className="mt-3 text-[10px] text-sage-400">
                    Based on {decisionBookedSample} booking{decisionBookedSample === 1 ? '' : 's'} in the last 180 days
                    {decisionUnmeasurable > 0
                      ? `. ${decisionUnmeasurable} more signed but have no first contact on record, so they are left out.`
                      : ''}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---- Temperature Distribution ---- */}
      {loading ? (
        <ChartSkeleton />
      ) : (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-base font-semibold text-sage-900 mb-4">
            Temperature Distribution
          </h2>
          {tierDist.length === 0 ? (
            <div className="h-64 flex items-center justify-center">
              <p className="text-sm text-sage-400">No temperature data available</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={tierDist}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8E6E1" />
                <XAxis dataKey="tier" tick={{ fontSize: 11, fill: '#7D8471' }} />
                <YAxis tick={{ fontSize: 11, fill: '#7D8471' }} />
                <Tooltip
                  contentStyle={{
                    borderRadius: '8px',
                    border: '1px solid #E8E6E1',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" barSize={32} radius={[4, 4, 0, 0]}>
                  {tierDist.map((entry) => (
                    <Cell
                      key={entry.tier}
                      fill={HEAT_COLORS[entry.tier.toLowerCase()] || '#7D8471'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* Connective II / fix #10: AI cost by task type. Was being
          fetched and dropped — now broken down so coordinators see
          where AI spend goes (drafts vs Sage chat vs anomaly
          explanations vs candidate adjudication, etc). Self-hides
          when no AI calls were made in the period. */}
      {!loading && aiCostTotal > 0 && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading text-base font-semibold text-sage-900">
              AI cost by task
            </h2>
            <span className="text-sm text-sage-700 tabular-nums">
              ${aiCostTotal.toFixed(2)} <span className="text-xs text-sage-400">total</span>
            </span>
          </div>
          {aiCostBreakdown.length === 0 ? (
            <p className="text-sm text-sage-400">No AI calls recorded in this period.</p>
          ) : (
            <div className="space-y-2">
              {aiCostBreakdown.map((row) => {
                const pct = aiCostTotal > 0 ? (row.cost / aiCostTotal) * 100 : 0
                return (
                  <div key={row.taskType} className="flex items-center gap-3 text-xs">
                    <span className="w-40 shrink-0 text-sage-700 truncate" title={row.taskType}>
                      {row.taskType.replace(/_/g, ' ')}
                    </span>
                    <div className="flex-1 h-2 bg-sage-50 rounded-full overflow-hidden">
                      <div className="h-full bg-sage-500 rounded-full" style={{ width: `${pct.toFixed(1)}%` }} />
                    </div>
                    <span className="w-24 shrink-0 text-right text-sage-700 tabular-nums">
                      ${row.cost.toFixed(3)}
                    </span>
                    <span className="w-16 shrink-0 text-right text-sage-500 tabular-nums">
                      {row.calls} calls
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

    </div>
  )
}
