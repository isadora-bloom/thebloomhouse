'use client'

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createBrowserClient } from '@supabase/ssr'
import {
  BarChart3,
  DollarSign,
  TrendingUp,
  ArrowUpDown,
  Megaphone,
  Award,
  AlertTriangle,
  Activity,
  ArrowRight,
  Layers,
  ChevronRight,
} from 'lucide-react'
import { InsightPanel, type InsightItem } from '@/components/intel/insight-panel'
import { InlineInsightBanner } from '@/components/intel/inline-insight-banner'
import { VenueChip } from '@/components/intel/venue-chip'
import { SpendImporter } from '@/components/intel/spend-importer'
import { ReEngagementROIPanel } from '@/components/intel/ReEngagementROIPanel'
import {
  formatSourceLabel,
  isUntrackedKey,
  UNTRACKED_LABEL,
  UNTRACKED_TOOLTIP,
} from '@/lib/utils/format-source-label'
import { formatCents } from '@/lib/types/monetary'
import Link from 'next/link'
import {
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

/** T5-Rixey-JJJ: weddings rollup row used by the page to compute Total
 *  Revenue + augment the Source Comparison table with bookings that
 *  have no wedding_touchpoints (e.g. HoneyBook bookings imported
 *  before the touchpoint pipeline existed).
 *
 *  Renamed from WeddingRollupRow → WeddingRollupAgg in JJJ because the
 *  shape changed: it's now ONE row per (source_key, venue_id) returned
 *  by the server-side endpoint, not per-wedding. The browser-side
 *  weddings query was removed — RLS denied the cross-venue + logged-out
 *  reads and the page silently displayed $0 revenue.
 *
 *  source_key is snake_case (server keeps the raw key — coordinator
 *  formatting happens client-side via formatSourceLabel). NULL DB
 *  values arrive as 'unknown'.
 *
 *  revenue_cents is CENTS (Bloom money convention).
 */
interface WeddingRollupAgg {
  source_key: string
  venue_id: string
  venue_name: string
  bookings: number
  revenue_cents: number
}

interface WeddingRollupApiResponse {
  rows?: WeddingRollupAgg[]
  totals?: { bookings: number; revenue_cents: number }
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
// Source label mapping — single source of truth in
// src/lib/utils/format-source-label (T5-Rixey-UU Bug E + T5-Rixey-DDD).
// Stream DDD hoisted UNTRACKED_LABEL / UNTRACKED_TOOLTIP / isUntrackedKey
// out of this page-local code so every render site shares the rule.
// `formatSourceLabel` itself now returns UNTRACKED_LABEL for null /
// empty / 'unknown' / '(unknown)' inputs, so the local `formatSource`
// wrapper that previously branched on isUntrackedKey is unnecessary —
// just call formatSourceLabel directly.
//
// We keep a thin `formatSource` alias so the legions of call sites
// below don't need a sweep, but the function is now a 1-line passthrough.
// ---------------------------------------------------------------------------

function formatSource(source: string | null | undefined): string {
  return formatSourceLabel(source)
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

// SOURCE_COLORS is keyed on the FORMATTED label (output of
// formatSourceLabel). T5-Rixey-UU Bug E migrated 'Wedding Wire' →
// 'WeddingWire' (spec) and added 'Referral' in addition to
// 'Word of Mouth'. Both keys are kept so legacy snapshots still
// resolve a colour.
const SOURCE_COLORS: Record<string, string> = {
  'The Knot':             '#E8927C',
  'WeddingWire':          '#7EAAA0',
  'Wedding Wire':         '#7EAAA0',
  'Google':               '#A6894A',
  'Google Business':      '#A6894A',
  'Google Ads':           '#A6894A',
  'Instagram':            '#C084A0',
  'Pinterest':            '#C084A0',
  'Word of Mouth':        '#7D8471',
  'Referral':             '#7D8471',
  'Direct':               '#5D7A7A',
  'Website':              '#8FA48D',
  'Website Form':         '#8FA48D',
  'Walk-in':              '#B29A6A',
  'Facebook':             '#6A89B7',
  'Zola':                 '#9B8EC4',
  'Phone':                '#C99B7A',
  'Calendly':             '#5C8DBC',
  'Acuity':               '#7AA9B7',
  'HoneyBook':            '#D4A24C',
  'Dubsado':              '#D4A24C',
  'Here Comes The Guide': '#B287C2',
  'Venue Calculator':     '#9D8B6E',
  'Other':                '#9AA098',
  'Unknown':              '#9AA098',
  // T5-Rixey-VV Y6: same warm-grey as Other/Unknown, since this is the
  // "we couldn't attribute" bucket.
  [UNTRACKED_LABEL]:      '#9AA098',
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
// Phase B intel panels — Phase C / PC.2 (2026-04-29)
// Three candidate-driven panels that read from Phase B's tables:
//   1. Conflict alert tile — live count of attribution conflicts.
//   2. Non-converting high-funnel cohort — candidates that engaged
//      deeply (funnel_depth >= 3) but never resolved to a wedding.
//      Coordinator-actionable list.
//   3. Multi-touch split — for booked weddings, how many distinct
//      platforms contributed first-touch + nurture signals.
// ---------------------------------------------------------------------------

interface PhaseBPanelsProps {
  scope: ReturnType<typeof useScope>
  windowDays: ScorecardWindow
  // T5-Rixey-LLL B9: multi-touch panel runs on its OWN window
  // (different question — "of all my booked weddings, how multi-
  // platform was the journey?" wants a long lifetime view, not
  // the tactical 90d the scorecard uses).
  multiTouchWindowDays: MultiTouchWindow
  onMultiTouchWindowChange: (w: MultiTouchWindow) => void
}

// T5-Rixey-LLL B9: independent window for the Multi-touch Split panel.
// Same option set as the scorecard but a separate type so the two can't
// accidentally cross-couple. 'all' projects to a far-past iso (effectively
// no lower bound) for the attribution_events query.
type MultiTouchWindow = 90 | 365 | 'all'

interface NonConvertingRow {
  id: string
  source_platform: string
  first_name: string | null
  last_initial: string | null
  state: string | null
  signal_count: number
  funnel_depth: number
  action_counts: Record<string, number> | null
  last_seen: string | null
  cluster_group_key: string | null
}

interface MultiTouchBucket {
  platforms: number // distinct platform count
  weddings: number  // weddings in this bucket
  pct: number
}

// Wedding sources where we ingest engagement signals via the
// candidate-identity pipeline. If a wedding lists one of these as
// its source but no candidate resolves to it, that's the
// "automated batch lead" pattern — Knot/WeddingWire forwarded
// contact details from a search-form fill rather than a profile-
// engaged prospect (2026-04-30).
const TRACKED_PLATFORM_SOURCES_FOR_FLAG = [
  'the_knot',
  'wedding_wire',
  'instagram',
  'pinterest',
  'google_business',
  'facebook',
] as const

function PhaseBIntelPanels({ scope, windowDays, multiTouchWindowDays, onMultiTouchWindowChange }: PhaseBPanelsProps) {
  const [conflictCount, setConflictCount] = useState<number | null>(null)
  const [batchLeadCount, setBatchLeadCount] = useState<number | null>(null)
  const [nonConverting, setNonConverting] = useState<NonConvertingRow[]>([])
  const [multiTouch, setMultiTouch] = useState<MultiTouchBucket[]>([])
  const [bookedAttributed, setBookedAttributed] = useState<number>(0)
  // PC.4 fix #7: don't enter loading state at non-venue scope —
  // before this, the skeleton flashed for a frame at portfolio
  // scope before the panel evaporated.
  const isVenueScope = scope.level === 'venue' && Boolean(scope.venueId)
  const [loading, setLoading] = useState(isVenueScope)
  const [multiTouchLoading, setMultiTouchLoading] = useState(isVenueScope)

  useEffect(() => {
    if (scope.loading) return
    if (!isVenueScope) {
      setLoading(false)
      setConflictCount(0)
      setBatchLeadCount(0)
      setNonConverting([])
      return
    }
    let cancelled = false
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )
    const windowStartIso = new Date(Date.now() - windowDays * 86_400_000).toISOString()

    ;(async () => {
      setLoading(true)
      const venueId = scope.venueId!

      const [conflictRes, cohortRes] = await Promise.all([
        // 1. Conflict count.
        sb
          .from('attribution_events')
          .select('id', { count: 'exact', head: true })
          .eq('venue_id', venueId)
          .not('conflict_with_legacy_source', 'is', null)
          .is('reverted_at', null),
        // 2. Non-converting high-funnel cohort. PC.4 fix #3: exclude
        //    candidates the coordinator already dismissed. Window-
        //    bound by last_seen so the panel scopes consistently
        //    with the rest of the page.
        sb
          .from('candidate_identities')
          .select('id, source_platform, first_name, last_initial, state, signal_count, funnel_depth, action_counts, last_seen, cluster_group_key')
          .eq('venue_id', venueId)
          .gte('funnel_depth', 3)
          .is('resolved_wedding_id', null)
          .is('deleted_at', null)
          .neq('review_status', 'reviewed')
          .gte('last_seen', windowStartIso)
          .order('last_seen', { ascending: false })
          .limit(25),
      ])

      if (cancelled) return

      setConflictCount(conflictRes.count ?? 0)
      setNonConverting((cohortRes.data ?? []) as NonConvertingRow[])

      // Batch-lead count: weddings on a tracked platform with no
      // candidate resolved on that same platform. Two-query approach
      // since PostgREST doesn't expose NOT EXISTS subselects cleanly:
      //   (a) fetch IDs of tracked-source weddings in window
      //   (b) fetch resolved_wedding_ids from candidate_identities
      //   matching those wedding source platforms
      //   (c) diff in memory
      const { data: trackedSourceWeddings } = await sb
        .from('weddings')
        .select('id, source')
        .eq('venue_id', venueId)
        .in('source', TRACKED_PLATFORM_SOURCES_FOR_FLAG as unknown as string[])
        .gte('inquiry_date', windowStartIso)
      const trackedRows = (trackedSourceWeddings ?? []) as Array<{ id: string; source: string }>
      let batchLeads = 0
      if (trackedRows.length > 0) {
        const trackedIds = trackedRows.map((r) => r.id)
        const CHUNK = 100
        const resolvedSet = new Set<string>() // wedding_id|source pairs
        for (let i = 0; i < trackedIds.length; i += CHUNK) {
          const chunk = trackedIds.slice(i, i + CHUNK)
          const { data: cands } = await sb
            .from('candidate_identities')
            .select('resolved_wedding_id, source_platform')
            .in('resolved_wedding_id', chunk)
            .is('deleted_at', null)
          for (const c of (cands ?? []) as Array<{ resolved_wedding_id: string; source_platform: string }>) {
            resolvedSet.add(`${c.resolved_wedding_id}|${c.source_platform}`)
          }
        }
        for (const w of trackedRows) {
          if (!resolvedSet.has(`${w.id}|${w.source}`)) batchLeads++
        }
      }
      if (cancelled) return
      setBatchLeadCount(batchLeads)
      setLoading(false)
    })()

    return () => { cancelled = true }
  }, [scope.level, scope.venueId, scope.loading, isVenueScope, windowDays])

  // T5-Rixey-LLL B9: multi-touch panel runs on its OWN window — separate
  // effect so flipping the panel's selector doesn't refetch the conflict
  // count / non-converting cohort / batch-lead diff.
  useEffect(() => {
    if (scope.loading) return
    if (!isVenueScope) {
      setMultiTouchLoading(false)
      setMultiTouch([])
      setBookedAttributed(0)
      return
    }
    let cancelled = false
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )
    // 'all' → effectively no lower bound (epoch-ish iso) so the
    // attribution_events query covers full venue history.
    const mtWindowStartIso = multiTouchWindowDays === 'all'
      ? new Date(0).toISOString()
      : new Date(Date.now() - multiTouchWindowDays * 86_400_000).toISOString()

    ;(async () => {
      setMultiTouchLoading(true)
      const venueId = scope.venueId!

      // Multi-touch — window-bound by decided_at. PC.4 fix #4.
      const { data: attribData } = await sb
        .from('attribution_events')
        .select('wedding_id, source_platform')
        .eq('venue_id', venueId)
        .is('reverted_at', null)
        .gte('decided_at', mtWindowStartIso)

      if (cancelled) return

      // Multi-touch grouping: count distinct platforms per wedding.
      const platformsByWedding = new Map<string, Set<string>>()
      for (const e of ((attribData ?? []) as Array<{ wedding_id: string; source_platform: string }>)) {
        const set = platformsByWedding.get(e.wedding_id) ?? new Set<string>()
        set.add(e.source_platform)
        platformsByWedding.set(e.wedding_id, set)
      }
      // Filter to BOOKED weddings so this matches what coordinators
      // care about — "of the leads that became real customers, how
      // multi-platform was their journey?" Need to fetch wedding
      // statuses for the IDs.
      const weddingIds = Array.from(platformsByWedding.keys())
      const bookedSet = new Set<string>()
      if (weddingIds.length > 0) {
        const CHUNK = 100
        for (let i = 0; i < weddingIds.length; i += CHUNK) {
          const chunk = weddingIds.slice(i, i + CHUNK)
          const { data } = await sb
            .from('weddings')
            .select('id, status')
            .in('id', chunk)
            .in('status', ['booked', 'completed'])
          for (const w of ((data ?? []) as Array<{ id: string }>)) {
            bookedSet.add(w.id)
          }
        }
      }

      if (cancelled) return

      const bucketCounts = new Map<number, number>()
      for (const wid of bookedSet) {
        const platforms = platformsByWedding.get(wid)?.size ?? 0
        if (platforms === 0) continue
        bucketCounts.set(platforms, (bucketCounts.get(platforms) ?? 0) + 1)
      }
      const total = bookedSet.size
      const buckets: MultiTouchBucket[] = []
      const sortedKeys = Array.from(bucketCounts.keys()).sort((a, b) => a - b)
      for (const k of sortedKeys) {
        const c = bucketCounts.get(k)!
        buckets.push({ platforms: k, weddings: c, pct: total > 0 ? c / total : 0 })
      }
      setMultiTouch(buckets)
      setBookedAttributed(total)
      setMultiTouchLoading(false)
    })()

    return () => { cancelled = true }
  }, [scope.level, scope.venueId, scope.loading, isVenueScope, multiTouchWindowDays])

  if (scope.level !== 'venue') {
    return null
  }
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="h-48 bg-sage-50 rounded-xl animate-pulse" />
        <div className="h-48 bg-sage-50 rounded-xl animate-pulse" />
      </div>
    )
  }
  // T5-Rixey-LLL B9: previously this section short-circuited when
  // every tile was empty (incl. multiTouch.length === 0). The
  // multi-touch panel now owns its own window selector, so always
  // render at venue scope — the coordinator must be able to toggle
  // 90d → 1y → All time even when the current window has zero
  // buckets. `MultiTouchSplitPanel` itself renders an explanatory
  // empty state (with the selector visible) when buckets are empty.

  return (
    <div className="space-y-4">
      {(conflictCount ?? 0) > 0 && (
        <Link
          href="/intel/candidates"
          className="block bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 hover:bg-amber-100/60 transition-colors"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-900">
                {conflictCount} attribution conflict{conflictCount === 1 ? '' : 's'} need review
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                Computed first-touch disagrees with the legacy lead source. Open the candidate review queue to decide which is right.
              </p>
            </div>
            <ArrowRight className="w-4 h-4 text-amber-600 shrink-0" />
          </div>
        </Link>
      )}

      {(batchLeadCount ?? 0) > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-900">
                {batchLeadCount} likely batch lead{batchLeadCount === 1 ? '' : 's'} (no platform engagement)
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                Weddings sourced from a tracked platform (Knot, WW, IG, etc.) but with zero matching engagement signal. Often automated batch leads from a search-form fill rather than profile-engaged prospects. Each affected lead detail page shows the warning.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <NonConvertingCohortPanel rows={nonConverting} />
        <MultiTouchSplitPanel
          buckets={multiTouch}
          totalBooked={bookedAttributed}
          windowDays={multiTouchWindowDays}
          onWindowChange={onMultiTouchWindowChange}
          loading={multiTouchLoading}
        />
      </div>
    </div>
  )
}

function NonConvertingCohortPanel({ rows }: { rows: NonConvertingRow[] }) {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b border-border">
        <h3 className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2">
          <Activity className="w-4 h-4 text-sage-600" />
          Engaged but didn't inquire
        </h3>
        <p className="text-xs text-sage-500 mt-0.5">
          High-funnel candidates (depth ≥ 3) on platforms that never sent an inquiry. Re-engage candidates here.
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-center text-xs text-sage-500">
          No high-funnel non-converting candidates. Either everyone engaged is converting, or the platform isn't deep yet.
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto divide-y divide-border">
          {rows.map((c) => (
            <div key={c.id} className="px-5 py-2 flex items-center gap-3 text-xs hover:bg-sage-50/50">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-sage-900 truncate">
                  {c.first_name} {c.last_initial}.
                  {c.state && <span className="text-sage-500 font-normal ml-1">({c.state.toUpperCase()})</span>}
                </p>
                <p className="text-[11px] text-sage-500">
                  {formatSource(c.source_platform)} · depth {c.funnel_depth} · {c.signal_count} signal{c.signal_count === 1 ? '' : 's'} · last{' '}
                  {c.last_seen ? new Date(c.last_seen).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—'}
                </p>
                {c.action_counts && Object.keys(c.action_counts).length > 0 && (
                  <p className="text-[10px] text-sage-400 mt-0.5">
                    {Object.entries(c.action_counts).map(([k, v]) => `${v} ${k}`).join(' · ')}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MultiTouchSplitPanel({
  buckets,
  totalBooked,
  windowDays,
  onWindowChange,
  loading,
}: {
  buckets: MultiTouchBucket[]
  totalBooked: number
  // T5-Rixey-LLL B9
  windowDays: MultiTouchWindow
  onWindowChange: (w: MultiTouchWindow) => void
  loading: boolean
}) {
  const windowLabel =
    windowDays === 90 ? 'last 90 days' : windowDays === 365 ? 'last 1 year' : 'all time'
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2">
            <Layers className="w-4 h-4 text-sage-600" />
            Multi-touch journey split
          </h3>
          {/* T5-Rixey-LLL B9: independent window — coordinators usually
              want the lifetime view here, not the 90d the scorecard
              uses. Default 1y (set at the page level). */}
          <select
            value={String(windowDays)}
            onChange={(e) => {
              const v = e.target.value
              const next: MultiTouchWindow = v === 'all' ? 'all' : (parseInt(v, 10) as MultiTouchWindow)
              onWindowChange(next)
            }}
            className="text-xs border border-sage-200 rounded-md px-2 py-1 bg-surface text-sage-700"
            title="Window for the multi-touch coverage view (independent of the Source Quality scorecard window)"
          >
            <option value="90">90d</option>
            <option value="365">1y</option>
            <option value="all">All time</option>
          </select>
        </div>
        <p className="text-xs text-sage-500 mt-0.5">
          Of {totalBooked} booked lead{totalBooked === 1 ? '' : 's'} with platform-signal coverage in the {windowLabel}, how many distinct platforms each touched.
        </p>
      </div>
      {loading ? (
        <div className="px-5 py-6">
          <div className="h-3 bg-sage-50 rounded animate-pulse mb-2" />
          <div className="h-3 bg-sage-50 rounded animate-pulse mb-2 w-3/4" />
          <div className="h-3 bg-sage-50 rounded animate-pulse w-1/2" />
        </div>
      ) : buckets.length === 0 ? (
        <div className="px-5 py-6 text-center text-xs text-sage-500">
          No booked weddings have platform-signal attribution in this window. Try widening to 1 year or All time, or wait for Phase B matches to ramp up.
        </div>
      ) : (
        <div className="px-5 py-4 space-y-2">
          {buckets.map((b) => (
            <div key={b.platforms} className="flex items-center gap-3 text-xs">
              <span className="w-20 shrink-0 text-sage-700 font-medium">
                {b.platforms} platform{b.platforms === 1 ? '' : 's'}
              </span>
              <div className="flex-1 h-2.5 bg-sage-50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-sage-500 rounded-full"
                  style={{ width: `${(b.pct * 100).toFixed(1)}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right text-sage-700 tabular-nums">
                {b.weddings} · {(b.pct * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      )}
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
  avgDaysToBook: number | null
  // Phase C / PC.1 — candidate funnel + CAC fields. May be 0 / null
  // when the scope has no Phase B data yet (no signals imported).
  signalsDelivered: number
  candidatesCreated: number
  avgFunnelDepth: number
  autoLinkRate: number
  firstTouchLeads: number
  firstTouchTours: number
  firstTouchBookings: number
  spendInWindow: number
  costPerLead: number | null
  costPerTour: number | null
  costPerBooking: number | null
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
  | 'avgDaysToBook'
  | 'signalsDelivered'
  | 'candidatesCreated'
  | 'avgFunnelDepth'
  | 'autoLinkRate'
  | 'firstTouchLeads'
  | 'firstTouchTours'
  | 'firstTouchBookings'
  | 'spendInWindow'
  | 'costPerLead'
  | 'costPerTour'
  | 'costPerBooking'

type ScorecardViewMode = 'quality' | 'funnel' | 'cac'
type ScorecardWindow = 30 | 90 | 365 | 3650

interface ScorecardProps {
  scope: ReturnType<typeof useScope>
  windowDays: ScorecardWindow
  onWindowChange: (w: ScorecardWindow) => void
}

function SourceQualityScorecard({ scope, windowDays, onWindowChange }: ScorecardProps) {
  const [rows, setRows] = useState<QualityApiRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<QualitySortKey>('bookedCount')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  // At group/company scope, default to the cross-venue rollup so the
  // coordinator sees portfolio-level "Knot's avg booking value" rather
  // than one row per (venue, source). At venue scope the toggle is
  // hidden — there's nothing to roll up.
  const [aggregate, setAggregate] = useState<boolean>(scope.level !== 'venue')
  // Phase C / PC.1: view-mode tabs. Window state is owned by the
  // parent page (PC.4 fix) so multi-touch + non-converting cohort
  // panels stay in sync with the scorecard's window.
  const [viewMode, setViewMode] = useState<ScorecardViewMode>('quality')

  // If the scope changes (single venue -> portfolio) the default flips.
  useEffect(() => {
    setAggregate(scope.level !== 'venue')
  }, [scope.level])

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
        if (aggregate && scope.level !== 'venue') {
          params.set('aggregate', 'cross_venue')
        }
        params.set('window', String(windowDays))
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
  }, [scope.level, scope.venueId, scope.groupId, scope.orgId, scope.loading, aggregate, windowDays])

  function handleSort(key: QualitySortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  // PC.4 fix #2: in Quality view, hide rows that have 0 bookings.
  // PC.1 added rows for any source with signals/candidates/spend even
  // without bookings — that's correct for Funnel/CAC but pollutes
  // Quality with all-zeros rows.
  const filteredForView = viewMode === 'quality'
    ? rows.filter((r) => r.bookedCount > 0)
    : rows
  const sortedRows = [...filteredForView].sort((a, b) => {
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
      <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
            <Award className="w-5 h-5 text-sage-600" />
            Source Quality
          </h2>
          <p className="text-xs text-sage-500 mt-1">
            {viewMode === 'quality'
              ? 'Quality-of-lead signals per source, measured from weddings that actually booked inside the window. Higher review scores, lower friction, and faster time-to-book mean better-fit couples. Booked counts here use the legacy leads.source field.'
              : viewMode === 'funnel'
              ? 'Volume → engagement → conversion across platform signals. Funnel depth ≥3 = audience routinely reaches the message tier; high link rate = candidates who became real leads. Counts use first-touch attribution and may differ from Quality view.'
              : 'Cost-per acquisition by stage, using first-touch attribution.  $/booking is the bottom-line CAC;  $/tour and  $/lead show where each platform stops paying off. Lead/tour/booking counts here use first-touch attribution; Quality view uses the legacy leads.source field — small differences are expected.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Phase C / PC.1: view mode selector. */}
          <div className="flex items-center bg-sage-50 rounded-lg p-0.5 text-xs shrink-0">
            {(['quality', 'funnel', 'cac'] as ScorecardViewMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`px-3 py-1 rounded-md font-medium transition-colors capitalize ${
                  viewMode === mode ? 'bg-surface text-sage-900 shadow-sm' : 'text-sage-500 hover:text-sage-700'
                }`}
                title={
                  mode === 'quality'
                    ? 'Quality of leads that booked from each source'
                    : mode === 'funnel'
                    ? 'Volume + depth + conversion from candidate signals'
                    : 'Spend / cost-per-lead / tour / booking (first-touch attribution)'
                }
              >
                {mode === 'cac' ? 'CAC' : mode}
              </button>
            ))}
          </div>
          {/* Time window selector. */}
          <select
            value={windowDays}
            onChange={(e) => onWindowChange(parseInt(e.target.value, 10) as ScorecardWindow)}
            className="text-xs border border-sage-200 rounded-md px-2 py-1.5 bg-surface text-sage-700"
            title="Time window applies to all three view modes plus the panels below"
          >
            <option value="30">Last 30d</option>
            <option value="90">Last 90d</option>
            <option value="365">Last 1y</option>
            <option value="3650">All time</option>
          </select>
          {scope.level !== 'venue' && (
            <div className="flex items-center bg-sage-50 rounded-lg p-0.5 text-xs shrink-0">
              <button
                onClick={() => setAggregate(true)}
                className={`px-3 py-1 rounded-md font-medium transition-colors ${
                  aggregate ? 'bg-surface text-sage-900 shadow-sm' : 'text-sage-500 hover:text-sage-700'
                }`}
                title="One row per source, weighted across the whole portfolio"
              >
                Portfolio
              </button>
              <button
                onClick={() => setAggregate(false)}
                className={`px-3 py-1 rounded-md font-medium transition-colors ${
                  !aggregate ? 'bg-surface text-sage-900 shadow-sm' : 'text-sage-500 hover:text-sage-700'
                }`}
                title="One row per (venue, source) so you can see which venue benefits from which channel"
              >
                By Venue
              </button>
            </div>
          )}
        </div>
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
              {(() => {
                const qualityCols: [QualitySortKey, string][] = [
                  ['source', 'Source'],
                  ['bookedCount', 'Booked'],
                  ['avgRevenue', 'Avg Revenue'],
                  ['avgDaysToBook', 'Days to Book'],
                  ['avgEmailsExchanged', 'Emails Exchanged'],
                  ['avgPortalActivity', 'Portal Activity'],
                  ['avgReviewScore', 'Review Score'],
                  ['referralCount', 'Referrals'],
                  ['frictionRate', 'Friction Rate'],
                ]
                const funnelCols: [QualitySortKey, string][] = [
                  ['source', 'Source'],
                  ['signalsDelivered', 'Signals'],
                  ['candidatesCreated', 'Candidates'],
                  ['avgFunnelDepth', 'Funnel Depth'],
                  ['autoLinkRate', 'Link Rate'],
                  ['firstTouchLeads', 'First-Touch Leads'],
                  ['firstTouchTours', 'Tours'],
                  ['firstTouchBookings', 'Bookings'],
                ]
                const cacCols: [QualitySortKey, string][] = [
                  ['source', 'Source'],
                  ['spendInWindow', 'Spend'],
                  ['firstTouchLeads', 'Leads'],
                  ['firstTouchTours', 'Tours'],
                  ['firstTouchBookings', 'Bookings'],
                  ['costPerLead', '$/Lead'],
                  ['costPerTour', '$/Tour'],
                  ['costPerBooking', '$/Booking'],
                ]
                const cols = viewMode === 'funnel' ? funnelCols : viewMode === 'cac' ? cacCols : qualityCols
                return cols
              })().map(([key, label]) => (
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
                <td colSpan={9} className="px-4 py-6 text-center text-sm text-sage-500">
                  {viewMode === 'quality'
                    ? 'Not enough booked weddings yet to score source quality. Need at least 2 bookings per source.'
                    : viewMode === 'funnel'
                    ? 'No platform signals yet in this window. Drop a CSV in the brain-dump capture to populate.'
                    : 'No spend recorded yet for this window. Add data at /intel/sources in the spend importer.'}
                </td>
              </tr>
            ) : (
              sortedRows.map((row, i) => {
                const isAggregateRow = row.venueId === '__aggregate__'
                const label = formatSource(row.source)
                const isUntracked = label === UNTRACKED_LABEL
                const sourceCell = (
                  <td className="px-4 py-3 font-medium text-sage-900 whitespace-nowrap">
                    <div
                      className="flex items-center gap-2"
                      title={isUntracked ? UNTRACKED_TOOLTIP : undefined}
                    >
                      <div
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: getSourceColor(label) }}
                      />
                      {label}
                      {scope.level !== 'venue' && !isAggregateRow && (
                        <VenueChip venueName={row.venueName} />
                      )}
                      {isAggregateRow && (
                        <span className="text-[10px] text-sage-400 font-normal">
                          · {row.venueName}
                        </span>
                      )}
                    </div>
                  </td>
                )
                return (
                  <tr
                    key={`${row.venueId}-${row.source}-${i}-${viewMode}`}
                    className="hover:bg-sage-50/30 transition-colors"
                  >
                    {sourceCell}
                    {viewMode === 'quality' && (
                      <>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{row.bookedCount}</td>
                        {/* T5-Rixey-VV Y1: source-quality API returns avgRevenue
                            in CENTS now (Stream RR doctrine). formatCents
                            handles the divide. */}
                        <td className="px-4 py-3 text-sage-700 tabular-nums font-medium">{formatCents(row.avgRevenue)}</td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">
                          {row.avgDaysToBook !== null ? `${Math.round(row.avgDaysToBook)} d` : '—'}
                        </td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{row.avgEmailsExchanged.toFixed(1)}</td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{row.avgPortalActivity.toFixed(1)}</td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">
                          {row.avgReviewScore !== null ? row.avgReviewScore.toFixed(2) : '—'}
                        </td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{row.referralCount}</td>
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
                      </>
                    )}
                    {viewMode === 'funnel' && (
                      <>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{fmtCount(row.signalsDelivered)}</td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{fmtCount(row.candidatesCreated)}</td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">
                          {row.candidatesCreated > 0 ? row.avgFunnelDepth.toFixed(1) : '—'}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {row.candidatesCreated > 0 ? (
                            <span className={`font-medium ${row.autoLinkRate >= 0.5 ? 'text-emerald-600' : row.autoLinkRate >= 0.2 ? 'text-sage-700' : 'text-red-600'}`}>
                              {fmtPct(row.autoLinkRate)}
                            </span>
                          ) : (
                            <span className="text-sage-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{row.firstTouchLeads}</td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{row.firstTouchTours}</td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{row.firstTouchBookings}</td>
                      </>
                    )}
                    {viewMode === 'cac' && (
                      <>
                        <td className="px-4 py-3 text-sage-700 tabular-nums font-medium">
                          {row.spendInWindow > 0 ? fmt$(row.spendInWindow) : '—'}
                        </td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{row.firstTouchLeads}</td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{row.firstTouchTours}</td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">{row.firstTouchBookings}</td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">
                          {row.costPerLead !== null ? fmt$(row.costPerLead) : '—'}
                        </td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums">
                          {row.costPerTour !== null ? fmt$(row.costPerTour) : '—'}
                        </td>
                        <td className="px-4 py-3 text-sage-700 tabular-nums font-medium">
                          {row.costPerBooking !== null ? fmt$(row.costPerBooking) : '—'}
                        </td>
                      </>
                    )}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model Comparison — side-by-side first / last / linear attribution
// ---------------------------------------------------------------------------

interface ModelComparisonProps {
  scope: ReturnType<typeof useScope>
}

function ModelComparisonCard({ scope }: ModelComparisonProps) {
  // Per-model rollups, keyed by attribution model. Each has the same
  // FunnelApiRow shape — just computed under a different attribution
  // contract. The card fetches all three in parallel; on a small
  // venue this is three quick queries totaling ~half a second.
  const [byModel, setByModel] = useState<{
    first_touch: FunnelApiRow[]
    last_touch: FunnelApiRow[]
    linear: FunnelApiRow[]
  }>({ first_touch: [], last_touch: [], linear: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [metric, setMetric] = useState<'bookings' | 'inquiries' | 'tour_conducted'>('bookings')

  useEffect(() => {
    if (scope.loading) return
    let cancelled = false
    async function load() {
      setLoading(true)
      const baseParams = new URLSearchParams()
      if (scope.level === 'venue' && scope.venueId) baseParams.set('venue_id', scope.venueId)
      else if (scope.level === 'group' && scope.groupId) baseParams.set('group_id', scope.groupId)
      else if (scope.orgId) baseParams.set('org_id', scope.orgId)

      try {
        const models: AttributionModel[] = ['first_touch', 'last_touch', 'linear']
        const results = await Promise.all(
          models.map(async (m) => {
            const p = new URLSearchParams(baseParams)
            p.set('model', m)
            const res = await fetch(`/api/intel/sources/funnel?${p.toString()}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = (await res.json()) as { rows?: FunnelApiRow[] }
            return [m, json.rows ?? []] as const
          })
        )
        if (cancelled) return
        const next = { first_touch: [], last_touch: [], linear: [] } as typeof byModel
        for (const [m, rows] of results) next[m] = rows
        setByModel(next)
        setError(null)
      } catch (err) {
        if (cancelled) return
        console.error('Failed to load model comparison:', err)
        setError('Failed to load model comparison')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [scope.level, scope.venueId, scope.groupId, scope.orgId, scope.loading])

  // Build a unified per-source table where each row carries the metric
  // value under each model. Source set is the union across models —
  // some sources only appear under last-touch (where they actually
  // closed) but not first-touch (because they never originated leads).
  const rows = useMemo(() => {
    const sources = new Set<string>()
    for (const m of ['first_touch', 'last_touch', 'linear'] as const) {
      for (const r of byModel[m]) {
        if (scope.level === 'venue' || r.source) sources.add(r.source ?? '(unknown)')
      }
    }
    function pick(model: AttributionModel, source: string): number {
      const matches = byModel[model].filter((r) => (r.source ?? '(unknown)') === source)
      return matches.reduce((sum, r) => {
        if (metric === 'bookings') return sum + r.bookings
        if (metric === 'inquiries') return sum + r.inquiries
        return sum + r.tours_conducted
      }, 0)
    }
    return [...sources].map((source) => {
      const ft = pick('first_touch', source)
      const lt = pick('last_touch', source)
      const lin = pick('linear', source)
      // Spread is the max-min divergence across models — highlights
      // sources where the choice of model matters most.
      const spread = Math.max(ft, lt, lin) - Math.min(ft, lt, lin)
      return { source, ft, lt, lin, spread }
    }).sort((a, b) => b.spread - a.spread || b.ft + b.lt + b.lin - (a.ft + a.lt + a.lin))
  }, [byModel, metric, scope.level])

  if (loading) return <TableSkeleton />

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
            <ArrowUpDown className="w-5 h-5 text-sage-600" />
            Compare Attribution Models
          </h2>
          <p className="text-xs text-sage-500 mt-1">
            How much does the choice of attribution model change the picture?
            Sources are sorted by widest divergence — the channels where the
            model you pick matters most.
          </p>
        </div>
        <div className="flex items-center bg-sage-50 rounded-lg p-0.5 text-xs shrink-0">
          {([
            ['inquiries', 'Inquiries'],
            ['tour_conducted', 'Tours'],
            ['bookings', 'Bookings'],
          ] as Array<[typeof metric, string]>).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setMetric(key)}
              className={`px-3 py-1 rounded-md font-medium transition-colors ${
                metric === key
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-500 hover:text-sage-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
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
              <th className="px-4 py-3 text-left font-medium text-sage-600">Source</th>
              <th className="px-4 py-3 text-right font-medium text-sage-600">First-touch</th>
              {/* T5-Rixey-VV Y5: relabel as "Last-touch tool" so users
                  understand scheduling/contracting tools (Calendly,
                  HoneyBook) showing up here are the LAST TOOL the lead
                  passed through, not a marketing channel. The math is
                  factually correct; only the column header was misleading. */}
              <th
                className="px-4 py-3 text-right font-medium text-sage-600"
                title="The most recent tool/source touched before booking. Includes scheduling tools (Calendly, HoneyBook) when those were the last thing the couple touched — they're tools, not channels, but they're factually the last touch."
              >
                Last-touch tool
              </th>
              <th className="px-4 py-3 text-right font-medium text-sage-600">Linear</th>
              <th className="px-4 py-3 text-right font-medium text-sage-600" title="Difference between max and min across models — bigger = model choice matters more">
                Spread
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-sage-500">
                  No attribution data yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                // T5-Rixey-VV Y6: route through formatSource so the
                // "(unknown)" sentinel from attribution.ts surfaces as
                // "Untracked / Pre-Bloom".
                const label = formatSource(row.source)
                return (
                  <tr key={row.source} className="hover:bg-sage-50/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-sage-900 whitespace-nowrap">
                      <div
                        className="flex items-center gap-2"
                        title={label === UNTRACKED_LABEL ? UNTRACKED_TOOLTIP : undefined}
                      >
                        <div
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: getSourceColor(label) }}
                        />
                        {label}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sage-700 tabular-nums">
                      {fmtCount(row.ft)}
                    </td>
                    <td className="px-4 py-3 text-right text-sage-700 tabular-nums">
                      {fmtCount(row.lt)}
                    </td>
                    <td className="px-4 py-3 text-right text-sage-700 tabular-nums">
                      {fmtCount(row.lin)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span
                        className={
                          row.spread === 0
                            ? 'text-sage-400'
                            : row.spread > 5
                            ? 'text-amber-700 font-semibold'
                            : 'text-sage-600'
                        }
                      >
                        {fmtCount(row.spread)}
                      </span>
                    </td>
                  </tr>
                )
              })
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
  // T5-Rixey-JJJ: weddings rollup now arrives PRE-AGGREGATED (one row
  // per source × venue) from a server-side endpoint that uses the
  // service-role client. The previous in-page browser fetch was bitten
  // by RLS and silently returned zero rows — Total Revenue showed $0
  // even though Rixey had $794K of HoneyBook revenue.
  const [weddingsRollup, setWeddingsRollup] = useState<WeddingRollupAgg[]>([])
  const [venueNameById, setVenueNameById] = useState<Map<string, string>>(new Map())
  const [model, setModel] = useState<AttributionModel>('first_touch')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('inquiries')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  // T5-Rixey-Wave-14-TTT: per-row expansion in the Source Comparison
  // table. Replaces the standalone "Cost per Booking by Source" bar
  // chart and "Funnel by Source" sub-cards — both were redrawing data
  // already present in the table row. Click the disclosure triangle on
  // a row to see the full inquiry → tour-booked → tour-held → proposal
  // → booked funnel + cost-per-booking math for that source.
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  // PC.4 fix #4: window state lifted to page so the scorecard,
  // multi-touch split, non-converting cohort, and conflict tile
  // all see the same window. Default 90d (locked).
  const [windowDays, setWindowDays] = useState<ScorecardWindow>(90)
  // T5-Rixey-LLL B9: independent window for the Multi-touch Split
  // panel. Default 1y (different question — coordinator wants the
  // lifetime view, not the tactical 90d). Persisted as URL param
  // `multitouch_window` so deep-links round-trip.
  const [multiTouchWindowDays, setMultiTouchWindowDays] = useState<MultiTouchWindow>(() => {
    if (typeof window === 'undefined') return 365
    const raw = new URLSearchParams(window.location.search).get('multitouch_window')
    if (raw === '90') return 90
    if (raw === '365') return 365
    if (raw === 'all') return 'all'
    return 365
  })
  // Mirror state into the URL on change. Use replaceState so we don't
  // pollute browser back-button history with every flip.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    url.searchParams.set('multitouch_window', String(multiTouchWindowDays))
    window.history.replaceState({}, '', url.toString())
  }, [multiTouchWindowDays])

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

      // T5-Rixey-JJJ: weddings rollup now comes from a server-side
      // endpoint that uses the service-role client. The previous
      // browser-side `supabase.from('weddings')` query was hit by RLS
      // and silently returned zero rows — Total Revenue showed $0 even
      // though the database had $794K of HoneyBook revenue. The new
      // endpoint also adds the merged_into_id IS NULL filter that the
      // browser-side query was missing (prevents double-counting
      // deduped HoneyBook rows).

      const [funnelRes, spendRes, weddingRollupRes] = await Promise.all([
        fetch(`/api/intel/sources/funnel?${apiParams.toString()}`),
        spendQuery,
        fetch(`/api/intel/sources/wedding-rollup?${apiParams.toString()}`),
      ])

      if (!funnelRes.ok) throw new Error(`Funnel HTTP ${funnelRes.status}`)
      if (!weddingRollupRes.ok) throw new Error(`Wedding rollup HTTP ${weddingRollupRes.status}`)
      const funnelJson = (await funnelRes.json()) as { rows?: FunnelApiRow[] }
      const weddingRollupJson = (await weddingRollupRes.json()) as WeddingRollupApiResponse
      if (spendRes.error) throw spendRes.error

      const rollupRows = weddingRollupJson.rows ?? []
      // Build the venue-name map from the rollup payload itself —
      // the server already joined venue_id → name for every row, so
      // the page no longer needs a separate venues query.
      const nameMap = new Map<string, string>()
      for (const r of rollupRows) {
        if (r.venue_id) nameMap.set(r.venue_id, r.venue_name ?? '')
      }
      // venueIds resolved above (still needed for spend query); fold
      // them into the name map via a one-shot venues lookup ONLY when
      // the rollup is empty (all-zero state). This keeps the legacy
      // labelling for the spend table when no bookings exist yet.
      if (nameMap.size === 0 && venueIds && venueIds.length > 0) {
        const { data: venuesData } = await supabase
          .from('venues')
          .select('id, name')
          .in('id', venueIds)
        for (const v of (venuesData ?? []) as Array<{ id: string; name: string | null }>) {
          nameMap.set(v.id, v.name ?? '')
        }
      }

      setFunnelRows(funnelJson.rows ?? [])
      setSpendData((spendRes.data ?? []) as unknown as MarketingSpend[])
      setWeddingsRollup(rollupRows)
      setVenueNameById(nameMap)
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

    // 1b) T5-Rixey-VV Y2/Y4: layer in bookings + revenue from weddings
    //     directly so HoneyBook bookings (which lack wedding_touchpoints
    //     and were therefore invisible to the funnel API) show up in
    //     the Source Comparison table and contribute to Total Revenue.
    //     Whichever value is bigger wins per (source, venue) cell —
    //     the funnel-based number already includes touchpoint-attributed
    //     bookings, so we only ADD the delta from weddings the funnel
    //     missed. Revenue is converted from cents → dollars here.
    const funnelByKey = new Map<string, { bookings: number; revenue: number }>()
    for (const r of funnelRows) {
      const k = makeKey((r.source ?? 'unknown').toLowerCase(), r.venueId ?? null)
      const cur = funnelByKey.get(k) ?? { bookings: 0, revenue: 0 }
      cur.bookings += Number(r.bookings ?? 0)
      cur.revenue += Number(r.revenue ?? 0)
      funnelByKey.set(k, cur)
    }
    // T5-Rixey-JJJ: weddingsRollup is now PRE-AGGREGATED (one row per
    // source × venue) by the server endpoint, so we consume it
    // directly instead of looping per-wedding. revenue_cents → dollars
    // happens here so the rest of the page math stays in dollars.
    const wedByKey = new Map<string, { bookings: number; revenueDollars: number }>()
    for (const w of weddingsRollup) {
      const sourceKey = (w.source_key ?? 'unknown').toLowerCase()
      const k = makeKey(sourceKey, w.venue_id ?? null)
      const cur = wedByKey.get(k) ?? { bookings: 0, revenueDollars: 0 }
      cur.bookings += Number(w.bookings ?? 0)
      cur.revenueDollars += Number(w.revenue_cents ?? 0) / 100
      wedByKey.set(k, cur)
    }
    for (const [k, wed] of wedByKey) {
      const [sourceKey, vidPart] = k.includes('|') ? k.split('|') : [k, null]
      const venueId = vidPart && vidPart !== 'unknown' ? vidPart : null
      const venueName = venueId ? (venueNameById.get(venueId) ?? null) : null
      const row = ensure(sourceKey!, venueId, venueName)
      const funnel = funnelByKey.get(k) ?? { bookings: 0, revenue: 0 }
      // Add only the delta the funnel missed. Avoids double-counting
      // when the funnel API has touchpoint-attributed bookings AND the
      // weddings rollup has the same row. Negative delta clamped to 0
      // (linear attribution can produce fractional counts above 1).
      const bookingsDelta = Math.max(0, wed.bookings - funnel.bookings)
      const revenueDelta = Math.max(0, wed.revenueDollars - funnel.revenue)
      row.bookings += bookingsDelta
      row.revenue += revenueDelta
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
  // T5-Rixey-JJJ: Total Revenue sums revenue_cents from the
  // server-aggregated rollup (cents → dollars). The previous in-page
  // browser fetch was bitten by RLS and returned zero rows, which made
  // this tile display $0 even though the database had $794K of
  // HoneyBook revenue for Rixey. The new server endpoint also adds the
  // merged_into_id IS NULL filter that the browser query was missing
  // (prevents double-counting deduped HoneyBook rows).
  const totalRevenue = weddingsRollup.reduce(
    (sum, w) => sum + Number(w.revenue_cents ?? 0) / 100,
    0,
  )
  // Total Bookings: now sourced from sourceRows (which already absorbs
  // the weddingsRollup delta in step 1b above), so HoneyBook bookings
  // contribute. Stays a single source of truth across the table + tile.
  const totalBookings = sourceRows.reduce((sum, r) => sum + r.bookings, 0)
  const overallCPB = totalBookings > 0 ? totalSpend / totalBookings : 0

  // ---- Compute insights from source data ----
  const sourceInsights: InsightItem[] = (() => {
    if (sourceRows.length === 0) return []
    const items: InsightItem[] = []

    // T5-Rixey-LLL B4: tighten the degenerate-state guard. The original
    // VV Y3 guard (max(row.revenue) <= 0) didn't fire for Rixey because
    // sourceRows.revenue comes from the funnel API and is non-zero on a
    // few rows even when no SINGLE channel has both demand AND credited
    // revenue. Result: the panel emitted both "The Knot is your best
    // channel at $0/lead" (HIGH) AND "The Knot has the lowest ROI at
    // -100%" (MEDIUM) on the same row.
    //
    // New rule: surface the data-gap insight if EITHER
    //   (a) totalRevenue (the page-level total computed from
    //       weddingsRollup) is <= 0, OR
    //   (b) no row has BOTH inquiries > 0 AND revenue > 0 — i.e. no
    //       channel jointly demonstrates demand and credited revenue,
    //       which is the precondition for any "best at $X/lead" claim
    //       to be meaningful.
    const hasJointEvidence = sourceRows.some((r) => r.inquiries > 0 && r.revenue > 0)
    if (totalRevenue <= 0 || !hasJointEvidence) {
      items.push({
        icon: 'warning',
        text: "Revenue not yet flowing into the per-channel rollup — check that booking_value is populated, attribution touchpoints exist, and the source_attribution rollup ran since the latest data load.",
        priority: 'high',
      })
      return items
    }

    // Best performing source (by revenue per inquiry). Belt-and-braces:
    // suppress this insight when best.revenue === 0 even after the
    // gap-guard above, since "best at $0/lead" is degenerate math.
    const withInquiries = sourceRows.filter((r) => r.inquiries > 0)
    if (withInquiries.length > 0) {
      const best = [...withInquiries].sort((a, b) => {
        const aRev = a.inquiries > 0 ? a.revenue / a.inquiries : 0
        const bRev = b.inquiries > 0 ? b.revenue / b.inquiries : 0
        return bRev - aRev
      })[0]
      if (best.revenue > 0) {
        const revPerLead = Math.round(best.revenue / best.inquiries)
        items.push({
          icon: 'trend_up',
          text: `${best.source_name} is your best channel at $${revPerLead.toLocaleString()}/lead in revenue`,
          priority: 'high',
        })
      }
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

    // T5-Rixey-LLL B10: roll the per-source zero-booking warnings into a
    // SINGLE banner. Previously the loop emitted one item per channel
    // with inquiries>0 and bookings=0 — six channels in that state
    // turned the panel into spam. Coordinator goes to the comparison
    // table to triage.
    const zeroBookings = sourceRows.filter((r) => r.inquiries > 0 && r.bookings === 0)
    if (zeroBookings.length === 1) {
      const src = zeroBookings[0]
      items.push({
        icon: 'warning',
        text: `${src.source_name} generated ${src.inquiries} inquiries but no bookings — investigate conversion blockers`,
        priority: 'medium',
      })
    } else if (zeroBookings.length > 1) {
      items.push({
        icon: 'warning',
        text: `${zeroBookings.length} channels generated inquiries but no bookings — open the Source Comparison table to investigate.`,
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


      {/* Stream HHH Bug 10: routed by surface='sources' — only channel/
          source-specific insights (source_attribution category, plus
          trend/opportunity rows tagged to a source) render here. The
          generic 34%-tour-cancel risk no longer leaks across. */}
      <InlineInsightBanner surface="sources" category="source_attribution" />

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

      {/* ---- Source Quality Scorecard (Phase 4 Task 39 + Phase C / PC.1) ---- */}
      <SourceQualityScorecard scope={scope} windowDays={windowDays} onWindowChange={setWindowDays} />

      {/* ---- Phase C / PC.2: candidate-driven intelligence panels ---- */}
      <PhaseBIntelPanels
        scope={scope}
        windowDays={windowDays}
        multiTouchWindowDays={multiTouchWindowDays}
        onMultiTouchWindowChange={setMultiTouchWindowDays}
      />
      {scope.level === 'venue' && <ReEngagementROIPanel />}

      {/* ---- Compare Attribution Models (Phase 4 P4.4) ---- */}
      <ModelComparisonCard scope={scope} />

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
                  {/* T5-Rixey-Wave-14-TTT: leading expander column. No
                      sort, no header label — just the disclosure
                      affordance. */}
                  <th className="w-8 px-2 py-3" aria-label="Expand row" />
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
                {sortedRows.map((row) => {
                  // T5-Rixey-VV Y6: surface the explanatory tooltip on
                  // the Untracked / Pre-Bloom row so coordinators
                  // understand it's a data-coverage gap, not noise.
                  const isUntracked = row.source_name === UNTRACKED_LABEL
                  // T5-Rixey-Wave-14-TTT: expansion key is source_key +
                  // venue_id so cross-venue rows with the same source
                  // (e.g. Google × Hawthorne, Google × Crestwood)
                  // toggle independently in company/group views.
                  const rowKey = `${row.source_key}::${row.venue_id ?? 'all'}`
                  const isExpanded = expandedRow === rowKey
                  // Funnel cells reused from the deleted "Funnel by
                  // Source" section. Same data, just relocated.
                  const funnelCells: Array<[string, number]> = [
                    ['Inquiries', row.inquiries],
                    ['Tours Booked', row.tours_booked],
                    ['Tours Held', row.tours_conducted],
                    ['Proposals', row.proposals_sent],
                    ['Booked', row.bookings],
                  ]
                  const funnelMax = row.inquiries || 1
                  const costPerTour = row.tours_booked > 0 ? row.spend / row.tours_booked : 0
                  return (
                  <Fragment key={rowKey}>
                  <tr
                    className="hover:bg-sage-50/30 transition-colors cursor-pointer"
                    onClick={() => setExpandedRow(isExpanded ? null : rowKey)}
                  >
                    <td className="w-8 px-2 py-3 align-middle">
                      <ChevronRight
                        className={`w-4 h-4 text-sage-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                        aria-hidden
                      />
                      <span className="sr-only select-none" style={{ userSelect: 'none' }}>{isExpanded ? 'Collapse' : 'Expand'} {row.source_name}</span>
                    </td>
                    <td className="px-4 py-3 font-medium text-sage-900 whitespace-nowrap">
                      <div
                        className="flex items-center gap-2"
                        title={isUntracked ? UNTRACKED_TOOLTIP : undefined}
                      >
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
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{row.tours_booked > 0 ? fmt$(costPerTour) : '—'}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmt$(row.cost_per_booking)}</td>
                    <td className="px-4 py-3 text-sage-700 tabular-nums">{fmtPct(row.conversion_rate)}</td>
                    <td className="px-4 py-3 tabular-nums">
                      <span className={`font-semibold ${row.roi >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {row.roi > 0 ? '+' : ''}{fmtPct(row.roi)}
                      </span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-sage-50/30">
                      <td colSpan={14} className="px-6 py-5">
                        <div className="space-y-5">
                          {/* Funnel — relocated from the deleted "Funnel
                              by Source" section. Same 5-step visual,
                              shown only for the chosen row. */}
                          <div>
                            <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wide text-sage-500">
                              <BarChart3 className="w-3.5 h-3.5" />
                              <span>
                                Funnel · attributed by{' '}
                                {model === 'first_touch' ? 'first-touch' : model === 'last_touch' ? 'last-touch' : 'linear'} model
                              </span>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-9 gap-1.5 items-center">
                              {funnelCells.map(([label, value], idx) => (
                                <Fragment key={label}>
                                  <div className="sm:col-span-1 col-span-1">
                                    <div className="h-9 bg-white rounded border border-border overflow-hidden">
                                      <div
                                        className="h-full transition-all"
                                        style={{
                                          width: `${Math.max((value / funnelMax) * 100, 4)}%`,
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
                                  {idx < funnelCells.length - 1 && (
                                    <div className="hidden sm:flex sm:col-span-1 items-center justify-center pb-4">
                                      <ArrowRight className="w-3.5 h-3.5 text-sage-400" />
                                    </div>
                                  )}
                                </Fragment>
                              ))}
                            </div>
                            {row.inquiries > 0 && (
                              <div className="mt-2 text-xs text-sage-600">
                                <span className="font-medium text-sage-900">{fmtPct(row.conversion_rate)}</span>{' '}
                                inquiry-to-booking conversion
                                {row.tours_booked > 0 && (
                                  <>
                                    {' · '}
                                    <span className="font-medium text-sage-900">
                                      {fmtPct(row.tours_booked / row.inquiries)}
                                    </span>{' '}
                                    inquiry → tour booked
                                  </>
                                )}
                                {row.tours_conducted > 0 && row.tours_booked > 0 && (
                                  <>
                                    {' · '}
                                    <span className="font-medium text-sage-900">
                                      {fmtPct(row.tours_conducted / row.tours_booked)}
                                    </span>{' '}
                                    tour booked → tour held
                                  </>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Cost per booking math — relocated from the
                              deleted bar chart. Show the explicit
                              spend / bookings = $X calculation. */}
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div className="bg-white border border-border rounded-lg p-3">
                              <div className="text-[10px] uppercase tracking-wide text-sage-500 mb-1">Cost per Booking</div>
                              {row.bookings > 0 ? (
                                <div className="text-sm text-sage-700">
                                  <span className="font-semibold text-sage-900 tabular-nums">{fmt$(row.spend)}</span>
                                  <span className="text-sage-500"> spend</span>
                                  <span className="text-sage-400"> ÷ </span>
                                  <span className="font-semibold text-sage-900 tabular-nums">{fmtCount(row.bookings)}</span>
                                  <span className="text-sage-500"> booked</span>
                                  <span className="text-sage-400"> = </span>
                                  <span className="font-bold text-sage-900 tabular-nums">{fmt$(row.cost_per_booking)}</span>
                                </div>
                              ) : (
                                <div className="text-sm text-sage-500">No bookings attributed yet — cost-per-booking unavailable.</div>
                              )}
                            </div>
                            <div className="bg-white border border-border rounded-lg p-3">
                              <div className="text-[10px] uppercase tracking-wide text-sage-500 mb-1">Conversion Rate</div>
                              <div className="text-sm text-sage-700">
                                <span className="font-bold text-sage-900 tabular-nums">{fmtPct(row.conversion_rate)}</span>
                                <span className="text-sage-500"> inquiries → booked</span>
                              </div>
                            </div>
                            <div className="bg-white border border-border rounded-lg p-3">
                              <div className="text-[10px] uppercase tracking-wide text-sage-500 mb-1">ROI</div>
                              <div className="text-sm text-sage-700">
                                <span className={`font-bold tabular-nums ${row.roi >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {row.roi > 0 ? '+' : ''}{fmtPct(row.roi)}
                                </span>
                                <span className="text-sage-500">
                                  {' '}
                                  ({fmt$(row.revenue)} revenue {row.spend > 0 ? `vs ${fmt$(row.spend)} spend` : '— no spend recorded'})
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  )
                })}
              </tbody>
            </table>
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
