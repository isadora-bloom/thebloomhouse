'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import { personFullName, pickCanonicalPeople } from '@/lib/utils/couple-name'
import { VenueChip } from '@/components/intel/venue-chip'
// Stream HHH Bug 10: InlineInsightBanner removed from /agent/leads.
import { HeatBadge } from '@/components/intel/heat-badge'
import { RiskFlagChip, useBatchRiskFlags } from '@/components/intel/risk-flag-chip'
import {
  AutoContextChipRender,
  useBatchAutoContextChips,
} from '@/components/intel/auto-context-chip'
import { SoloPill, useBatchPartnerCounts } from '@/components/intel/solo-pill'
import { EssentialsSlider } from '@/components/shell/essentials-slider'
import { TIER_STYLES, styleForTier, type HeatTier } from '@/lib/heat/tier-colors'
import { formatBloomNumber } from '@/lib/bloom-number/format'
import { formatSourceLabel } from '@/lib/utils/format-source-label'
import {
  Flame,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Users,
  Calendar,
  Clock,
  AlertTriangle,
  Search,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Lead {
  id: string
  venue_id: string
  status: string
  source: string | null
  heat_score: number
  temperature_tier: string
  inquiry_date: string
  wedding_date: string | null
  guest_count_estimate: number | null
  code_extension: string | null
  // T5-γ.1: provenance flag — null/'live' = pipeline-ingested,
  // 'imported_high'/'imported_medium' = CRM, 'imported_low' = Gmail
  // backfill, 'manual' = coordinator hand-entry. Surfaced as inline
  // chip so coordinator can spot which lead profiles came from
  // backfill vs live data.
  confidence_flag: string | null
  // T5-Rixey-UU Bug F: real "last activity" derived from
  // MAX(interactions.timestamp). Not weddings.updated_at — that gets
  // bumped to NOW() by every batch import / reconciliation /
  // lead-source derivation pass, so every row would show today.
  last_activity_at: string | null
  // T5-Rixey-UU Bug G: import-time warnings surfaced inline as a
  // "needs review" badge. Currently we surface couple_name issues; the
  // jsonb is shaped as { field, issue, value }[] so future warning
  // categories slot in without a UI change.
  import_warnings: ImportWarning[] | null
  // Joined
  partner1_name: string | null
  partner2_name: string | null
  client_code: string | null
  venue_name: string | null
}

interface ImportWarning {
  field: string
  issue: string
  value?: string | null
}

type TierFilter = 'all' | 'hot' | 'warm' | 'cool' | 'cold' | 'frozen'
// T5-Rixey-UU Bug F: 'last_activity' replaces the old 'updated_at'
// sort key. Sort is by MAX(interactions.timestamp), not by
// weddings.updated_at (which gets bumped to NOW() by every batch
// import / reconciliation pass and so was useless as a sort axis).
type SortField = 'heat_score' | 'inquiry_date' | 'last_activity'
type SortDir = 'asc' | 'desc'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Heat tier styles now sourced from src/lib/heat/tier-colors (the
// single-source HeatBadge primitive uses the same map). Pre-fix this
// page redeclared the tier styles inline, drifting from /agent/pipeline
// and /intel/clients/[id] over time. ARCH-20.2.1.
const HEAT_TIER_FILTERS: { key: TierFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  ...(Object.keys(TIER_STYLES) as HeatTier[]).map((k) => ({
    key: k as TierFilter,
    label: TIER_STYLES[k].label,
  })),
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coupleName(p1: string | null, p2: string | null): string {
  if (p1 && p2) return `${p1} & ${p2}`
  return p1 || p2 || 'Unknown'
}

function daysSince(dateStr: string): number {
  const diff = Date.now() - new Date(dateStr).getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '---'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// T5-Rixey-UU Bug E: source pill colours stay per-source for visual
// scanability, but the LABEL always comes from formatSourceLabel() so
// we never leak raw snake_case ('venue_calculator', 'calendly',
// 'other', 'direct') into the table cell.
function sourceBadge(source: string | null): { bg: string; text: string; label: string } {
  const label = formatSourceLabel(source)
  switch (source) {
    case 'the_knot':
      return { bg: 'bg-rose-50', text: 'text-rose-700', label }
    case 'wedding_wire':
    case 'weddingwire':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label }
    case 'google':
    case 'google_business':
    case 'google_ads':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label }
    case 'instagram':
      return { bg: 'bg-pink-50', text: 'text-pink-700', label }
    case 'pinterest':
      return { bg: 'bg-rose-50', text: 'text-rose-700', label }
    case 'facebook':
      return { bg: 'bg-indigo-50', text: 'text-indigo-700', label }
    case 'referral':
    case 'word_of_mouth':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label }
    case 'website':
    case 'web_form':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label }
    case 'venue_calculator':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label }
    case 'here_comes_the_guide':
      return { bg: 'bg-violet-50', text: 'text-violet-700', label }
    case 'walk_in':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label }
    case 'direct':
      return { bg: 'bg-slate-50', text: 'text-slate-700', label }
    case 'calendly':
    case 'acuity':
    case 'honeybook':
    case 'dubsado':
      return { bg: 'bg-cyan-50', text: 'text-cyan-700', label }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label }
  }
}

// T5-Rixey-UU Bug G: detect rows whose import_warnings include an
// unresolved couple_name issue. Coordinator gets a 'needs review'
// chip on the lead row.
function hasCoupleNameWarning(warnings: ImportWarning[] | null | undefined): boolean {
  if (!warnings || !Array.isArray(warnings)) return false
  return warnings.some(
    (w) => w?.field === 'couple_name' && typeof w.issue === 'string' && w.issue.length > 0
  )
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    inquiry: 'Inquiry',
    tour_scheduled: 'Tour Scheduled',
    tour_completed: 'Tour Completed',
    proposal_sent: 'Proposal Sent',
    booked: 'Booked',
    lost: 'Lost',
    completed: 'Completed',
    cancelled: 'Cancelled',
  }
  return map[status] ?? status
}

// ---------------------------------------------------------------------------
// Confidence flag chip (T5-γ.1)
//
// Surfaces wedding.confidence_flag inline. Coordinator needs to
// distinguish "this lead came in live this week" from "this lead was
// inferred from a Gmail backfill or hand-entered." Pre-fix the leads
// table presented all rows the same.
// ---------------------------------------------------------------------------

function confidenceFlagBadge(flag: string): { bg: string; text: string; label: string; title: string } | null {
  switch (flag) {
    case 'imported_high':
      return {
        bg: 'bg-blue-50',
        text: 'text-blue-700',
        label: 'CRM',
        title: 'Imported with full identity from a CRM export.',
      }
    case 'imported_medium':
      return {
        bg: 'bg-blue-50',
        text: 'text-blue-700',
        label: 'CRM',
        title: 'Imported with partial identity from a CRM export.',
      }
    case 'imported_low':
      return {
        bg: 'bg-amber-50',
        text: 'text-amber-700',
        label: 'Imported',
        title: 'Reconstructed from your Gmail history. Some fields are best-guesses rather than live-confirmed.',
      }
    case 'manual':
      return {
        bg: 'bg-sage-50',
        text: 'text-sage-700',
        label: 'Manual',
        title: 'Coordinator hand-entry. Not pipeline-ingested.',
      }
    default:
      return null
  }
}

function ConfidenceFlagChip({ flag }: { flag: string }) {
  const meta = confidenceFlagBadge(flag)
  if (!meta) return null
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${meta.bg} ${meta.text}`}
      title={meta.title}
    >
      {meta.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function TableSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="divide-y divide-border">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="p-4">
            <div className="animate-pulse flex items-center gap-4">
              <div className="h-4 w-40 bg-sage-100 rounded" />
              <div className="h-4 w-16 bg-sage-100 rounded-full" />
              <div className="h-4 w-12 bg-sage-100 rounded" />
              <div className="h-4 w-20 bg-sage-100 rounded-full" />
              <div className="h-4 w-24 bg-sage-50 rounded" />
              <div className="h-4 w-10 bg-sage-50 rounded" />
              <div className="h-4 w-20 bg-sage-50 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function BarSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse">
        <div className="h-4 w-40 bg-sage-100 rounded mb-4" />
        <div className="h-8 w-full bg-sage-100 rounded-full" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Heat Distribution Bar
// ---------------------------------------------------------------------------

function HeatDistributionBar({ leads }: { leads: Lead[] }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = { hot: 0, warm: 0, cool: 0, cold: 0, frozen: 0 }
    for (const lead of leads) {
      const tier = lead.temperature_tier || 'cool'
      if (c[tier] !== undefined) c[tier]++
      else c.cool++
    }
    return c
  }, [leads])

  const total = leads.length

  const segments = [
    { key: 'hot', color: '#EF4444', count: counts.hot },
    { key: 'warm', color: '#F59E0B', count: counts.warm },
    { key: 'cool', color: '#3B82F6', count: counts.cool },
    { key: 'cold', color: '#1E40AF', count: counts.cold },
    { key: 'frozen', color: '#6B7280', count: counts.frozen },
  ].filter((s) => s.count > 0)

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <h2 className="font-heading text-base font-semibold text-sage-900 mb-4">
        Heat Distribution
      </h2>

      {/* Bar */}
      <div className="h-8 rounded-full overflow-hidden flex bg-sage-100">
        {segments.map((seg) => (
          <div
            key={seg.key}
            className="h-full flex items-center justify-center transition-all"
            style={{
              width: `${(seg.count / total) * 100}%`,
              backgroundColor: seg.color,
              minWidth: seg.count > 0 ? '24px' : '0',
            }}
          >
            {seg.count > 0 && (
              <span className="text-xs font-bold text-white drop-shadow-sm">
                {seg.count}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 flex-wrap">
        {HEAT_TIER_FILTERS.filter((t) => t.key !== 'all').map((tier) => {
          const style = styleForTier(tier.key)
          return (
            <div key={tier.key} className="flex items-center gap-1.5">
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: style.color }}
              />
              <span className="text-xs text-sage-600">
                {tier.label}{' '}
                <span className="font-medium text-sage-800">
                  ({counts[tier.key] ?? 0})
                </span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sortable Table Header
// ---------------------------------------------------------------------------

function SortHeader({
  label,
  field,
  currentField,
  currentDir,
  onSort,
}: {
  label: string
  field: SortField
  currentField: SortField
  currentDir: SortDir
  onSort: (field: SortField) => void
}) {
  const isActive = field === currentField

  return (
    <button
      onClick={() => onSort(field)}
      className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-sage-500 hover:text-sage-700 transition-colors"
    >
      {label}
      {isActive ? (
        currentDir === 'desc' ? (
          <ArrowDown className="w-3 h-3" />
        ) : (
          <ArrowUp className="w-3 h-3" />
        )
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-40" />
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function LeadsPage() {
  const router = useRouter()
  const scope = useScope()
  const showVenueChip = scope.level !== 'venue'
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tierFilter, setTierFilter] = useState<TierFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortField, setSortField] = useState<SortField>('heat_score')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const supabase = createClient()

  // ---- Fetch leads ----
  const fetchLeads = useCallback(async () => {
    if (scope.loading) return
    try {
      // Build venue filter from scope
      let venueIds: string[] | null = null
      if (scope.level === 'venue' && scope.venueId) {
        venueIds = [scope.venueId]
      } else if (scope.level === 'group' && scope.groupId) {
        const { data: members } = await supabase
          .from('venue_group_members')
          .select('venue_id')
          .eq('group_id', scope.groupId)
        venueIds = (members ?? []).map((r) => r.venue_id as string)
      } else if (scope.orgId) {
        const { data: orgVenues } = await supabase
          .from('venues')
          .select('id')
          .eq('org_id', scope.orgId)
        venueIds = (orgVenues ?? []).map((v) => v.id as string)
      }

      // Migration 316: heat_score / temperature_tier moved to wedding_heat
      // view. Fetch weddings + heat in parallel, join + sort in memory.
      let query = supabase
        .from('weddings')
        .select(`
          id,
          venue_id,
          status,
          source,
          inquiry_date,
          wedding_date,
          guest_count_estimate,
          code_extension,
          confidence_flag,
          import_warnings,
          venues:venue_id ( name ),
          people!people_wedding_id_fkey ( role, first_name, last_name ),
          client_codes!client_codes_wedding_id_fkey ( code )
        `)
        .in('status', ['inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent'])
        // Step 5c (RM-1123, 2026-05-13): non_couple_at IS NULL filters
        // out soft-tombstoned non-couple weddings (bus drivers, vendor
        // texts, autoreplies that pre-Step-5b minted ghosts). The
        // tombstone cron sets this column; readers everywhere honour
        // the filter so a non-couple never appears as an active lead.
        .is('non_couple_at', null)
      // NOTE: previously filtered `.gt('heat_score', 0)`. Removed because
      // it was masking a real bug: inquiries whose initial_inquiry event
      // never triggered recalculateHeatScore sat at 0 indefinitely, so
      // whole swathes of active leads were invisible. Fixed upstream in
      // email-pipeline (the initial_inquiry insert now runs through
      // recordEngagementEventsBatch). Migration 316 makes this structurally
      // impossible: heat is a view, derived live. Showing zeros honestly
      // means a coordinator sees "this lead hasn't engaged yet" instead of
      // "this lead doesn't exist".
      if (venueIds && venueIds.length > 0) {
        query = query.in('venue_id', venueIds)
      }
      let heatQuery = supabase.from('wedding_heat').select('wedding_id, heat_score, temperature_tier')
      if (venueIds && venueIds.length > 0) {
        heatQuery = heatQuery.in('venue_id', venueIds)
      }
      const [{ data: rawData, error: fetchError }, { data: heatRows }] = await Promise.all([
        query,
        heatQuery,
      ])

      if (fetchError) throw fetchError

      const heatByWedding = new Map<string, { heat_score: number; temperature_tier: string }>()
      for (const h of heatRows ?? []) {
        heatByWedding.set(h.wedding_id as string, {
          heat_score: (h.heat_score as number) ?? 0,
          temperature_tier: (h.temperature_tier as string) ?? 'cool',
        })
      }
      const data = (rawData ?? [])
        .map((row: any) => {
          const heat = heatByWedding.get(row.id as string)
          return {
            ...row,
            heat_score: heat?.heat_score ?? 0,
            temperature_tier: heat?.temperature_tier ?? 'cool',
          }
        })
        .sort((a: any, b: any) => (b.heat_score ?? 0) - (a.heat_score ?? 0))

      // T5-Rixey-UU Bug F: Last Activity = MAX(interactions.timestamp)
      // per wedding, NOT weddings.updated_at. The latter gets bumped by
      // every batch import / reconciliation pass so all rows would
      // otherwise show today's date. We pull interactions in one batch
      // keyed on the loaded wedding ids and aggregate client-side.
      // created-at-ok: interactions.timestamp is the real event-date
      // column for that table (see src/lib/services/date-windows.ts).
      const weddingIds = (data ?? []).map((r: any) => r.id as string)
      const lastActivityByWedding: Record<string, string> = {}
      if (weddingIds.length > 0) {
        const { data: interactions } = await supabase
          .from('interactions')
          .select('wedding_id, timestamp')
          .in('wedding_id', weddingIds)
          .order('timestamp', { ascending: false })
        for (const row of interactions ?? []) {
          const wid = row.wedding_id as string | null
          const ts = row.timestamp as string | null
          if (!wid || !ts) continue
          // Only keep the first (most recent) per wedding — the query
          // ordered desc, so the first hit wins.
          if (!(wid in lastActivityByWedding)) {
            lastActivityByWedding[wid] = ts
          }
        }
      }

      const mapped: Lead[] = (data ?? []).map((row: any) => {
        const people = row.people ?? []
        // 2026-05-09: collapse Knot-relay nickname rows into the
        // calculator-submission legal-name row before picking a
        // partner1/partner2 representative. Without this, a venue
        // with both rows would render "Jen B" instead of "Jennifer
        // Biaksangi" in the inbox.
        const canonicalP1 = pickCanonicalPeople(
          people.filter((p: any) => p.role === 'partner1'),
        )
        const canonicalP2 = pickCanonicalPeople(
          people.filter((p: any) => p.role === 'partner2'),
        )
        const p1 = canonicalP1[0]
        const p2 = canonicalP2[0]
        const codes = row.client_codes ?? []
        const clientCode = Array.isArray(codes) && codes.length > 0 ? codes[0]?.code ?? null : null
        const venueRel = row.venues as { name?: string } | { name?: string }[] | null | undefined
        const venueName = Array.isArray(venueRel) ? venueRel[0]?.name ?? null : venueRel?.name ?? null

        // T5-Rixey-UU Bug G: parse import_warnings jsonb defensively —
        // some rows may have legacy non-array values from earlier
        // import passes.
        const rawWarnings = row.import_warnings as unknown
        const importWarnings: ImportWarning[] | null = Array.isArray(rawWarnings)
          ? (rawWarnings as ImportWarning[])
          : null

        return {
          id: row.id,
          venue_id: row.venue_id,
          status: row.status,
          source: row.source,
          heat_score: row.heat_score ?? 0,
          temperature_tier: row.temperature_tier ?? 'cool',
          inquiry_date: row.inquiry_date,
          wedding_date: row.wedding_date,
          guest_count_estimate: row.guest_count_estimate,
          code_extension: row.code_extension ?? null,
          confidence_flag: (row.confidence_flag as string | null) ?? null,
          last_activity_at: lastActivityByWedding[row.id as string] ?? null,
          import_warnings: importWarnings,
          partner1_name: p1 ? personFullName(p1) : null,
          partner2_name: p2 ? personFullName(p2) : null,
          client_code: clientCode,
          venue_name: venueName,
        }
      })

      setLeads(mapped)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch leads:', err)
      setError('Failed to load lead scoring data')
    } finally {
      setLoading(false)
    }
  }, [scope.loading, scope.level, scope.venueId, scope.groupId, supabase])

  useEffect(() => {
    fetchLeads()
  }, [fetchLeads])

  // ---- Sorting ----
  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  // ---- Filtering + sorting ----
  const filteredLeads = useMemo(() => {
    let result = [...leads]

    // Tier filter
    if (tierFilter !== 'all') {
      result = result.filter((l) => l.temperature_tier === tierFilter)
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (l) =>
          coupleName(l.partner1_name, l.partner2_name).toLowerCase().includes(q) ||
          (l.source?.toLowerCase().includes(q) ?? false)
      )
    }

    // Sort
    result.sort((a, b) => {
      let aVal: number
      let bVal: number

      switch (sortField) {
        case 'heat_score':
          aVal = a.heat_score
          bVal = b.heat_score
          break
        case 'inquiry_date':
          aVal = new Date(a.inquiry_date).getTime()
          bVal = new Date(b.inquiry_date).getTime()
          break
        case 'last_activity':
          // Treat null last-activity as 0 so weddings with no
          // recorded interaction sort to the bottom on desc.
          aVal = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0
          bVal = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0
          break
        default:
          return 0
      }

      return sortDir === 'desc' ? bVal - aVal : aVal - bVal
    })

    return result
  }, [leads, tierFilter, searchQuery, sortField, sortDir])

  // ---- Summary ----
  const tierCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const t of HEAT_TIER_FILTERS) {
      if (t.key === 'all') continue
      c[t.key] = leads.filter((l) => l.temperature_tier === t.key).length
    }
    return c
  }, [leads])

  // ---- Risk flags batch fetch (T5-ζ.2) ----
  // One POST per page load, keyed on the underlying loaded lead set.
  // Filter/sort state changes do NOT refetch — the hook dedupes +
  // sorts the input so it only fires when the actual ID set changes.
  const allWeddingIds = useMemo(() => leads.map((l) => l.id), [leads])
  const riskFlags = useBatchRiskFlags(allWeddingIds, {
    venueId: scope.venueId ?? null,
  })
  // Wave 1C (2026-05-09): one chip per lead surfacing the highest-priority
  // pinned auto-context note (or category-only redaction for sensitive).
  // Same batch pattern as risk flags.
  const autoContextChips = useBatchAutoContextChips(allWeddingIds, {
    venueId: scope.venueId ?? null,
  })
  // Wave 2D (2026-05-09): Solo pill batch fetch. Defensive — only renders
  // on a clean partner_count=1; NULL / unknown stays silent.
  const partnerCounts = useBatchPartnerCounts(allWeddingIds, {
    venueId: scope.venueId ?? null,
  })

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Lead Scoring
          </h1>
          <p className="text-sage-600">
            See every lead ranked by engagement heat score — from hot prospects ready to book down to cold leads that need a nudge. Click any lead to view their full profile and history.
          </p>
        </div>
        {/* T4-D Essentials slider — controls density on this surface. */}
        <EssentialsSlider surface="/agent/leads" />
      </div>

      {/* Stream HHH Bug 10: InlineInsightBanner removed. High-severity
          risk insights now route to /pulse + /intel/dashboard only. */}

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => {
              setError(null)
              setLoading(true)
              fetchLeads()
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Heat Distribution Bar ---- */}
      {loading ? (
        <BarSkeleton />
      ) : leads.length > 0 ? (
        <HeatDistributionBar leads={leads} />
      ) : null}

      {/* ---- Filters ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {/* Tier tabs */}
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1">
          {HEAT_TIER_FILTERS.map((tier) => {
            const style = tier.key !== 'all' ? styleForTier(tier.key) : null
            return (
            <button
              key={tier.key}
              onClick={() => setTierFilter(tier.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                tierFilter === tier.key
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {style && (
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: style.color }}
                />
              )}
              {tier.label}
              {tier.key !== 'all' && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full ${
                    tierFilter === tier.key
                      ? 'bg-sage-100 text-sage-700'
                      : 'bg-sage-100/50 text-sage-500'
                  }`}
                >
                  {tierCounts[tier.key] ?? 0}
                </span>
              )}
            </button>
            )
          })}
        </div>

        {/* Search */}
        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search leads..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
          />
        </div>
      </div>

      {/* ---- Leads Table ---- */}
      {loading ? (
        <TableSkeleton />
      ) : filteredLeads.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Flame className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {searchQuery
              ? 'No matching leads'
              : tierFilter !== 'all'
                ? `No ${tierFilter} leads`
                : 'No scored leads yet'}
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {searchQuery
              ? `No leads match "${searchQuery}".`
              : 'Lead scores are calculated automatically based on engagement events. As inquiries interact with the venue, their heat scores will appear here.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-[640px] w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Couple
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Source
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <SortHeader
                      label="Heat Score"
                      field="heat_score"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Tier
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <SortHeader
                      label="Last Activity"
                      field="last_activity"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="text-left px-4 py-3">
                    <SortHeader
                      label="Days Since Inquiry"
                      field="inquiry_date"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Status
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredLeads.map((lead) => {
                  const tierStyle = styleForTier(lead.temperature_tier)
                  const source = sourceBadge(lead.source)
                  const daysSinceInquiry = daysSince(lead.inquiry_date)

                  return (
                    <tr
                      key={lead.id}
                      onClick={() => router.push(`/intel/clients/${lead.id}`)}
                      className="hover:bg-sage-50/50 cursor-pointer transition-colors"
                    >
                      {/* Couple */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-sage-900 hover:text-sage-700 underline-offset-2 hover:underline">
                            {coupleName(lead.partner1_name, lead.partner2_name)}
                          </span>
                          {lead.client_code && (
                            <span className="text-xs font-mono text-sage-500">
                              {formatBloomNumber(lead.client_code, lead.code_extension)}
                            </span>
                          )}
                          {/* T5-γ.1: confidence_flag chip — surfaces
                              when this wedding came in via backfill
                              rather than live pipeline. Hidden for
                              null and 'live' (the common path) so the
                              cell stays uncluttered. */}
                          {lead.confidence_flag && lead.confidence_flag !== 'live' && (
                            <ConfidenceFlagChip flag={lead.confidence_flag} />
                          )}
                          {showVenueChip && <VenueChip venueName={lead.venue_name} />}
                          {/* Risk-flag chip (T5-ζ.2). Hidden if no
                              cached risk_flag insight or zero flags. */}
                          <RiskFlagChip summary={riskFlags[lead.id]} />
                          {/* Wave 1C: highest-priority auto-context chip.
                              Sensitive notes redact to category only;
                              non-sensitive notes show body on hover. */}
                          <AutoContextChipRender chip={autoContextChips[lead.id]} />
                          {/* Wave 2D: Solo pill — wedding has
                              partner_count=1 set by chokepoint or
                              backfill. Defensive: only on positive 1. */}
                          <SoloPill partnerCount={partnerCounts[lead.id] ?? null} />
                          {/* T5-Rixey-UU Bug G: import-warning badge
                              for couple_name issues. Surfaces when the
                              CRM-import pipeline couldn't confidently
                              split a concatenated name like
                              'Megandcooperrosenberg'. Coordinator clicks
                              through to the lead detail to fix. */}
                          {hasCoupleNameWarning(lead.import_warnings) && (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700"
                              title="Imported couple-name couldn't be confidently parsed — needs review."
                            >
                              needs review
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Source */}
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${source.bg} ${source.text}`}
                        >
                          {source.label}
                        </span>
                      </td>

                      {/* Heat Score */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <HeatBadge tier={lead.temperature_tier} score={lead.heat_score} variant="pill" />
                        </div>
                      </td>

                      {/* Tier */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <HeatBadge tier={lead.temperature_tier} score={lead.heat_score} variant="dot" />
                          <span className="text-sm text-sage-700 capitalize">
                            {tierStyle.label}
                          </span>
                        </div>
                      </td>

                      {/* Last Activity — MAX(interactions.timestamp).
                          Renders '—' for weddings with zero recorded
                          interactions (rather than misleadingly
                          showing weddings.updated_at which gets
                          bumped on every batch import). */}
                      <td className="px-4 py-3">
                        <span className="text-sm text-sage-600">
                          {formatDate(lead.last_activity_at)}
                        </span>
                      </td>

                      {/* Days Since Inquiry */}
                      <td className="px-4 py-3">
                        <span className="text-sm text-sage-600 tabular-nums">
                          {daysSinceInquiry}d
                        </span>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <span className="text-sm text-sage-600">
                          {statusLabel(lead.status)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
