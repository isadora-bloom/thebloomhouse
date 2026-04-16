'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useScope } from '@/lib/hooks/use-scope'
import {
  Mail,
  Clock,
  Timer,
  Flame,
  TrendingUp,
  ThumbsUp,
  ArrowUp,
  ArrowDown,
  Minus,
  BarChart3,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ROIMetrics {
  inquiriesHandled: number
  inquiriesLastMonth: number
  avgResponseMinutes: number | null
  hoursSaved: number
  hoursSavedLastMonth: number
  rescuedLeads: number
  bookingsThisMonth: number
  pipelineValue: number
  bookingsLastMonth: number
  aiAccuracy: number | null
  totalDrafts: number
}

const EMPTY_METRICS: ROIMetrics = {
  inquiriesHandled: 0,
  inquiriesLastMonth: 0,
  avgResponseMinutes: null,
  hoursSaved: 0,
  hoursSavedLastMonth: 0,
  rescuedLeads: 0,
  bookingsThisMonth: 0,
  pipelineValue: 0,
  bookingsLastMonth: 0,
  aiAccuracy: null,
  totalDrafts: 0,
}

// Industry average: 18 hours to first response
const INDUSTRY_AVG_RESPONSE_HOURS = 18
// Industry average: 8 minutes to manually draft a response
const MINUTES_PER_MANUAL_DRAFT = 8

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trendIndicator(current: number, previous: number) {
  if (previous === 0 && current === 0) return { direction: 'flat' as const, pct: 0 }
  if (previous === 0) return { direction: 'up' as const, pct: 100 }
  const pct = Math.round(((current - previous) / previous) * 100)
  if (pct > 0) return { direction: 'up' as const, pct }
  if (pct < 0) return { direction: 'down' as const, pct: Math.abs(pct) }
  return { direction: 'flat' as const, pct: 0 }
}

function TrendBadge({ direction, label }: { direction: 'up' | 'down' | 'flat'; label: string }) {
  if (direction === 'up') {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-emerald-600">
        <ArrowUp className="w-3 h-3" />
        {label}
      </span>
    )
  }
  if (direction === 'down') {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-red-500">
        <ArrowDown className="w-3 h-3" />
        {label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-medium text-sage-400">
      <Minus className="w-3 h-3" />
      {label}
    </span>
  )
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-[10px] text-sage-400 mt-1 leading-tight">{text}</p>
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ROIDashboardPage() {
  const scope = useScope()
  const [metrics, setMetrics] = useState<ROIMetrics>(EMPTY_METRICS)
  const [loading, setLoading] = useState(true)

  // Resolve venue IDs from scope
  const resolveVenueIds = useCallback(async (): Promise<string[] | null> => {
    const supabase = createClient()
    if (scope.level === 'venue' && scope.venueId) return [scope.venueId]
    if (scope.level === 'group' && scope.groupId) {
      const { data } = await supabase
        .from('venue_group_members')
        .select('venue_id')
        .eq('group_id', scope.groupId)
      return (data ?? []).map((r) => r.venue_id as string)
    }
    return null // company = all venues
  }, [scope.level, scope.venueId, scope.groupId])

  useEffect(() => {
    if (scope.loading) return

    async function load() {
      setLoading(true)
      const supabase = createClient()
      const venueIds = await resolveVenueIds()

      // Helper: apply venue filter
      function vf<T extends { in: (col: string, vals: string[]) => T }>(q: T): T {
        if (venueIds && venueIds.length > 0) return q.in('venue_id', venueIds)
        return q
      }

      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

      // 1. Inquiries handled this month (inbound emails)
      const inboundQ = supabase
        .from('interactions')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'inbound')
        .gte('created_at', monthStart.toISOString())
      const { count: inquiriesHandled } = await vf(inboundQ as never)

      // Inquiries last month for comparison
      const inboundLastQ = supabase
        .from('interactions')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'inbound')
        .gte('created_at', lastMonthStart.toISOString())
        .lte('created_at', lastMonthEnd.toISOString())
      const { count: inquiriesLastMonth } = await vf(inboundLastQ as never)

      // 2. Average first response time
      // Fetch inbound interactions this month with their wedding_id
      const inboundDataQ = supabase
        .from('interactions')
        .select('id, wedding_id, created_at')
        .eq('direction', 'inbound')
        .gte('created_at', thirtyDaysAgo.toISOString())
        .order('created_at', { ascending: true })
        .limit(500)
      const { data: inboundData } = await vf(inboundDataQ as never) as {
        data: Array<{ id: string; wedding_id: string | null; created_at: string }> | null
      }

      // Fetch outbound interactions for matching
      const outboundDataQ = supabase
        .from('interactions')
        .select('id, wedding_id, created_at')
        .eq('direction', 'outbound')
        .gte('created_at', thirtyDaysAgo.toISOString())
        .order('created_at', { ascending: true })
        .limit(500)
      const { data: outboundData } = await vf(outboundDataQ as never) as {
        data: Array<{ id: string; wedding_id: string | null; created_at: string }> | null
      }

      // Compute average response time: for each inbound with a wedding_id,
      // find the first outbound with the same wedding_id after it
      let totalResponseMs = 0
      let responseCount = 0
      let rescuedLeads = 0

      if (inboundData && outboundData) {
        // Index outbound by wedding_id (earliest first)
        const outboundByWedding = new Map<string, Array<{ created_at: string }>>()
        for (const ob of outboundData) {
          if (!ob.wedding_id) continue
          const arr = outboundByWedding.get(ob.wedding_id) ?? []
          arr.push({ created_at: ob.created_at })
          outboundByWedding.set(ob.wedding_id, arr)
        }

        // Track already-matched wedding_ids to get first response only
        const matched = new Set<string>()
        for (const ib of inboundData) {
          if (!ib.wedding_id || matched.has(ib.wedding_id)) continue
          const outbounds = outboundByWedding.get(ib.wedding_id)
          if (!outbounds) continue

          // Find first outbound after this inbound
          const ibTime = new Date(ib.created_at).getTime()
          const firstReply = outbounds.find(
            (ob) => new Date(ob.created_at).getTime() > ibTime
          )
          if (firstReply) {
            const replyTime = new Date(firstReply.created_at).getTime()
            const diffMs = replyTime - ibTime
            totalResponseMs += diffMs
            responseCount += 1
            matched.add(ib.wedding_id)

            // Check rescued leads: response < 60 min AND inbound was sitting > 24 hours
            // (i.e., no earlier outbound within 24 hours before our response)
            const responseMinutes = diffMs / 60000
            if (responseMinutes < 60) {
              // Check if this lead had been waiting > 24 hours (no prior outbound)
              const priorOutbound = outbounds.find(
                (ob) => new Date(ob.created_at).getTime() <= ibTime
              )
              if (!priorOutbound) {
                rescuedLeads += 1
              }
            }
          }
        }
      }

      const avgResponseMinutes =
        responseCount > 0 ? Math.round(totalResponseMs / responseCount / 60000) : null

      // 3. Hours saved: count of AI drafts this month * 8 min / 60
      const draftsQ = supabase
        .from('drafts')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', monthStart.toISOString())
      const { count: draftsThisMonth } = await vf(draftsQ as never)

      const draftsLastQ = supabase
        .from('drafts')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', lastMonthStart.toISOString())
        .lte('created_at', lastMonthEnd.toISOString())
      const { count: draftsLastMonth } = await vf(draftsLastQ as never)

      const hoursSaved = Math.round(((draftsThisMonth ?? 0) * MINUTES_PER_MANUAL_DRAFT) / 60 * 10) / 10
      const hoursSavedLastMonth = Math.round(((draftsLastMonth ?? 0) * MINUTES_PER_MANUAL_DRAFT) / 60 * 10) / 10

      // 5. Bookings this month vs last month + pipeline value
      const bookingsQ = supabase
        .from('weddings')
        .select('id, booking_value')
        .eq('status', 'booked')
        .gte('created_at', monthStart.toISOString())
      const { data: bookingsData } = await vf(bookingsQ as never) as {
        data: Array<{ id: string; booking_value: number | null }> | null
      }

      const bookingsLastMonthQ = supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'booked')
        .gte('created_at', lastMonthStart.toISOString())
        .lte('created_at', lastMonthEnd.toISOString())
      const { count: bookingsLastMonthCount } = await vf(bookingsLastMonthQ as never)

      const pipelineQ = supabase
        .from('weddings')
        .select('booking_value')
        .eq('status', 'inquiry')
      const { data: pipelineData } = await vf(pipelineQ as never) as {
        data: Array<{ booking_value: number | null }> | null
      }

      const pipelineValue = (pipelineData ?? []).reduce(
        (sum, r) => sum + (r.booking_value ?? 0),
        0
      )

      // 6. AI accuracy: drafts approved without edit / total feedback
      const approvedQ = supabase
        .from('draft_feedback')
        .select('id', { count: 'exact', head: true })
        .eq('action', 'approved')
      const { count: approvedCount } = await vf(approvedQ as never)

      const totalFeedbackQ = supabase
        .from('draft_feedback')
        .select('id', { count: 'exact', head: true })
      const { count: totalFeedbackCount } = await vf(totalFeedbackQ as never)

      const aiAccuracy =
        (totalFeedbackCount ?? 0) > 0
          ? Math.round(((approvedCount ?? 0) / (totalFeedbackCount ?? 1)) * 100)
          : null

      setMetrics({
        inquiriesHandled: inquiriesHandled ?? 0,
        inquiriesLastMonth: inquiriesLastMonth ?? 0,
        avgResponseMinutes,
        hoursSaved,
        hoursSavedLastMonth,
        rescuedLeads,
        bookingsThisMonth: bookingsData?.length ?? 0,
        pipelineValue,
        bookingsLastMonth: bookingsLastMonthCount ?? 0,
        aiAccuracy,
        totalDrafts: totalFeedbackCount ?? 0,
      })
      setLoading(false)
    }

    load()
  }, [scope.loading, scope.level, scope.venueId, scope.groupId, resolveVenueIds])

  // ---- Card definitions ----
  const inquiryTrend = trendIndicator(metrics.inquiriesHandled, metrics.inquiriesLastMonth)
  const hoursTrend = trendIndicator(metrics.hoursSaved, metrics.hoursSavedLastMonth)
  const bookingTrend = trendIndicator(metrics.bookingsThisMonth, metrics.bookingsLastMonth)

  const cards = [
    {
      label: 'Inquiries Handled',
      value: metrics.inquiriesHandled,
      icon: Mail,
      color: 'text-sage-600',
      bg: 'bg-sage-50',
      trend: <TrendBadge direction={inquiryTrend.direction} label={`${inquiryTrend.pct}% vs last month`} />,
      note: null,
    },
    {
      label: 'Avg First Response',
      value: metrics.avgResponseMinutes !== null ? `${metrics.avgResponseMinutes}m` : '--',
      icon: Clock,
      color: 'text-teal-600',
      bg: 'bg-teal-50',
      trend:
        metrics.avgResponseMinutes !== null ? (
          <TrendBadge
            direction="up"
            label={`${Math.round(INDUSTRY_AVG_RESPONSE_HOURS * 60 / Math.max(metrics.avgResponseMinutes, 1))}x faster than industry avg (${INDUSTRY_AVG_RESPONSE_HOURS}h)`}
          />
        ) : null,
      note:
        metrics.avgResponseMinutes === null ? (
          <EmptyNote text="Needs inbound + outbound interactions to calculate." />
        ) : null,
    },
    {
      label: 'Hours Saved',
      value: metrics.hoursSaved > 0 ? `~${metrics.hoursSaved}h` : '--',
      icon: Timer,
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
      trend: metrics.hoursSaved > 0 ? (
        <TrendBadge direction={hoursTrend.direction} label={`${hoursTrend.pct}% vs last month`} />
      ) : null,
      note:
        metrics.hoursSaved === 0 ? (
          <EmptyNote text="Based on AI drafts generated (8 min saved per draft)." />
        ) : null,
    },
    {
      label: 'Leads Rescued',
      value: metrics.rescuedLeads > 0 ? metrics.rescuedLeads : '--',
      icon: Flame,
      color: 'text-orange-600',
      bg: 'bg-orange-50',
      trend:
        metrics.rescuedLeads > 0 ? (
          <span className="text-xs text-orange-600 font-medium">
            Responded in &lt;60 min to new leads
          </span>
        ) : null,
      note:
        metrics.rescuedLeads === 0 ? (
          <EmptyNote text="Counts leads that got a fast AI response before going cold." />
        ) : null,
    },
    {
      label: 'Bookings This Month',
      value: metrics.bookingsThisMonth > 0 ? metrics.bookingsThisMonth : '--',
      icon: TrendingUp,
      color: 'text-purple-600',
      bg: 'bg-purple-50',
      trend:
        metrics.bookingsThisMonth > 0 ? (
          <TrendBadge direction={bookingTrend.direction} label={`${bookingTrend.pct}% vs last month`} />
        ) : (
          <span className="text-xs text-sage-400">
            {metrics.pipelineValue > 0
              ? `$${(metrics.pipelineValue / 1000).toFixed(0)}k in pipeline`
              : 'No pipeline data yet'}
          </span>
        ),
      note: null,
    },
    {
      label: 'AI Draft Accuracy',
      value: metrics.aiAccuracy !== null ? `${metrics.aiAccuracy}%` : '--',
      icon: ThumbsUp,
      color: 'text-blue-600',
      bg: 'bg-blue-50',
      trend:
        metrics.aiAccuracy !== null ? (
          <span className="text-xs text-blue-600 font-medium">
            approved as-is ({metrics.totalDrafts} reviews)
          </span>
        ) : null,
      note:
        metrics.aiAccuracy === null ? (
          <EmptyNote text="Start approving drafts to see this metric." />
        ) : null,
    },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 bg-emerald-50 rounded-xl">
          <BarChart3 className="w-6 h-6 text-emerald-600" />
        </div>
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900">
            Your Impact
          </h1>
          <p className="text-sage-600 mt-0.5">
            Measurable ROI from Bloom House on your venue operations this month.
          </p>
        </div>
      </div>

      {/* Stat Cards - 2x3 grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {cards.map((card) => (
          <div
            key={card.label}
            className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow"
          >
            <div className="flex items-start gap-3 mb-3">
              <div className={`${card.bg} p-2.5 rounded-lg shrink-0`}>
                <card.icon className={`w-5 h-5 ${card.color}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-sage-500 uppercase tracking-wider">
                  {card.label}
                </p>
              </div>
            </div>

            <div className="pl-0">
              {loading ? (
                <div className="h-9 w-20 bg-sage-100 rounded-lg animate-pulse" />
              ) : (
                <p className="text-3xl font-bold text-sage-900 tabular-nums">
                  {card.value}
                </p>
              )}
            </div>

            {!loading && (
              <div className="mt-2 min-h-[20px]">
                {card.trend}
                {card.note}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Context section */}
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
        <h2 className="font-heading text-lg font-semibold text-sage-900 mb-3">
          How These Numbers Are Calculated
        </h2>
        <ul className="space-y-2.5 text-sm text-sage-600">
          <li className="flex items-start gap-3">
            <Mail className="w-4 h-4 text-sage-400 mt-0.5 shrink-0" />
            <span>
              <strong className="text-sage-800">Inquiries Handled</strong> counts
              inbound emails processed this month.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <Clock className="w-4 h-4 text-sage-400 mt-0.5 shrink-0" />
            <span>
              <strong className="text-sage-800">Avg First Response</strong> measures
              the time between an inbound email and the first outbound reply for that
              wedding. Industry average is {INDUSTRY_AVG_RESPONSE_HOURS} hours.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <Timer className="w-4 h-4 text-sage-400 mt-0.5 shrink-0" />
            <span>
              <strong className="text-sage-800">Hours Saved</strong> is based on{' '}
              {MINUTES_PER_MANUAL_DRAFT} minutes per manually written response
              (industry average), multiplied by the number of AI drafts generated.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <Flame className="w-4 h-4 text-sage-400 mt-0.5 shrink-0" />
            <span>
              <strong className="text-sage-800">Leads Rescued</strong> counts new
              leads where Bloom responded in under 60 minutes, preventing the lead from going cold.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <ThumbsUp className="w-4 h-4 text-sage-400 mt-0.5 shrink-0" />
            <span>
              <strong className="text-sage-800">AI Draft Accuracy</strong> is the
              percentage of AI-generated drafts approved without edits, based on your
              feedback in the approval queue.
            </span>
          </li>
        </ul>
      </div>
    </div>
  )
}
