'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Mail, FileCheck, Newspaper, Heart,
  TrendingUp, ArrowRight, Building2, Layers, MapPin,
  BarChart3, Upload,
} from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'
import { MarketContextCard } from '@/components/intel/market-context-card'
import { InsightFeed } from '@/components/intel/insight-feed'
import { BrainDumpQueue } from '@/components/portal/brain-dump-queue'
import { UpcomingMeetings } from '@/components/platform/upcoming-meetings'

interface Stats {
  activeInquiries: number
  upcomingWeddings: number
  pendingDrafts: number
  bookedRevenue: number
  aiCost: number
  totalVenues: number
}

interface Activity {
  id: string
  type: string
  body_preview: string | null
  subject: string | null
  created_at: string
  venue_id: string
}

interface VenueRow {
  id: string
  name: string
  inquiries: number
  booked: number
  revenue: number
}

export default function DashboardPage() {
  const scope = useScope()
  const router = useRouter()

  // ---- Redirect to setup/onboarding based on user state ----
  useEffect(() => {
    if (scope.loading) return

    // If user has no venue at all → they need to complete company setup
    if (!scope.venueId) {
      // Verify via DB that user truly has no venue (cookie might be stale)
      const supabase = createClient()
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (!user) return
        supabase
          .from('user_profiles')
          .select('venue_id')
          .eq('id', user.id)
          .maybeSingle()
          .then(({ data: profile }) => {
            if (!profile?.venue_id) {
              router.push('/setup')
            }
          })
      })
      return
    }

    // If user has venue but onboarding is incomplete → go to onboarding
    const supabase = createClient()
    supabase
      .from('venue_config')
      .select('onboarding_completed')
      .eq('venue_id', scope.venueId)
      .maybeSingle()
      .then(({ data }) => {
        if (data && data.onboarding_completed === false) {
          router.push('/onboarding')
        }
      })
  }, [scope.venueId, scope.loading, router])

  const [stats, setStats] = useState<Stats>({
    activeInquiries: 0,
    upcomingWeddings: 0,
    pendingDrafts: 0,
    bookedRevenue: 0,
    aiCost: 0,
    totalVenues: 0,
  })
  const [activities, setActivities] = useState<Activity[]>([])
  const [venueBreakdown, setVenueBreakdown] = useState<VenueRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Wait for scope to resolve before querying — prevents aborted queries
    // and the 'Failed to fetch' errors that happen when queries fire with
    // incomplete scope state.
    if (scope.loading) return
    async function load() {
      setLoading(true)
      const supabase = createClient()

      // ---- Resolve which venue IDs are in scope ----
      let venueIds: string[] | null = null // null = all venues (company scope)

      if (scope.level === 'venue' && scope.venueId) {
        venueIds = [scope.venueId]
      } else if (scope.level === 'group' && scope.groupId) {
        const { data } = await supabase
          .from('venue_group_members')
          .select('venue_id')
          .eq('group_id', scope.groupId)
        venueIds = (data ?? []).map((r) => r.venue_id as string)
      } else if (scope.orgId) {
        // company scope — filter to user's org's venues only (prevents cross-org leak)
        const { data: orgVenues } = await supabase
          .from('venues')
          .select('id')
          .eq('org_id', scope.orgId)
        venueIds = (orgVenues ?? []).map((v) => v.id as string)
      }
      // company without orgId → venueIds stays null (legacy fallback)

      // ---- Helper to apply venue filter to a query ----
      function withVenueFilter<T extends { in: (col: string, vals: string[]) => T }>(q: T): T {
        if (venueIds && venueIds.length > 0) return q.in('venue_id', venueIds)
        return q
      }

      // ---- Active inquiries ----
      const inquiryQ = supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'inquiry')
      const { count: inquiryCount } = await withVenueFilter(inquiryQ as never)

      // ---- Upcoming weddings (next 30 days) ----
      const now = new Date()
      const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      const upcomingQ = supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .gte('wedding_date', now.toISOString().split('T')[0])
        .lte('wedding_date', thirtyDays.toISOString().split('T')[0])
      const { count: upcomingCount } = await withVenueFilter(upcomingQ as never)

      // ---- Pending drafts ----
      const draftsQ = supabase
        .from('drafts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
      const { count: draftCount } = await withVenueFilter(draftsQ as never)

      // ---- Booked revenue (next 12 months) ----
      const oneYear = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
      const revQ = supabase
        .from('weddings')
        .select('booking_value')
        .eq('status', 'booked')
        .gte('wedding_date', now.toISOString().split('T')[0])
        .lte('wedding_date', oneYear.toISOString().split('T')[0])
      const { data: revData } = await withVenueFilter(revQ as never) as { data: Array<{ booking_value: number | null }> | null }
      const bookedRevenue = (revData ?? []).reduce((sum, r) => sum + (r.booking_value ?? 0), 0)

      // ---- AI cost this month ----
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
      const costQ = supabase
        .from('api_costs')
        .select('cost')
        .gte('created_at', monthStart)
      const { data: costData } = await withVenueFilter(costQ as never) as { data: Array<{ cost: number | null }> | null }
      const totalCost = (costData ?? []).reduce((sum, r) => sum + (r.cost ?? 0), 0)

      // ---- Recent activity (interactions across all in-scope venues) ----
      const actQ = supabase
        .from('interactions')
        .select('id, type, body_preview, subject, created_at, venue_id')
        .order('created_at', { ascending: false })
        .limit(8)
      const { data: activityData } = await withVenueFilter(actQ as never) as { data: Activity[] | null }

      // ---- Per-venue breakdown (only at group/company scope) ----
      let breakdown: VenueRow[] = []
      let venueCount = 1
      if (scope.level !== 'venue') {
        let venuesQ = supabase.from('venues').select('id, name')
        if (venueIds && venueIds.length > 0) {
          venuesQ = venuesQ.in('id', venueIds)
        } else if (scope.orgId) {
          venuesQ = venuesQ.eq('org_id', scope.orgId)
        }
        const { data: venuesData } = await venuesQ as { data: Array<{ id: string; name: string }> | null }

        venueCount = venuesData?.length ?? 0

        if (venuesData && venuesData.length > 0) {
          // Fetch wedding aggregates per venue
          const venueWeddings = await supabase
            .from('weddings')
            .select('venue_id, status, booking_value')
            .in('venue_id', venuesData.map((v) => v.id))

          const aggregates = new Map<string, { inquiries: number; booked: number; revenue: number }>()
          for (const w of (venueWeddings.data ?? []) as Array<{ venue_id: string; status: string; booking_value: number | null }>) {
            const a = aggregates.get(w.venue_id) ?? { inquiries: 0, booked: 0, revenue: 0 }
            if (w.status === 'inquiry') a.inquiries += 1
            if (w.status === 'booked') {
              a.booked += 1
              a.revenue += w.booking_value ?? 0
            }
            aggregates.set(w.venue_id, a)
          }

          breakdown = venuesData.map((v) => ({
            id: v.id,
            name: v.name,
            inquiries: aggregates.get(v.id)?.inquiries ?? 0,
            booked: aggregates.get(v.id)?.booked ?? 0,
            revenue: aggregates.get(v.id)?.revenue ?? 0,
          })).sort((a, b) => b.revenue - a.revenue)
        }
      }

      setStats({
        activeInquiries: inquiryCount ?? 0,
        upcomingWeddings: upcomingCount ?? 0,
        pendingDrafts: draftCount ?? 0,
        bookedRevenue,
        aiCost: totalCost,
        totalVenues: venueCount,
      })
      setActivities(activityData ?? [])
      setVenueBreakdown(breakdown)
      setLoading(false)
    }

    load()
  }, [scope.level, scope.venueId, scope.groupId, scope.loading])

  // ---- Header copy varies by scope ----
  const scopeIcon = scope.level === 'company' ? Building2 : scope.level === 'group' ? Layers : MapPin
  const ScopeIcon = scopeIcon
  const scopeName = scope.level === 'company'
    ? scope.companyName ?? 'All Venues'
    : scope.level === 'group'
      ? scope.groupName ?? 'Group'
      : scope.venueName ?? 'Venue'
  const scopeSubtitle = scope.level === 'company'
    ? 'Company-wide overview across all venues'
    : scope.level === 'group'
      ? `Aggregated view across this group`
      : `Daily activity at ${scopeName}`

  // ---- Stat cards (reused across all scopes) ----
  const statCards = [
    {
      label: 'Active Inquiries',
      value: stats.activeInquiries,
      icon: Mail,
      color: 'text-sage-600',
      bg: 'bg-sage-50',
    },
    {
      label: 'Upcoming (30d)',
      value: stats.upcomingWeddings,
      icon: Heart,
      color: 'text-rose-600',
      bg: 'bg-rose-50',
    },
    {
      label: 'Pending Drafts',
      value: stats.pendingDrafts,
      icon: FileCheck,
      color: 'text-teal-600',
      bg: 'bg-teal-50',
    },
    {
      label: 'Booked Revenue (12mo)',
      value: `$${(stats.bookedRevenue / 1000).toFixed(0)}k`,
      icon: TrendingUp,
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
    },
  ]

  // Add a venues count card for company/group scope
  if (scope.level !== 'venue') {
    statCards.unshift({
      label: 'Venues',
      value: stats.totalVenues,
      icon: Building2,
      color: 'text-purple-600',
      bg: 'bg-purple-50',
    })
  }

  const quickActions = scope.level === 'venue'
    ? [
        { label: 'View Inbox', href: '/agent/inbox', icon: Mail, description: 'Review incoming inquiries' },
        { label: 'Approval Queue', href: '/agent/drafts', icon: FileCheck, description: 'Approve AI-generated drafts' },
        { label: 'Intel Dashboard', href: '/intel/dashboard', icon: Newspaper, description: 'Venue insights and trends' },
        { label: 'Your Impact', href: '/intel/roi', icon: BarChart3, description: 'See your ROI metrics' },
      ]
    : [
        { label: 'Portfolio Overview', href: '/intel/portfolio', icon: Layers, description: 'All venues at a glance' },
        { label: 'All Clients', href: '/intel/clients', icon: Heart, description: 'Cross-venue client list' },
        { label: 'Your Impact', href: '/intel/roi', icon: BarChart3, description: 'See your ROI metrics' },
      ]

  return (
    <div className="space-y-8">
      {/* Welcome */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-sage-50 rounded-xl">
            <ScopeIcon className="w-6 h-6 text-sage-600" />
          </div>
          <div>
            <h1 className="font-heading text-3xl font-bold text-sage-900">
              {scopeName}
            </h1>
            <p className="text-sage-600 mt-0.5">{scopeSubtitle}</p>
          </div>
        </div>
        <Link
          href="/portal/quick-add"
          className="flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 transition-colors shadow-sm"
          title="Quick Add — upload data"
        >
          <Upload className="w-4 h-4" />
          <span className="hidden sm:inline">Quick Add</span>
        </Link>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {statCards.map((card) => (
          <div
            key={card.label}
            className="bg-surface border border-border rounded-xl p-4 flex items-start gap-3"
          >
            <div className={`${card.bg} p-2 rounded-lg shrink-0`}>
              <card.icon className={`w-4 h-4 ${card.color}`} />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted truncate">{card.label}</p>
              <p className="text-xl font-bold text-sage-900 mt-0.5">
                {loading ? (
                  <span className="inline-block w-10 h-6 bg-sage-100 rounded animate-pulse" />
                ) : (
                  card.value
                )}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Brain-dump queue — Task 29. Hidden when empty. */}
      <BrainDumpQueue />

      {/* Market Intelligence — immediate value from external data */}
      <MarketContextCard />

      {/* Intelligence Insights — top 5 pattern detections */}
      <InsightFeed limit={5} showViewAll />

      {/* Per-venue breakdown (only at group/company scope) */}
      {scope.level !== 'venue' && venueBreakdown.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Venue Breakdown
            </h2>
            <Link
              href="/intel/portfolio"
              className="text-xs text-sage-600 hover:text-sage-800 flex items-center gap-1"
            >
              View portfolio <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted uppercase tracking-wider">
                  <th className="py-2 pr-4">Venue</th>
                  <th className="py-2 px-4 text-right">Inquiries</th>
                  <th className="py-2 px-4 text-right">Booked</th>
                  <th className="py-2 pl-4 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {venueBreakdown.map((v) => (
                  <tr key={v.id} className="hover:bg-sage-50/40">
                    <td className="py-3 pr-4 font-medium text-sage-800">{v.name}</td>
                    <td className="py-3 px-4 text-right tabular-nums text-sage-700">{v.inquiries}</td>
                    <td className="py-3 px-4 text-right tabular-nums text-sage-700">{v.booked}</td>
                    <td className="py-3 pl-4 text-right tabular-nums font-semibold text-sage-900">
                      ${(v.revenue / 1000).toFixed(0)}k
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Activity */}
        <div className="lg:col-span-2 bg-surface border border-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Recent Activity
            </h2>
            <TrendingUp className="w-4 h-4 text-sage-400" />
          </div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-sage-50 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : activities.length === 0 ? (
            <p className="text-sm text-muted py-8 text-center">
              No recent activity. Interactions will appear here as they come in.
            </p>
          ) : (
            <ul className="space-y-3">
              {activities.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-3 p-3 rounded-lg bg-sage-50/50"
                >
                  <div className="w-2 h-2 mt-2 rounded-full bg-sage-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-sage-800 line-clamp-1">
                      {a.subject || a.body_preview || a.type}
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      {new Date(a.created_at).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-sage-500 bg-sage-100 px-2 py-0.5 rounded-full shrink-0">
                    {a.type}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Quick Actions + Upcoming Meetings */}
        <div className="space-y-6">
          <div className="space-y-3">
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Quick Actions
            </h2>
            {quickActions.map((action) => (
              <Link
                key={action.href}
                href={action.href}
                className="flex items-center gap-4 p-4 bg-surface border border-border rounded-xl hover:border-sage-300 hover:shadow-sm transition-all group"
              >
                <div className="bg-sage-50 p-2.5 rounded-lg group-hover:bg-sage-100 transition-colors">
                  <action.icon className="w-5 h-5 text-sage-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-sage-800">{action.label}</p>
                  <p className="text-xs text-muted">{action.description}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-sage-400 group-hover:text-sage-600 transition-colors" />
              </Link>
            ))}
          </div>

          {/* Calendly upcoming meetings — only meaningful at venue scope */}
          {scope.level === 'venue' && <UpcomingMeetings />}
        </div>
      </div>
    </div>
  )
}
