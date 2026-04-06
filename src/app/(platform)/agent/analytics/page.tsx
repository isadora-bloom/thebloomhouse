'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  BarChart3,
  Mail,
  FileCheck,
  Send,
  Zap,
  DollarSign,
  Clock,
  TrendingUp,
  AlertTriangle,
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

interface FunnelStep {
  name: string
  count: number
}

interface TierCount {
  tier: string
  count: number
}

interface CostData {
  date: string
  cost: number
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
  const VENUE_ID = useVenueId()
  const [period, setPeriod] = useState<Period>('this_month')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Data
  const [emailVolume, setEmailVolume] = useState<DailyVolume[]>([])
  const [draftPerformance, setDraftPerformance] = useState<DraftPerformance[]>([])
  const [funnel, setFunnel] = useState<FunnelStep[]>([])
  const [tierDist, setTierDist] = useState<TierCount[]>([])
  const [costData, setCostData] = useState<CostData[]>([])
  const [totalInbound, setTotalInbound] = useState(0)
  const [totalOutbound, setTotalOutbound] = useState(0)
  const [autoSentCount, setAutoSentCount] = useState(0)
  const [manualCount, setManualCount] = useState(0)
  const [totalCost, setTotalCost] = useState(0)
  const [avgResponseHours, setAvgResponseHours] = useState(0)

  const supabase = createClient()

  const fetchAnalytics = useCallback(async () => {
    setLoading(true)
    const { start, end } = getPeriodRange(period)

    try {
      // 1. Email volume
      const { data: interactions } = await supabase
        .from('interactions')
        .select('direction, timestamp')
        .eq('venue_id', VENUE_ID)
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
        .eq('venue_id', VENUE_ID)
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

      // 3. Funnel (based on wedding statuses)
      const { data: weddings } = await supabase
        .from('weddings')
        .select('status')
        .eq('venue_id', VENUE_ID)

      const statusMap: Record<string, number> = {}
      for (const w of weddings ?? []) {
        statusMap[w.status] = (statusMap[w.status] || 0) + 1
      }

      setFunnel([
        { name: 'Inquiries', count: statusMap.inquiry ?? 0 },
        { name: 'Tours', count: (statusMap.tour_scheduled ?? 0) + (statusMap.tour_completed ?? 0) },
        { name: 'Proposals', count: statusMap.proposal_sent ?? 0 },
        { name: 'Booked', count: statusMap.booked ?? 0 },
      ])

      // 4. Temperature distribution
      const { data: heatData } = await supabase
        .from('weddings')
        .select('temperature_tier')
        .eq('venue_id', VENUE_ID)
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

      // 5. AI cost
      const { data: costs } = await supabase
        .from('api_costs')
        .select('cost, created_at')
        .eq('venue_id', VENUE_ID)
        .gte('created_at', start)
        .lt('created_at', end)
        .order('created_at', { ascending: true })

      const costMap: Record<string, { cost: number; count: number }> = {}
      let totalC = 0

      for (const c of costs ?? []) {
        const dateKey = new Date(c.created_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })
        if (!costMap[dateKey]) costMap[dateKey] = { cost: 0, count: 0 }
        costMap[dateKey].cost += c.cost || 0
        costMap[dateKey].count++
        totalC += c.cost || 0
      }

      setCostData(
        Object.entries(costMap).map(([date, v]) => ({
          date,
          cost: Math.round(v.cost * 100) / 100,
          count: v.count,
        }))
      )
      setTotalCost(Math.round(totalC * 100) / 100)

      // 6. Avg response time (rough estimate)
      const responseHours = inCount > 0 ? Math.round((outCount / inCount) * 2.5 * 10) / 10 : 0
      setAvgResponseHours(responseHours)

      setError(null)
    } catch (err) {
      console.error('Failed to fetch analytics:', err)
      setError('Failed to load analytics data')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => {
    fetchAnalytics()
  }, [fetchAnalytics])

  const totalDrafts = draftPerformance.reduce((sum, d) => sum + d.count, 0)
  const costPerEmail =
    totalOutbound > 0 ? Math.round((totalCost / totalOutbound) * 100) / 100 : 0

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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
          <StatCard
            icon={DollarSign}
            iconBg="bg-emerald-50"
            iconColor="text-emerald-600"
            label="AI Cost"
            value={`$${totalCost}`}
            sub={`$${costPerEmail}/email`}
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

      {/* ---- Charts Row 2: Funnel + Temperature ---- */}
      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ChartSkeleton />
          <ChartSkeleton />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Lead Conversion Funnel */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-base font-semibold text-sage-900 mb-4">
              Lead Conversion Funnel
            </h2>
            {funnel.every((f) => f.count === 0) ? (
              <div className="h-64 flex items-center justify-center">
                <p className="text-sm text-sage-400">No funnel data available</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={funnel} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8E6E1" />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#7D8471' }} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    tick={{ fontSize: 12, fill: '#7D8471' }}
                    width={80}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: '8px',
                      border: '1px solid #E8E6E1',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="count" fill="#7D8471" radius={[0, 4, 4, 0]} barSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Temperature Distribution */}
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
        </div>
      )}

      {/* ---- AI Cost Chart ---- */}
      {loading ? (
        <ChartSkeleton />
      ) : (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading text-base font-semibold text-sage-900">
              AI Cost Over Time
            </h2>
            <div className="flex items-center gap-4 text-xs text-sage-500">
              <span>
                Total: <span className="font-semibold text-sage-700">${totalCost}</span>
              </span>
              <span>
                Per email:{' '}
                <span className="font-semibold text-sage-700">${costPerEmail}</span>
              </span>
            </div>
          </div>
          {costData.length === 0 ? (
            <div className="h-48 flex items-center justify-center">
              <p className="text-sm text-sage-400">No AI cost data for this period</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={costData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8E6E1" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#7D8471' }} />
                <YAxis tick={{ fontSize: 11, fill: '#7D8471' }} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{
                    borderRadius: '8px',
                    border: '1px solid #E8E6E1',
                    fontSize: '12px',
                  }}
                  formatter={(value) => { const n = Number(value) || 0; return [`$${n}`, 'Cost']; }}
                />
                <Bar dataKey="cost" fill="#A6894A" radius={[4, 4, 0, 0]} barSize={20} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  )
}
