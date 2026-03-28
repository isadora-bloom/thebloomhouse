'use client'

import { useState, useEffect, useCallback } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  Heart,
  Calendar,
  Users,
  DollarSign,
  ChevronDown,
  ChevronUp,
  ArrowUpDown,
  CheckCircle,
  Clock,
  XCircle,
  Search,
  ListChecks,
  Eye,
  ExternalLink,
} from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

// TODO: Replace with venue context from auth/session
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Person {
  id: string
  wedding_id: string
  first_name: string
  last_name: string
  role: string
}

interface TimelineItem {
  id: string
  wedding_id: string
  title: string
  due_date: string | null
  completed: boolean
  created_at: string
}

interface BudgetItem {
  id: string
  wedding_id: string
  category: string
  estimated: number
  actual: number | null
}

interface ChecklistItem {
  id: string
  wedding_id: string
  title: string
  completed: boolean
}

interface Wedding {
  id: string
  venue_id: string
  wedding_date: string | null
  guest_count: number | null
  status: string
  booking_value: number | null
  created_at: string
  people: Person[]
  timeline: TimelineItem[]
  budget: BudgetItem[]
  checklist_items: ChecklistItem[]
}

type StatusFilter = 'all' | 'booked' | 'completed' | 'inquiry' | 'lost'
type SortKey = 'date' | 'status' | 'value'

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

function getCoupleNames(people: Person[]): string {
  const principals = people.filter(
    (p) => p.role === 'bride' || p.role === 'groom' || p.role === 'partner'
  )
  if (principals.length === 0) {
    // Fallback to first two people
    const first = people.slice(0, 2)
    return first.map((p) => p.first_name).join(' & ') || 'Unnamed'
  }
  return principals.map((p) => p.first_name).join(' & ')
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const target = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'TBD'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function fmt$(value: number | null): string {
  if (value == null) return '--'
  return `$${Math.round(value).toLocaleString()}`
}

function statusConfig(status: string): {
  label: string
  className: string
  icon: React.ComponentType<{ className?: string }>
} {
  switch (status.toLowerCase()) {
    case 'booked':
      return {
        label: 'Booked',
        className: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
        icon: CheckCircle,
      }
    case 'completed':
      return {
        label: 'Completed',
        className: 'bg-teal-50 text-teal-700 border border-teal-200',
        icon: CheckCircle,
      }
    case 'inquiry':
      return {
        label: 'Inquiry',
        className: 'bg-gold-50 text-gold-700 border border-gold-200',
        icon: Clock,
      }
    case 'lost':
      return {
        label: 'Lost',
        className: 'bg-sage-50 text-sage-500 border border-sage-200',
        icon: XCircle,
      }
    default:
      return {
        label: status,
        className: 'bg-sage-50 text-sage-600 border border-sage-200',
        icon: Clock,
      }
  }
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function WeddingCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-36 bg-sage-100 rounded" />
          <div className="h-5 w-20 bg-sage-100 rounded-full" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="h-4 bg-sage-50 rounded" />
          <div className="h-4 bg-sage-50 rounded" />
          <div className="h-4 bg-sage-50 rounded" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Wedding Card
// ---------------------------------------------------------------------------

function WeddingCard({ wedding, venueSlug }: { wedding: Wedding; venueSlug: string | null }) {
  const [expanded, setExpanded] = useState(false)

  const coupleNames = getCoupleNames(wedding.people)
  const days = daysUntil(wedding.wedding_date)
  const config = statusConfig(wedding.status)
  const StatusIcon = config.icon

  const completedChecklist = wedding.checklist_items.filter((c) => c.completed).length
  const totalChecklist = wedding.checklist_items.length

  const budgetEstimated = wedding.budget.reduce((sum, b) => sum + b.estimated, 0)
  const budgetActual = wedding.budget.reduce((sum, b) => sum + (b.actual ?? 0), 0)

  const upcomingTimeline = wedding.timeline
    .filter((t) => !t.completed && t.due_date)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
    .slice(0, 5)

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm hover:shadow-md transition-shadow">
      {/* Main card content */}
      <div
        className="p-6 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <h3 className="font-heading text-lg font-semibold text-sage-900 truncate">
              {coupleNames}
            </h3>
            <div className="flex items-center gap-3 mt-1 text-sm text-sage-500">
              <span className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" />
                {formatDate(wedding.wedding_date)}
              </span>
              {days !== null && days >= 0 && wedding.status !== 'completed' && wedding.status !== 'lost' && (
                <span className={cn(
                  'text-xs font-medium px-2 py-0.5 rounded-full',
                  days <= 30
                    ? 'bg-red-50 text-red-700'
                    : days <= 90
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-teal-50 text-teal-700'
                )}>
                  {days === 0 ? 'Today' : `${days}d away`}
                </span>
              )}
              {days !== null && days < 0 && wedding.status !== 'completed' && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-sage-100 text-sage-500">
                  {Math.abs(days)}d ago
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${config.className}`}>
              <StatusIcon className="w-3 h-3" />
              {config.label}
            </span>
            {expanded ? (
              <ChevronUp className="w-4 h-4 text-sage-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-sage-400" />
            )}
          </div>
        </div>

        {/* Quick stats */}
        <div className="flex items-center gap-4 text-sm">
          {wedding.guest_count != null && (
            <span className="flex items-center gap-1.5 text-sage-600">
              <Users className="w-3.5 h-3.5 text-sage-400" />
              {wedding.guest_count} guests
            </span>
          )}
          {wedding.booking_value != null && (
            <span className="flex items-center gap-1.5 text-sage-600">
              <DollarSign className="w-3.5 h-3.5 text-sage-400" />
              {fmt$(wedding.booking_value)}
            </span>
          )}
          {totalChecklist > 0 && (
            <span className="flex items-center gap-1.5 text-sage-600">
              <ListChecks className="w-3.5 h-3.5 text-sage-400" />
              {completedChecklist}/{totalChecklist} tasks
            </span>
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-6 pb-6 pt-0 space-y-5 border-t border-border mt-0 pt-5">
          {/* Timeline */}
          {upcomingTimeline.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
                Upcoming Timeline
              </h4>
              <div className="space-y-2">
                {upcomingTimeline.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 text-sm">
                    <div className="w-2 h-2 rounded-full bg-teal-400 shrink-0" />
                    <span className="text-sage-800 flex-1">{item.title}</span>
                    {item.due_date && (
                      <span className="text-xs text-sage-500">
                        {formatDate(item.due_date)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Budget summary */}
          {wedding.budget.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
                Budget Summary
              </h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-warm-white rounded-lg p-3 border border-sage-100">
                  <p className="text-xs text-sage-500 mb-1">Estimated</p>
                  <p className="text-lg font-bold text-sage-900 tabular-nums">
                    {fmt$(budgetEstimated)}
                  </p>
                </div>
                <div className="bg-warm-white rounded-lg p-3 border border-sage-100">
                  <p className="text-xs text-sage-500 mb-1">Actual Spent</p>
                  <p className="text-lg font-bold text-sage-900 tabular-nums">
                    {fmt$(budgetActual)}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Checklist progress */}
          {totalChecklist > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
                Checklist Progress
              </h4>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2 bg-sage-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-teal-500 rounded-full transition-all"
                    style={{
                      width: `${totalChecklist > 0 ? (completedChecklist / totalChecklist) * 100 : 0}%`,
                    }}
                  />
                </div>
                <span className="text-sm font-medium text-sage-700 tabular-nums">
                  {completedChecklist}/{totalChecklist}
                </span>
              </div>
            </div>
          )}

          {/* Portal action buttons */}
          <div className="flex items-center gap-2 pt-2 border-t border-sage-100">
            <Link
              href={`/portal/weddings/${wedding.id}/portal`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sage-600 text-white hover:bg-sage-700 transition-colors"
            >
              <Eye className="w-3.5 h-3.5" />
              View Portal
            </Link>
            {venueSlug && (
              <Link
                href={`/couple/${venueSlug}?wedding=${wedding.id}`}
                target="_blank"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open as Couple
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function WeddingsPage() {
  const [weddings, setWeddings] = useState<Wedding[]>([])
  const [venueSlug, setVenueSlug] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortBy, setSortBy] = useState<SortKey>('date')
  const [searchQuery, setSearchQuery] = useState('')

  // ---- Fetch data ----
  const fetchData = useCallback(async () => {
    const supabase = getSupabase()

    try {
      // Fetch venue slug for "Open as Couple" links
      const { data: venueData } = await supabase
        .from('venues')
        .select('slug')
        .eq('id', VENUE_ID)
        .single()
      if (venueData) setVenueSlug(venueData.slug)

      let query = supabase
        .from('weddings')
        .select(`
          *,
          people (*),
          timeline (*),
          budget (*),
          checklist_items (*)
        `)
        .eq('venue_id', VENUE_ID)

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter)
      }

      const { data, error: fetchErr } = await query

      if (fetchErr) throw fetchErr

      setWeddings((data ?? []) as unknown as Wedding[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch weddings:', err)
      setError('Failed to load weddings')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    setLoading(true)
    fetchData()
  }, [fetchData])

  // ---- Filter + Sort ----
  const filteredWeddings = weddings.filter((w) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    const names = getCoupleNames(w.people).toLowerCase()
    return names.includes(q)
  })

  const sortedWeddings = [...filteredWeddings].sort((a, b) => {
    switch (sortBy) {
      case 'date': {
        const aDate = a.wedding_date ?? '9999-12-31'
        const bDate = b.wedding_date ?? '9999-12-31'
        return aDate.localeCompare(bDate)
      }
      case 'status': {
        const order: Record<string, number> = { inquiry: 0, booked: 1, completed: 2, lost: 3 }
        return (order[a.status] ?? 4) - (order[b.status] ?? 4)
      }
      case 'value':
        return (b.booking_value ?? 0) - (a.booking_value ?? 0)
    }
  })

  const statusCounts = {
    all: weddings.length,
    booked: weddings.filter((w) => w.status === 'booked').length,
    completed: weddings.filter((w) => w.status === 'completed').length,
    inquiry: weddings.filter((w) => w.status === 'inquiry').length,
    lost: weddings.filter((w) => w.status === 'lost').length,
  }

  const statuses: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'booked', label: 'Booked' },
    { key: 'completed', label: 'Completed' },
    { key: 'inquiry', label: 'Inquiry' },
    { key: 'lost', label: 'Lost' },
  ]

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'date', label: 'By Date' },
    { key: 'status', label: 'By Status' },
    { key: 'value', label: 'By Value' },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Weddings
            {!loading && (
              <span className="ml-2 text-lg font-normal text-sage-500">
                ({statusCounts[statusFilter]})
              </span>
            )}
          </h1>
          <p className="text-sage-600">
            Active weddings and status management.
          </p>
        </div>
      </div>

      {/* ---- Error state ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Heart className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchData() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Filters + Sort + Search ---- */}
      <div className="flex flex-col gap-4">
        {/* Status pills */}
        <div className="flex flex-wrap gap-2">
          {statuses.map((s) => (
            <button
              key={s.key}
              onClick={() => setStatusFilter(s.key)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                statusFilter === s.key
                  ? 'bg-sage-600 text-white'
                  : 'bg-sage-100 text-sage-700 hover:bg-sage-200'
              )}
            >
              {s.label}
              <span className={cn(
                'ml-1.5 px-1.5 py-0.5 rounded-full text-[10px]',
                statusFilter === s.key
                  ? 'bg-sage-500 text-white'
                  : 'bg-sage-200 text-sage-600'
              )}>
                {statusCounts[s.key]}
              </span>
            </button>
          ))}
        </div>

        {/* Sort + search row */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2">
            <ArrowUpDown className="w-4 h-4 text-sage-400" />
            {sortOptions.map((opt) => (
              <button
                key={opt.key}
                onClick={() => setSortBy(opt.key)}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
                  sortBy === opt.key
                    ? 'bg-sage-200 text-sage-900'
                    : 'text-sage-500 hover:text-sage-700'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="relative sm:ml-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
            <input
              type="text"
              placeholder="Search couples..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
            />
          </div>
        </div>
      </div>

      {/* ---- Wedding Cards ---- */}
      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <WeddingCardSkeleton key={i} />
          ))}
        </div>
      ) : sortedWeddings.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Heart className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {searchQuery ? 'No matching weddings' : 'No weddings found'}
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {searchQuery
              ? `No weddings match "${searchQuery}". Try a different search.`
              : statusFilter !== 'all'
                ? `No weddings with "${statusFilter}" status. Try a different filter.`
                : 'Weddings will appear here once couples are added to the system.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {sortedWeddings.map((wedding) => (
            <WeddingCard key={wedding.id} wedding={wedding} venueSlug={venueSlug} />
          ))}
        </div>
      )}
    </div>
  )
}
