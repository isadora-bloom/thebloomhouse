'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
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
  const [avgResponseHours, setAvgResponseHours] = useState(0)

  // Engagement intelligence — computed from real interactions/weddings
  // for the venue scope. nulls render as "not enough data yet" in the UI.
  const [firstEmailActionRate, setFirstEmailActionRate] = useState<number | null>(null)
  const [firstEmailActionSample, setFirstEmailActionSample] = useState(0)
  const [decisionDays, setDecisionDays] = useState<number | null>(null)
  const [decisionFastPct, setDecisionFastPct] = useState(0)
  const [decisionTypicalPct, setDecisionTypicalPct] = useState(0)
  const [decisionSlowPct, setDecisionSlowPct] = useState(0)
  const [decisionBookedSample, setDecisionBookedSample] = useState(0)

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
        setAvgResponseHours(0)
        setLoading(false)
        return
      }

      // 1. Email volume
      const { data: interactions } = await supabase
        .from('interactions')
        .select('direction, timestamp')
        .in('venue_id', venueIds)
        .eq('type', 'email')
        .gte('timestamp', start)
        .lt('timestamp', end)
        .order('timestamp', { ascending: true })

      // Group by date
      const volumeMap: Record<string, { inbound: number; outbound: number }> = {}
      let inCount = 0
      let outCount = 0

      for (const row of interactions ?? []) {
        const dateKey = new Date(row.timestamp).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })
        if (!volumeMap[dateKey]) volumeMap[dateKey] = { inbound: 0, outbound: 0 }
        if (row.direction === 'inbound') {
          volumeMap[dateKey].inbound++
          inCount++
        } else {
          volumeMap[dateKey].outbound++
          outCount++
        }
      }

      setEmailVolume(
        Object.entries(volumeMap).map(([date, v]) => ({
          date,
          inbound: v.inbound,
          outbound: v.outbound,
        }))
      )
      setTotalInbound(inCount)
      setTotalOutbound(outCount)

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

      // 3. Temperature distribution
      const { data: heatData } = await supabase
        .from('weddings')
        .select('temperature_tier')
        .in('venue_id', venueIds)
        .not('temperature_tier', 'is', null)

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

      // 5. AI cost — fetched for internal monitoring/logging, not displayed
      await supabase
        .from('api_costs')
        .select('cost, created_at')
        .in('venue_id', venueIds)
        .gte('created_at', start)
        .lt('created_at', end)
        .order('created_at', { ascending: true })

      // 6. Avg response time — REAL: median time from inbound email to
      // the next outbound on the same Gmail thread, in hours. Looks at
      // the same period as the rest of the dashboard.
      const { data: threadInts } = await supabase
        .from('interactions')
        .select('gmail_thread_id, direction, timestamp')
        .in('venue_id', venueIds)
        .eq('type', 'email')
        .gte('timestamp', start)
        .lt('timestamp', end)
        .order('timestamp', { ascending: true })
        .not('gmail_thread_id', 'is', null)
      const threads: Record<string, Array<{ direction: string; t: number }>> = {}
      for (const i of (threadInts ?? []) as Array<{ gmail_thread_id: string; direction: string; timestamp: string }>) {
        if (!threads[i.gmail_thread_id]) threads[i.gmail_thread_id] = []
        threads[i.gmail_thread_id].push({ direction: i.direction, t: new Date(i.timestamp).getTime() })
      }
      const responseDeltasMs: number[] = []
      for (const events of Object.values(threads)) {
        for (let idx = 0; idx < events.length - 1; idx++) {
          if (events[idx].direction === 'inbound' && events[idx + 1].direction === 'outbound') {
            responseDeltasMs.push(events[idx + 1].t - events[idx].t)
          }
        }
      }
      // Use median, not mean — outliers (replies the next week) skew the
      // mean upward and don't represent typical responsiveness.
      const median = (xs: number[]) => {
        if (xs.length === 0) return 0
        const sorted = [...xs].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
      }
      const medianMs = median(responseDeltasMs)
      const responseHours = medianMs > 0 ? Math.round((medianMs / 3_600_000) * 10) / 10 : 0
      setAvgResponseHours(responseHours)

      // 7. First-email action rate — % of weddings (last 90 days) whose
      // couple sent more than one inbound email. Proxy for "did the
      // venue's first reply land?" — a couple that engaged once and
      // ghosted didn't take action.
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString()
      const { data: recentWeddings } = await supabase
        .from('weddings')
        .select('id')
        .in('venue_id', venueIds)
        .gte('inquiry_date', ninetyDaysAgo)
      const recentIds = (recentWeddings ?? []).map((w: { id: string }) => w.id)
      if (recentIds.length === 0) {
        setFirstEmailActionRate(null)
        setFirstEmailActionSample(0)
      } else {
        const { data: inboundOnRecent } = await supabase
          .from('interactions')
          .select('wedding_id')
          .in('wedding_id', recentIds)
          .eq('direction', 'inbound')
          .eq('type', 'email')
        const inboundCounts: Record<string, number> = {}
        for (const r of (inboundOnRecent ?? []) as { wedding_id: string }[]) {
          inboundCounts[r.wedding_id] = (inboundCounts[r.wedding_id] ?? 0) + 1
        }
        const withAtLeastOne = recentIds.filter((id) => (inboundCounts[id] ?? 0) >= 1).length
        const withMultiple = recentIds.filter((id) => (inboundCounts[id] ?? 0) >= 2).length
        setFirstEmailActionRate(withAtLeastOne > 0 ? Math.round((withMultiple / withAtLeastOne) * 100) : null)
        setFirstEmailActionSample(withAtLeastOne)
      }

      // 8. Decision timeline — for booked weddings (last 180 days),
      // average days from inquiry_date to booking. Buckets the same
      // population by <7d / 7-30d / 30d+ for the distribution bar.
      const oneEightyAgo = new Date(Date.now() - 180 * 86400000).toISOString()
      const { data: bookedWeddings } = await supabase
        .from('weddings')
        .select('id, inquiry_date, updated_at, status')
        .in('venue_id', venueIds)
        .eq('status', 'booked')
        .gte('inquiry_date', oneEightyAgo)
      const decisionDaysList: number[] = []
      for (const w of (bookedWeddings ?? []) as Array<{ inquiry_date: string; updated_at: string }>) {
        const inquiry = new Date(w.inquiry_date).getTime()
        const booked = new Date(w.updated_at).getTime()
        if (Number.isFinite(inquiry) && Number.isFinite(booked) && booked > inquiry) {
          decisionDaysList.push((booked - inquiry) / 86400000)
        }
      }
      if (decisionDaysList.length === 0) {
        setDecisionDays(null)
        setDecisionFastPct(0)
        setDecisionTypicalPct(0)
        setDecisionSlowPct(0)
        setDecisionBookedSample(0)
      } else {
        const avg = decisionDaysList.reduce((s, d) => s + d, 0) / decisionDaysList.length
        const fast = decisionDaysList.filter((d) => d < 7).length
        const typical = decisionDaysList.filter((d) => d >= 7 && d <= 30).length
        const slow = decisionDaysList.filter((d) => d > 30).length
        const total = decisionDaysList.length
        setDecisionDays(Math.round(avg))
        setDecisionFastPct(Math.round((fast / total) * 100))
        setDecisionTypicalPct(Math.round((typical / total) * 100))
        setDecisionSlowPct(Math.round((slow / total) * 100))
        setDecisionBookedSample(total)
      }

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
            label="Inbound Emails"
            value={totalInbound}
          />
          <StatCard
            icon={Send}
            iconBg="bg-sage-50"
            iconColor="text-sage-600"
            label="Outbound Emails"
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
          {/* Email Volume */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-base font-semibold text-sage-900 mb-4">
              Email Volume
            </h2>
            {emailVolume.length === 0 ? (
              <div className="h-64 flex items-center justify-center">
                <p className="text-sm text-sage-400">No email data for this period</p>
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
                  ? `Based on ${firstEmailActionSample} inquiries in the last 90 days`
                  : 'Not enough data — needs at least 1 inquiry in the last 90 days'}
              </p>
            </div>

            {/* Metric 2: Average lead response time (REAL — median ms→h) */}
            <div className="border border-border rounded-xl p-5 bg-warm-white">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-sage-50 flex items-center justify-center">
                  <Clock className="w-5 h-5 text-sage-600" />
                </div>
                <span className="text-xs font-medium uppercase tracking-wider text-sage-500">
                  Average Lead Response Time
                </span>
              </div>
              <p className="mt-4 text-4xl font-bold text-sage-900">
                {avgResponseHours > 0 ? `${avgResponseHours} hours` : '—'}
              </p>
              <p className="mt-1 text-sm text-sage-600">
                Median time from couple&apos;s email to your reply
              </p>
              <p className="mt-3 text-[10px] text-sage-400">
                {avgResponseHours > 0
                  ? `Calculated across every inbound→outbound pair in this period`
                  : 'No inbound→outbound thread pairs in this period'}
              </p>
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

    </div>
  )
}
