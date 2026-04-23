'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Shield,
  Building2,
  Plus,
  Search,
  TrendingUp,
  Users,
  DollarSign,
  Bot,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  BarChart3,
} from 'lucide-react'

// Super admin queries across all venues — no per-venue scope here.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Organisation {
  id: string
  name: string
  plan_tier: string
  created_at: string
}

interface VenueRow {
  id: string
  name: string
  slug: string
  status: 'active' | 'trial' | 'suspended' | 'churned'
  plan_tier: 'starter' | 'intelligence' | 'enterprise'
  org_id: string | null
  created_at: string
  // Aggregated stats (computed client-side)
  inquiries_this_month: number
  bookings_this_month: number
  revenue_this_month: number
  ai_cost_this_month: number
}

type SortField = 'name' | 'status' | 'inquiries_this_month' | 'revenue_this_month' | 'ai_cost_this_month'
type SortDir = 'asc' | 'desc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(status: VenueRow['status']) {
  switch (status) {
    case 'active':
      return { bg: 'bg-green-100', text: 'text-green-700', label: 'Active' }
    case 'trial':
      return { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Trial' }
    case 'suspended':
      return { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Suspended' }
    case 'churned':
      return { bg: 'bg-red-100', text: 'text-red-700', label: 'Churned' }
    default:
      return { bg: 'bg-sage-100', text: 'text-sage-700', label: status }
  }
}

function planBadge(tier: VenueRow['plan_tier']) {
  switch (tier) {
    case 'starter':
      return { bg: 'bg-sage-100', text: 'text-sage-700', label: 'Starter' }
    case 'intelligence':
      return { bg: 'bg-teal-100', text: 'text-teal-700', label: 'Intelligence' }
    case 'enterprise':
      return { bg: 'bg-gold-100 bg-amber-100', text: 'text-amber-700', label: 'Enterprise' }
    default:
      return { bg: 'bg-sage-100', text: 'text-sage-700', label: tier }
  }
}

function fmt$(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
}

function fmtCost(value: number): string {
  return `$${value.toFixed(2)}`
}

function getMonthStart(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SuperAdminPage() {
  const [orgs, setOrgs] = useState<Organisation[]>([])
  const [venues, setVenues] = useState<VenueRow[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const supabase = createClient()

  // ---- Fetch data ----
  const fetchData = useCallback(async () => {
    const monthStart = getMonthStart()

    const [orgsRes, venuesRes, weddingsRes, costsRes] = await Promise.all([
      supabase.from('organisations').select('*').order('name'),
      supabase.from('venues').select('*').order('name'),
      supabase
        .from('weddings')
        .select('id, venue_id, status, booking_value, inquiry_date')
        .gte('inquiry_date', monthStart),
      supabase
        .from('api_costs')
        .select('venue_id, cost')
        .gte('created_at', monthStart),
    ])

    const orgsData = (orgsRes.data ?? []) as Organisation[]
    const venuesData = (venuesRes.data ?? []) as any[]
    const weddingsData = (weddingsRes.data ?? []) as any[]
    const costsData = (costsRes.data ?? []) as any[]

    // Aggregate per venue
    const venueStats: Record<string, { inquiries: number; bookings: number; revenue: number }> = {}
    for (const w of weddingsData) {
      if (!venueStats[w.venue_id]) venueStats[w.venue_id] = { inquiries: 0, bookings: 0, revenue: 0 }
      venueStats[w.venue_id].inquiries += 1
      if (w.status === 'booked' || w.status === 'completed') {
        venueStats[w.venue_id].bookings += 1
        venueStats[w.venue_id].revenue += Number(w.booking_value) || 0
      }
    }

    const venueCosts: Record<string, number> = {}
    for (const c of costsData) {
      venueCosts[c.venue_id] = (venueCosts[c.venue_id] || 0) + Number(c.cost)
    }

    const mapped: VenueRow[] = venuesData.map((v) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      status: v.status || 'trial',
      plan_tier: v.plan_tier || 'starter',
      org_id: v.org_id,
      created_at: v.created_at,
      inquiries_this_month: venueStats[v.id]?.inquiries ?? 0,
      bookings_this_month: venueStats[v.id]?.bookings ?? 0,
      revenue_this_month: venueStats[v.id]?.revenue ?? 0,
      ai_cost_this_month: venueCosts[v.id] ?? 0,
    }))

    setOrgs(orgsData)
    setVenues(mapped)
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Sorting ----
  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return null
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3 h-3" />
    ) : (
      <ChevronDown className="w-3 h-3" />
    )
  }

  // ---- Filtering & sorting ----
  const filteredVenues = venues
    .filter((v) => {
      if (statusFilter !== 'all' && v.status !== statusFilter) return false
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        return (
          v.name.toLowerCase().includes(q) ||
          v.slug.toLowerCase().includes(q)
        )
      }
      return true
    })
    .sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1
      if (sortField === 'name') return a.name.localeCompare(b.name) * dir
      if (sortField === 'status') return a.status.localeCompare(b.status) * dir
      const aVal = a[sortField]
      const bVal = b[sortField]
      return ((aVal as number) - (bVal as number)) * dir
    })

  // ---- Aggregate totals ----
  const totalInquiries = venues.reduce((s, v) => s + v.inquiries_this_month, 0)
  const totalBookings = venues.reduce((s, v) => s + v.bookings_this_month, 0)
  const totalRevenue = venues.reduce((s, v) => s + v.revenue_this_month, 0)
  const totalAICost = venues.reduce((s, v) => s + v.ai_cost_this_month, 0)

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-10 w-72 bg-sage-100 rounded-lg" />
          <div className="h-5 w-96 bg-sage-50 rounded" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 bg-sage-50 rounded-xl" />
            ))}
          </div>
          <div className="h-96 bg-sage-50 rounded-xl" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
            <Shield className="w-8 h-8 text-sage-500" />
            Super Admin
          </h1>
          <p className="text-sage-600">
            {venues.length} venue{venues.length !== 1 ? 's' : ''} across {orgs.length} organisation{orgs.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href="/super-admin/pipeline-health"
            className="flex items-center gap-2 bg-sage-100 hover:bg-sage-200 text-sage-700 font-medium rounded-lg px-4 py-2.5 transition-colors text-sm"
          >
            <BarChart3 className="w-4 h-4" />
            Pipeline Health
          </a>
          <a
            href="/onboarding"
            className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 text-white font-medium rounded-lg px-5 py-2.5 transition-colors text-sm"
          >
            <Plus className="w-4 h-4" />
            Add Venue
          </a>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface rounded-xl p-5 shadow-sm border border-border">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-sage-500" />
            <span className="text-sm text-sage-500 font-medium">Inquiries (month)</span>
          </div>
          <p className="text-2xl font-bold text-sage-900 tabular-nums">{totalInquiries}</p>
        </div>

        <div className="bg-surface rounded-xl p-5 shadow-sm border border-border">
          <div className="flex items-center gap-2 mb-2">
            <Users className="w-4 h-4 text-teal-500" />
            <span className="text-sm text-sage-500 font-medium">Bookings (month)</span>
          </div>
          <p className="text-2xl font-bold text-sage-900 tabular-nums">{totalBookings}</p>
        </div>

        <div className="bg-surface rounded-xl p-5 shadow-sm border border-border">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4 text-green-500" />
            <span className="text-sm text-sage-500 font-medium">Revenue (month)</span>
          </div>
          <p className="text-2xl font-bold text-sage-900 tabular-nums">{fmt$(totalRevenue)}</p>
        </div>

        <div className="bg-surface rounded-xl p-5 shadow-sm border border-border">
          <div className="flex items-center gap-2 mb-2">
            <Bot className="w-4 h-4 text-amber-500" />
            <span className="text-sm text-sage-500 font-medium">AI Cost (month)</span>
          </div>
          <p className="text-2xl font-bold text-sage-900 tabular-nums">{fmtCost(totalAICost)}</p>
        </div>
      </div>

      {/* Organisation Overview */}
      {orgs.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
          <h2 className="font-heading text-lg font-semibold text-sage-900 mb-3 flex items-center gap-2">
            <Building2 className="w-5 h-5 text-sage-500" />
            Organisations
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {orgs.map((org) => {
              const orgVenues = venues.filter((v) => v.org_id === org.id)
              return (
                <div key={org.id} className="bg-warm-white border border-border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-sm font-semibold text-sage-900">{org.name}</h3>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                      planBadge(org.plan_tier as VenueRow['plan_tier']).bg
                    } ${planBadge(org.plan_tier as VenueRow['plan_tier']).text}`}>
                      {planBadge(org.plan_tier as VenueRow['plan_tier']).label}
                    </span>
                  </div>
                  <p className="text-xs text-sage-500">
                    {orgVenues.length} venue{orgVenues.length !== 1 ? 's' : ''}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1">
          {['all', 'active', 'trial', 'suspended', 'churned'].map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors capitalize ${
                statusFilter === status
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {status}
              {status !== 'all' && (
                <span className="ml-1.5 text-xs text-sage-400">
                  {venues.filter((v) => v.status === status).length}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search venues..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-border rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
          />
        </div>
      </div>

      {/* Venue Table */}
      <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
        {filteredVenues.length === 0 ? (
          <div className="p-12 text-center">
            <Building2 className="w-12 h-12 text-sage-300 mx-auto mb-4" />
            <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
              {searchQuery ? 'No matching venues' : 'No venues yet'}
            </h3>
            <p className="text-sm text-sage-500 max-w-md mx-auto">
              {searchQuery
                ? `No venues match "${searchQuery}".`
                : 'Get started by adding your first venue.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th
                    className="px-5 py-3 font-medium text-sage-500 cursor-pointer hover:text-sage-700 select-none"
                    onClick={() => toggleSort('name')}
                  >
                    <span className="flex items-center gap-1">
                      Venue <SortIcon field="name" />
                    </span>
                  </th>
                  <th
                    className="px-5 py-3 font-medium text-sage-500 cursor-pointer hover:text-sage-700 select-none"
                    onClick={() => toggleSort('status')}
                  >
                    <span className="flex items-center gap-1">
                      Status <SortIcon field="status" />
                    </span>
                  </th>
                  <th className="px-5 py-3 font-medium text-sage-500">Plan</th>
                  <th
                    className="px-5 py-3 font-medium text-sage-500 text-right cursor-pointer hover:text-sage-700 select-none"
                    onClick={() => toggleSort('inquiries_this_month')}
                  >
                    <span className="flex items-center gap-1 justify-end">
                      Inquiries <SortIcon field="inquiries_this_month" />
                    </span>
                  </th>
                  <th className="px-5 py-3 font-medium text-sage-500 text-right">Bookings</th>
                  <th
                    className="px-5 py-3 font-medium text-sage-500 text-right cursor-pointer hover:text-sage-700 select-none"
                    onClick={() => toggleSort('revenue_this_month')}
                  >
                    <span className="flex items-center gap-1 justify-end">
                      Revenue <SortIcon field="revenue_this_month" />
                    </span>
                  </th>
                  <th
                    className="px-5 py-3 font-medium text-sage-500 text-right cursor-pointer hover:text-sage-700 select-none"
                    onClick={() => toggleSort('ai_cost_this_month')}
                  >
                    <span className="flex items-center gap-1 justify-end">
                      AI Cost <SortIcon field="ai_cost_this_month" />
                    </span>
                  </th>
                  <th className="px-5 py-3 w-12" />
                </tr>
              </thead>
              <tbody>
                {filteredVenues.map((venue) => {
                  const sb = statusBadge(venue.status)
                  const pb = planBadge(venue.plan_tier)

                  return (
                    <tr key={venue.id} className="border-b border-border/50 hover:bg-sage-50/50 transition-colors">
                      <td className="px-5 py-3.5">
                        <div>
                          <p className="font-medium text-sage-900">{venue.name}</p>
                          <p className="text-xs text-sage-400">{venue.slug}.bloomhouse.ai</p>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${sb.bg} ${sb.text}`}>
                          {sb.label}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${pb.bg} ${pb.text}`}>
                          {pb.label}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums text-sage-700">
                        {venue.inquiries_this_month}
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums text-sage-700">
                        {venue.bookings_this_month}
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums font-medium text-sage-900">
                        {fmt$(venue.revenue_this_month)}
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums text-sage-600">
                        {fmtCost(venue.ai_cost_this_month)}
                      </td>
                      <td className="px-5 py-3.5">
                        <a
                          href={`/agent/inbox?venue=${venue.id}`}
                          className="p-1.5 rounded-md text-sage-400 hover:text-sage-600 hover:bg-sage-100 transition-colors inline-flex"
                          title="Open venue"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Platform stats footer */}
      <div className="bg-sage-50 rounded-xl p-4 flex items-center justify-between text-sm text-sage-600">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-sage-400" />
          <span>
            Platform total: {venues.length} venues, {venues.filter((v) => v.status === 'active').length} active
          </span>
        </div>
        <span className="text-sage-400">
          Data refreshes on page load
        </span>
      </div>
    </div>
  )
}
