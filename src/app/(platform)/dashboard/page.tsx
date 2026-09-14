'use client'

/**
 * /dashboard — the full platform dashboard.
 *
 * This was the post-login landing page until /today took that job. It is
 * kept whole and reachable: the stat tiles, market context, insight feed
 * and the group/company venue breakdown all still live here, and /today
 * links to it as "Open the full dashboard".
 *
 * W63: every count on this page used to come out of the legacy
 * `weddings` / `interactions` tables, with its own idea of what an
 * "active inquiry" was, which is why the dashboard and /today could
 * disagree about the same venue on the same morning
 * (UX-AUDIT-NON-TECHNICAL.md finding 1). The tiles and the activity feed
 * now read the same canonical functions /today reads — `getDailyList`
 * and `getVenueOverview`, through /api/intel/canonical/daily-list — and
 * the per-venue table reads the spine directly. Two surfaces, one
 * number.
 *
 * The one number that did NOT survive the move is booked revenue:
 * `weddings.booking_value` has no spine column, so rather than keep one
 * legacy read alive for it the tile says where revenue does live. See
 * the note beside the tile.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Mail, FileCheck, Newspaper, Heart,
  TrendingUp, ArrowRight, Building2, Layers, MapPin,
  BarChart3, Upload, MessageCircle, Users,
} from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'
import { MarketContextCard } from '@/components/intel/market-context-card'
import { InsightFeed } from '@/components/intel/insight-feed'
import { BrainDumpQueue } from '@/components/portal/brain-dump-queue'
import { UpcomingMeetings } from '@/components/platform/upcoming-meetings'
import { PostOnboardingChecklist } from '@/components/shell/post-onboarding-checklist'
import { HoneybookStaleBanner } from '@/components/shell/honeybook-stale-banner'
import { useCanonicalDaily } from '../intel/_canonical/triage-rail'
import {
  loadUpcomingWeddings,
  loadVenueCoupleCounts,
} from '@/lib/intel/readers/venue-spine-counts'
import { agoPhrase } from '@/lib/copy/client-terms'
import { useNow } from '@/lib/hooks/use-now'

interface Stats {
  upcomingWeddings: number
  pendingDrafts: number
  aiCost: number
  totalVenues: number
}

interface VenueRow {
  id: string
  name: string
  newEnquiries: number
  inConversation: number
  booked: number
  goneQuiet: number
}

export default function DashboardPage() {
  const scope = useScope()
  const router = useRouter()
  // One clock for the activity feed's "ago" labels, ticking while the
  // tab is open. Read through the hook because a bare Date.now() in the
  // render body is an impure read the compiler rejects.
  const now = useNow()

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
    upcomingWeddings: 0,
    pendingDrafts: 0,
    aiCost: 0,
    totalVenues: 0,
  })
  const [venueBreakdown, setVenueBreakdown] = useState<VenueRow[]>([])
  const [loading, setLoading] = useState(true)

  // The canonical readers, scope-resolved server-side. Same call
  // /agent/leads and /agent/pipeline make, and the same two functions
  // /today calls — so "needs a reply" is one number with one definition
  // across all four surfaces.
  const {
    daily,
    overview,
    loading: canonicalLoading,
    error: canonicalError,
  } = useCanonicalDaily()

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

      const now = new Date()

      // ---- Pending drafts ----
      const draftsQ = supabase
        .from('drafts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
      const { count: draftCount } = await withVenueFilter(draftsQ as never)

      // ---- AI cost this month ----
      // api_costs is telemetry, so created_at IS the event column here.
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
      const costQ = supabase
        .from('api_costs')
        .select('cost')
        .gte('created_at', monthStart)
      const { data: costData } = await withVenueFilter(costQ as never) as { data: Array<{ cost: number | null }> | null }
      const totalCost = (costData ?? []).reduce((sum, r) => sum + (r.cost ?? 0), 0)

      // ---- The venues in scope ----
      let resolvedVenueIds = venueIds ?? []
      let venuesData: Array<{ id: string; name: string }> = []
      if (scope.level !== 'venue') {
        let venuesQ = supabase.from('venues').select('id, name')
        if (venueIds && venueIds.length > 0) {
          venuesQ = venuesQ.in('id', venueIds)
        } else if (scope.orgId) {
          venuesQ = venuesQ.eq('org_id', scope.orgId)
        }
        const { data } = await venuesQ as { data: Array<{ id: string; name: string }> | null }
        venuesData = data ?? []
        resolvedVenueIds = venuesData.map((v) => v.id)
      }

      // ---- Weddings coming up, off the spine ----
      // couples.wedding_date, not weddings.wedding_date. Same question,
      // asked of the table that now receives every channel.
      const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      let upcomingCount = 0
      if (resolvedVenueIds.length > 0) {
        try {
          const upcoming = await loadUpcomingWeddings(
            supabase,
            resolvedVenueIds,
            now.toISOString().split('T')[0],
            thirtyDays.toISOString().split('T')[0],
          )
          upcomingCount = upcoming.count
        } catch (err) {
          console.error('[dashboard] upcoming weddings failed:', err)
        }
      }

      // ---- Per-venue breakdown (only at group/company scope) ----
      // Couples by lifecycle, the same vocabulary the tiles and /today
      // use. Revenue per venue is deliberately absent: booking value
      // lives only on the legacy `weddings` row and has no spine column,
      // so there is nothing honest to put in that column yet.
      let breakdown: VenueRow[] = []
      const venueCount = scope.level === 'venue' ? 1 : venuesData.length
      if (scope.level !== 'venue' && venuesData.length > 0) {
        try {
          const counts = await loadVenueCoupleCounts(supabase, resolvedVenueIds)
          const byId = new Map(counts.byVenue.map((v) => [v.venueId, v]))
          breakdown = venuesData
            .map((v) => {
              const c = byId.get(v.id)
              return {
                id: v.id,
                name: v.name,
                newEnquiries: c?.byLifecycle.channel_scoped ?? 0,
                inConversation: c?.byLifecycle.resolved ?? 0,
                booked: c?.byLifecycle.booked ?? 0,
                goneQuiet: c?.byLifecycle.ghost ?? 0,
              }
            })
            .sort((a, b) => b.booked - a.booked || b.inConversation - a.inConversation)
        } catch (err) {
          console.error('[dashboard] venue breakdown failed:', err)
        }
      }

      setStats({
        upcomingWeddings: upcomingCount,
        pendingDrafts: draftCount ?? 0,
        aiCost: totalCost,
        totalVenues: venueCount,
      })
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
  //
  // Everything on this row that is about couples comes from the two
  // canonical readers. "Needs a reply" is `daily.needsReply`, which is
  // the same array /today counts in its first block — not a second count
  // of the same thing with a different rule.
  const lifecycle = overview?.couples.byLifecycle
  const statCards: Array<{
    label: string
    value: React.ReactNode
    icon: typeof Mail
    color: string
    bg: string
  }> = [
    {
      label: 'Needs a reply',
      value: daily?.needsReply.length ?? 0,
      icon: MessageCircle,
      color: 'text-sky-600',
      bg: 'bg-sky-50',
    },
    {
      label: 'In conversation',
      value: lifecycle?.resolved ?? 0,
      icon: Users,
      color: 'text-sage-600',
      bg: 'bg-sage-50',
    },
    {
      label: 'New enquiries',
      value: lifecycle?.channel_scoped ?? 0,
      icon: Mail,
      color: 'text-teal-600',
      bg: 'bg-teal-50',
    },
    {
      label: 'Booked',
      value: lifecycle?.booked ?? 0,
      icon: TrendingUp,
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
    },
    {
      label: 'Weddings (30d)',
      value: stats.upcomingWeddings,
      icon: Heart,
      color: 'text-rose-600',
      bg: 'bg-rose-50',
    },
    {
      label: 'Drafts waiting',
      value: stats.pendingDrafts,
      icon: FileCheck,
      color: 'text-gold-600',
      bg: 'bg-amber-50',
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

  // The couple tiles wait on the canonical read, the rest on the local
  // one. Showing a real 0 while the reader is still in flight would be a
  // lie that lasts half a second and gets believed.
  const tilesLoading = loading || canonicalLoading

  /** Eight most recent touchpoints. The reader returns twelve; the panel
   *  has always shown eight. */
  const recentActivity = (overview?.recentActivity ?? []).slice(0, 8)

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

      {/* Stale HoneyBook re-import nudge — surfaces only when the venue
          already has HoneyBook-sourced weddings AND the most recent one
          is 30+ days old. Mutually exclusive with the post-onboarding
          checklist's HoneyBook row, which only renders when count is zero. */}
      <HoneybookStaleBanner />

      {/* Post-onboarding checklist — Calendly / HoneyBook / voice / team /
          signature. Renders only at venue scope and only when at least
          one item is incomplete. Auto-hides for 7 days when dismissed. */}
      {scope.level === 'venue' && scope.venueId && (
        <PostOnboardingChecklist venueId={scope.venueId} />
      )}

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
                {tilesLoading ? (
                  <span className="inline-block w-10 h-6 bg-sage-100 rounded animate-pulse" />
                ) : (
                  card.value
                )}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* The canonical read is what four of these tiles stand on. If it
          failed, say so instead of leaving zeroes on the screen looking
          like a quiet week. */}
      {canonicalError && !canonicalLoading && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Your couple counts would not load just now.</p>
          <p className="mt-1 text-amber-800">
            The tiles above that count couples are showing zero because nothing came back, not
            because nothing is there. Refresh the page, and if it keeps happening the alerts page
            will say what broke.
          </p>
          <Link href="/pulse" className="mt-2 inline-block font-medium underline">
            Open the alerts page
          </Link>
        </div>
      )}

      {/* Where booked revenue went. Named rather than quietly dropped:
          booking value lives on the legacy wedding row and has no column
          on the identity spine, so this page cannot answer it without
          reintroducing the read the rest of the tiles just retired. */}
      <p className="text-xs text-muted">
        Revenue is not on this page. It is the one figure the identity spine cannot answer yet, so
        it lives on{' '}
        <Link href="/intel/roi" className="underline hover:text-sage-700">
          Your Impact
        </Link>{' '}
        until it does.
      </p>

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
                  <th className="py-2 px-4 text-right">New enquiries</th>
                  <th className="py-2 px-4 text-right">In conversation</th>
                  <th className="py-2 px-4 text-right">Booked</th>
                  <th className="py-2 pl-4 text-right">Gone quiet</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {venueBreakdown.map((v) => (
                  <tr key={v.id} className="hover:bg-sage-50/40">
                    <td className="py-3 pr-4 font-medium text-sage-800">{v.name}</td>
                    <td className="py-3 px-4 text-right tabular-nums text-sage-700">{v.newEnquiries}</td>
                    <td className="py-3 px-4 text-right tabular-nums text-sage-700">{v.inConversation}</td>
                    <td className="py-3 px-4 text-right tabular-nums font-semibold text-sage-900">{v.booked}</td>
                    <td className="py-3 pl-4 text-right tabular-nums text-sage-600">{v.goneQuiet}</td>
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
          {/* The feed is `overview.recentActivity` — the latest
              touchpoints, summarised by the canonical reader. It used to
              be the latest `interactions` rows ordered by `created_at`,
              which put a six-month backfill at the top of the list the
              morning after an import. */}
          {canonicalLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-sage-50 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : canonicalError ? (
            <p className="text-sm text-amber-800 py-8 text-center">
              This feed would not load just now. Nothing is lost; refresh the page.
            </p>
          ) : recentActivity.length === 0 ? (
            <p className="text-sm text-muted py-8 text-center">
              Nothing has come in yet. Messages, tours and form submissions will appear here as
              they land.
            </p>
          ) : (
            <ul className="space-y-3">
              {recentActivity.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-3 p-3 rounded-lg bg-sage-50/50"
                >
                  <div className="w-2 h-2 mt-2 rounded-full bg-sage-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-sage-800 line-clamp-1">{a.summary}</p>
                    <p className="text-xs text-muted mt-0.5">
                      {agoPhrase(a.occurredAt, now) ?? 'time not recorded'}
                    </p>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-sage-500 bg-sage-100 px-2 py-0.5 rounded-full shrink-0">
                    {a.kind}
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
