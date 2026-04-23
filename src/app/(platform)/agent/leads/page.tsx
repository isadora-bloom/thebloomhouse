'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import { VenueChip } from '@/components/intel/venue-chip'
import { InlineInsightBanner } from '@/components/intel/inline-insight-banner'
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
  updated_at: string
  wedding_date: string | null
  guest_count_estimate: number | null
  // Joined
  partner1_name: string | null
  partner2_name: string | null
  client_code: string | null
  venue_name: string | null
}

type TierFilter = 'all' | 'hot' | 'warm' | 'cool' | 'cold' | 'frozen'
type SortField = 'heat_score' | 'inquiry_date' | 'updated_at'
type SortDir = 'asc' | 'desc'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEAT_TIERS: {
  key: TierFilter
  label: string
  color: string
  bg: string
  text: string
}[] = [
  { key: 'all', label: 'All', color: '', bg: '', text: '' },
  { key: 'hot', label: 'Hot', color: '#EF4444', bg: 'bg-red-50', text: 'text-red-700' },
  { key: 'warm', label: 'Warm', color: '#F59E0B', bg: 'bg-amber-50', text: 'text-amber-700' },
  { key: 'cool', label: 'Cool', color: '#3B82F6', bg: 'bg-blue-50', text: 'text-blue-700' },
  { key: 'cold', label: 'Cold', color: '#1E40AF', bg: 'bg-blue-100', text: 'text-blue-800' },
  {
    key: 'frozen',
    label: 'Frozen',
    color: '#6B7280',
    bg: 'bg-gray-50',
    text: 'text-gray-600',
  },
]

function getTierConfig(tier: string) {
  return (
    HEAT_TIERS.find((t) => t.key === tier) ?? {
      key: tier,
      label: tier,
      color: '#6B7280',
      bg: 'bg-gray-50',
      text: 'text-gray-600',
    }
  )
}

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

function sourceBadge(source: string | null): { bg: string; text: string; label: string } {
  switch (source) {
    case 'the_knot':
      return { bg: 'bg-rose-50', text: 'text-rose-700', label: 'The Knot' }
    case 'wedding_wire':
    case 'weddingwire':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label: 'WeddingWire' }
    case 'google':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Google' }
    case 'instagram':
      return { bg: 'bg-pink-50', text: 'text-pink-700', label: 'Instagram' }
    case 'referral':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Referral' }
    case 'website':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Website' }
    case 'walk_in':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Walk-in' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: source || 'Unknown' }
  }
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
        {HEAT_TIERS.filter((t) => t.key !== 'all').map((tier) => (
          <div key={tier.key} className="flex items-center gap-1.5">
            <span
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: tier.color }}
            />
            <span className="text-xs text-sage-600">
              {tier.label}{' '}
              <span className="font-medium text-sage-800">
                ({counts[tier.key] ?? 0})
              </span>
            </span>
          </div>
        ))}
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

      let query = supabase
        .from('weddings')
        .select(`
          id,
          venue_id,
          status,
          source,
          heat_score,
          temperature_tier,
          inquiry_date,
          updated_at,
          wedding_date,
          guest_count_estimate,
          venues:venue_id ( name ),
          people!people_wedding_id_fkey ( role, first_name, last_name ),
          client_codes!client_codes_wedding_id_fkey ( code )
        `)
        .in('status', ['inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent'])
        .gt('heat_score', 0)
      if (venueIds && venueIds.length > 0) {
        query = query.in('venue_id', venueIds)
      }
      const { data, error: fetchError } = await query.order('heat_score', { ascending: false })

      if (fetchError) throw fetchError

      const mapped: Lead[] = (data ?? []).map((row: any) => {
        const people = row.people ?? []
        const p1 = people.find((p: any) => p.role === 'partner1')
        const p2 = people.find((p: any) => p.role === 'partner2')
        const codes = row.client_codes ?? []
        const clientCode = Array.isArray(codes) && codes.length > 0 ? codes[0]?.code ?? null : null
        const venueRel = row.venues as { name?: string } | { name?: string }[] | null | undefined
        const venueName = Array.isArray(venueRel) ? venueRel[0]?.name ?? null : venueRel?.name ?? null

        return {
          id: row.id,
          venue_id: row.venue_id,
          status: row.status,
          source: row.source,
          heat_score: row.heat_score ?? 0,
          temperature_tier: row.temperature_tier ?? 'cool',
          inquiry_date: row.inquiry_date,
          updated_at: row.updated_at,
          wedding_date: row.wedding_date,
          guest_count_estimate: row.guest_count_estimate,
          partner1_name: p1
            ? [p1.first_name, p1.last_name].filter(Boolean).join(' ')
            : null,
          partner2_name: p2
            ? [p2.first_name, p2.last_name].filter(Boolean).join(' ')
            : null,
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
        case 'updated_at':
          aVal = new Date(a.updated_at).getTime()
          bVal = new Date(b.updated_at).getTime()
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
    for (const t of HEAT_TIERS) {
      if (t.key === 'all') continue
      c[t.key] = leads.filter((l) => l.temperature_tier === t.key).length
    }
    return c
  }, [leads])

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
      </div>

      {/* ---- Inline insight banner ---- */}
      <InlineInsightBanner category="lead_conversion,team_performance" />

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
          {HEAT_TIERS.map((tier) => (
            <button
              key={tier.key}
              onClick={() => setTierFilter(tier.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                tierFilter === tier.key
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {tier.key !== 'all' && (
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: tier.color }}
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
          ))}
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
            <table className="w-full">
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
                      field="updated_at"
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
                  const tier = getTierConfig(lead.temperature_tier)
                  const source = sourceBadge(lead.source)
                  const daysSinceInquiry = daysSince(lead.inquiry_date)

                  return (
                    <tr
                      key={lead.id}
                      className="hover:bg-sage-50/50 transition-colors"
                    >
                      {/* Couple */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-sage-900">
                            {coupleName(lead.partner1_name, lead.partner2_name)}
                          </span>
                          {lead.client_code && (
                            <span className="text-xs font-mono text-sage-500">
                              {lead.client_code}
                            </span>
                          )}
                          {showVenueChip && <VenueChip venueName={lead.venue_name} />}
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
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${tier.bg} ${tier.text}`}
                          >
                            <Flame className="w-3 h-3" />
                            {lead.heat_score}
                          </span>
                        </div>
                      </td>

                      {/* Tier */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="w-2.5 h-2.5 rounded-full"
                            style={{ backgroundColor: tier.color }}
                          />
                          <span className="text-sm text-sage-700 capitalize">
                            {lead.temperature_tier}
                          </span>
                        </div>
                      </td>

                      {/* Last Activity */}
                      <td className="px-4 py-3">
                        <span className="text-sm text-sage-600">
                          {formatDate(lead.updated_at)}
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
