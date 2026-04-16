'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  Printer,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Calendar,
  Users,
  DollarSign,
  CheckSquare,
  Clock,
  Heart,
  MessageCircle,
  Armchair,
  Store,
  BookOpen,
  Sparkles,
  Car,
  UtensilsCrossed,
  Flower2,
  Wine,
  ShieldAlert,
  Lightbulb,
  Camera,
  FileText,
  Package,
  Bed,
  Globe,
  ClipboardCheck,
  MessagesSquare,
  Download,
  CalendarPlus,
  Shield,
  Loader2,
  LayoutDashboard,
  Rocket,
  DoorOpen,
  HardHat,
  HeartHandshake,
  ImagePlus,
  UsersRound,
  ArrowLeft,
  Eye,
  Settings,
} from 'lucide-react'
import Link from 'next/link'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Person {
  id: string
  first_name: string
  last_name: string
  role: string
  email: string | null
  phone: string | null
}

interface TimelineItem {
  id: string
  title: string
  due_date: string | null
  completed: boolean
}

interface BudgetItem {
  id: string
  category: string
  item_name: string | null
  budgeted: number | null
  committed: number | null
}

interface ChecklistItem {
  id: string
  title: string
  completed: boolean
  category: string | null
}

interface Guest {
  id: string
  first_name: string
  last_name: string
  rsvp_status: string | null
  meal_choice: string | null
  table_assignment: string | null
}

interface SectionConfig {
  id: string
  section_key: string
  label: string
  description: string | null
  visibility: 'admin_only' | 'both' | 'off'
  sort_order: number
  icon: string | null
}

interface Wedding {
  id: string
  venue_id: string
  wedding_date: string | null
  guest_count: number | null
  status: string
  booking_value: number | null
  ceremony_time: string | null
  reception_time: string | null
  color_palette: string | null
  theme: string | null
  notes: string | null
  created_at: string
}

interface VenueInfo {
  slug: string
  name: string
}

// ---------------------------------------------------------------------------
// Icon map
// ---------------------------------------------------------------------------

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard, Rocket, MessageCircle, Heart, Clock, DollarSign, Users,
  Armchair, CheckSquare, Store, BookOpen, UsersRound, Sparkles, Car, DoorOpen,
  UtensilsCrossed, Flower2, HardHat, Wine, ShieldAlert, HeartHandshake,
  Lightbulb, Camera, FileText, Package, Bed, Globe, ClipboardCheck,
  MessagesSquare, ImagePlus, Download, CalendarPlus,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'TBD'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function fmt$(value: number | null): string {
  if (value == null) return '--'
  return `$${Math.round(value).toLocaleString()}`
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const target = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

function getCoupleNames(people: Person[]): string {
  const principals = people.filter(
    (p) => p.role === 'bride' || p.role === 'groom' || p.role === 'partner'
  )
  if (principals.length === 0) {
    const first = people.slice(0, 2)
    return first.map((p) => p.first_name).join(' & ') || 'Unnamed Wedding'
  }
  return principals.map((p) => p.first_name).join(' & ')
}

// ---------------------------------------------------------------------------
// Section Accordion
// ---------------------------------------------------------------------------

function SectionAccordion({
  section,
  children,
  stats,
  defaultOpen = false,
  venueSlug,
}: {
  section: SectionConfig
  children: React.ReactNode
  stats?: string
  defaultOpen?: boolean
  venueSlug: string | null
}) {
  const [open, setOpen] = useState(defaultOpen)
  const IconComponent = section.icon ? iconMap[section.icon] : LayoutDashboard
  const isAdminOnly = section.visibility === 'admin_only'

  const couplePageUrl = venueSlug
    ? `/couple/${venueSlug}/${section.section_key === 'dashboard' ? '' : section.section_key}`
    : null

  return (
    <div
      className={cn(
        'bg-surface border rounded-xl overflow-hidden print-section',
        isAdminOnly ? 'border-amber-200' : 'border-border'
      )}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 p-4 hover:bg-sage-50/50 transition-colors text-left"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-sage-400 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-sage-400 shrink-0" />
        )}
        <div
          className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
            isAdminOnly ? 'bg-amber-50 text-amber-600' : 'bg-sage-100 text-sage-600'
          )}
        >
          {IconComponent && <IconComponent className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-sage-900">{section.label}</span>
            {isAdminOnly && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200 no-print">
                <Shield className="w-2.5 h-2.5" />
                Admin Only
              </span>
            )}
          </div>
          {stats && (
            <span className="text-xs text-sage-500">{stats}</span>
          )}
        </div>
        {couplePageUrl && (
          <Link
            href={couplePageUrl}
            target="_blank"
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-teal-600 hover:text-teal-700 flex items-center gap-1 no-print shrink-0"
          >
            View Full <ExternalLink className="w-3 h-3" />
          </Link>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            window.print()
          }}
          className="text-sage-400 hover:text-sage-600 no-print shrink-0"
          title="Print this section"
        >
          <Printer className="w-3.5 h-3.5" />
        </button>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-0 border-t border-border/50">
          <div className="pt-3">
            {children}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data display components for each section type
// ---------------------------------------------------------------------------

function DashboardSummary({
  wedding,
  people,
  checklist,
  budget,
  guests,
}: {
  wedding: Wedding
  people: Person[]
  checklist: ChecklistItem[]
  budget: BudgetItem[]
  guests: Guest[]
}) {
  const days = daysUntil(wedding.wedding_date)
  const completedChecklist = checklist.filter((c) => c.completed).length
  const totalBudgetEst = budget.reduce((s, b) => s + (b.budgeted ?? 0), 0)
  const totalBudgetAct = budget.reduce((s, b) => s + (b.committed ?? 0), 0)
  const confirmedGuests = guests.filter((g) => g.rsvp_status === 'confirmed').length

  return (
    <div className="space-y-4">
      {/* Couple names */}
      <div className="flex items-center gap-3">
        <Heart className="w-5 h-5 text-rose-400" />
        <span className="text-lg font-heading font-semibold text-sage-900">
          {getCoupleNames(people)}
        </span>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100">
          <p className="text-xs text-sage-500 mb-1">Wedding Date</p>
          <p className="text-sm font-semibold text-sage-900">{formatDate(wedding.wedding_date)}</p>
          {days !== null && days >= 0 && (
            <p className={cn(
              'text-xs mt-1 font-medium',
              days <= 30 ? 'text-red-600' : days <= 90 ? 'text-amber-600' : 'text-teal-600'
            )}>
              {days === 0 ? 'Today!' : `${days} days away`}
            </p>
          )}
        </div>
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100">
          <p className="text-xs text-sage-500 mb-1">Guest Count</p>
          <p className="text-sm font-semibold text-sage-900">
            {confirmedGuests} confirmed / {wedding.guest_count ?? guests.length} expected
          </p>
        </div>
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100">
          <p className="text-xs text-sage-500 mb-1">Budget</p>
          <p className="text-sm font-semibold text-sage-900">
            {fmt$(totalBudgetAct)} / {fmt$(totalBudgetEst)}
          </p>
          {totalBudgetEst > 0 && (
            <div className="mt-1.5 h-1.5 bg-sage-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-teal-500 rounded-full"
                style={{ width: `${Math.min(100, (totalBudgetAct / totalBudgetEst) * 100)}%` }}
              />
            </div>
          )}
        </div>
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100">
          <p className="text-xs text-sage-500 mb-1">Checklist</p>
          <p className="text-sm font-semibold text-sage-900">
            {completedChecklist}/{checklist.length} complete
          </p>
          {checklist.length > 0 && (
            <div className="mt-1.5 h-1.5 bg-sage-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full"
                style={{ width: `${(completedChecklist / checklist.length) * 100}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Status + booking */}
      <div className="flex items-center gap-4 text-sm text-sage-600">
        <span>Status: <strong className="text-sage-900 capitalize">{wedding.status}</strong></span>
        {wedding.booking_value && (
          <span>Booking Value: <strong className="text-sage-900">{fmt$(wedding.booking_value)}</strong></span>
        )}
        {wedding.theme && (
          <span>Theme: <strong className="text-sage-900">{wedding.theme}</strong></span>
        )}
      </div>
    </div>
  )
}

function TimelineSection({ items }: { items: TimelineItem[] }) {
  const sorted = [...items].sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
  const upcoming = sorted.filter((t) => !t.completed)
  const completed = sorted.filter((t) => t.completed)

  return (
    <div className="space-y-3">
      {upcoming.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">Upcoming</p>
          <div className="space-y-1.5">
            {upcoming.slice(0, 10).map((item) => (
              <div key={item.id} className="flex items-center gap-3 text-sm">
                <div className="w-2 h-2 rounded-full bg-teal-400 shrink-0" />
                <span className="text-sage-800 flex-1">{item.title}</span>
                <span className="text-xs text-sage-500 tabular-nums">
                  {item.due_date ? formatDate(item.due_date) : '--'}
                </span>
              </div>
            ))}
            {upcoming.length > 10 && (
              <p className="text-xs text-sage-400 italic">+{upcoming.length - 10} more items</p>
            )}
          </div>
        </div>
      )}
      {completed.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">
            Completed ({completed.length})
          </p>
          <div className="space-y-1.5">
            {completed.slice(0, 5).map((item) => (
              <div key={item.id} className="flex items-center gap-3 text-sm opacity-60">
                <CheckSquare className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span className="text-sage-600 flex-1 line-through">{item.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {items.length === 0 && <p className="text-sm text-sage-400 italic">No timeline items yet.</p>}
    </div>
  )
}

function BudgetSection({ items }: { items: BudgetItem[] }) {
  // Group by category
  const byCategory: Record<string, { estimated: number; actual: number; count: number }> = {}
  for (const item of items) {
    const cat = item.category || 'Uncategorized'
    if (!byCategory[cat]) byCategory[cat] = { estimated: 0, actual: 0, count: 0 }
    byCategory[cat].estimated += item.budgeted ?? 0
    byCategory[cat].actual += item.committed ?? 0
    byCategory[cat].count++
  }

  const totalEst = items.reduce((s, b) => s + (b.budgeted ?? 0), 0)
  const totalAct = items.reduce((s, b) => s + (b.committed ?? 0), 0)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="bg-warm-white rounded-lg p-2.5 border border-sage-100">
          <p className="text-[10px] text-sage-500 uppercase">Estimated</p>
          <p className="text-sm font-bold text-sage-900 tabular-nums">{fmt$(totalEst)}</p>
        </div>
        <div className="bg-warm-white rounded-lg p-2.5 border border-sage-100">
          <p className="text-[10px] text-sage-500 uppercase">Actual</p>
          <p className="text-sm font-bold text-sage-900 tabular-nums">{fmt$(totalAct)}</p>
        </div>
        <div className="bg-warm-white rounded-lg p-2.5 border border-sage-100">
          <p className="text-[10px] text-sage-500 uppercase">Remaining</p>
          <p className={cn(
            'text-sm font-bold tabular-nums',
            totalEst - totalAct >= 0 ? 'text-emerald-700' : 'text-red-600'
          )}>
            {fmt$(totalEst - totalAct)}
          </p>
        </div>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-sage-100">
            <th className="text-left py-1.5 text-sage-500 font-medium">Category</th>
            <th className="text-right py-1.5 text-sage-500 font-medium">Items</th>
            <th className="text-right py-1.5 text-sage-500 font-medium">Estimated</th>
            <th className="text-right py-1.5 text-sage-500 font-medium">Actual</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(byCategory)
            .sort(([, a], [, b]) => b.estimated - a.estimated)
            .map(([cat, data]) => (
              <tr key={cat} className="border-b border-sage-50">
                <td className="py-1.5 text-sage-800">{cat}</td>
                <td className="text-right py-1.5 text-sage-600 tabular-nums">{data.count}</td>
                <td className="text-right py-1.5 text-sage-800 tabular-nums">{fmt$(data.estimated)}</td>
                <td className="text-right py-1.5 text-sage-800 tabular-nums">{fmt$(data.actual)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {items.length === 0 && <p className="text-sm text-sage-400 italic">No budget items yet.</p>}
    </div>
  )
}

function GuestSection({ guests }: { guests: Guest[] }) {
  const statusCounts = {
    confirmed: guests.filter((g) => g.rsvp_status === 'confirmed').length,
    pending: guests.filter((g) => !g.rsvp_status || g.rsvp_status === 'pending').length,
    declined: guests.filter((g) => g.rsvp_status === 'declined').length,
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-sm">
        <span className="text-sage-600">
          Total: <strong className="text-sage-900">{guests.length}</strong>
        </span>
        <span className="text-emerald-600">
          Confirmed: <strong>{statusCounts.confirmed}</strong>
        </span>
        <span className="text-amber-600">
          Pending: <strong>{statusCounts.pending}</strong>
        </span>
        <span className="text-red-600">
          Declined: <strong>{statusCounts.declined}</strong>
        </span>
      </div>
      {guests.length > 0 && (
        <div className="max-h-48 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-sage-100">
                <th className="text-left py-1.5 text-sage-500 font-medium">Name</th>
                <th className="text-left py-1.5 text-sage-500 font-medium">RSVP</th>
                <th className="text-left py-1.5 text-sage-500 font-medium">Meal</th>
                <th className="text-left py-1.5 text-sage-500 font-medium">Table</th>
              </tr>
            </thead>
            <tbody>
              {guests.slice(0, 25).map((g) => (
                <tr key={g.id} className="border-b border-sage-50">
                  <td className="py-1.5 text-sage-800">{g.first_name} {g.last_name}</td>
                  <td className="py-1.5">
                    <span className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] font-medium',
                      g.rsvp_status === 'confirmed' ? 'bg-emerald-50 text-emerald-700' :
                      g.rsvp_status === 'declined' ? 'bg-red-50 text-red-700' :
                      'bg-gray-50 text-gray-600'
                    )}>
                      {g.rsvp_status || 'pending'}
                    </span>
                  </td>
                  <td className="py-1.5 text-sage-600">{g.meal_choice || '--'}</td>
                  <td className="py-1.5 text-sage-600">{g.table_assignment || '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {guests.length > 25 && (
            <p className="text-xs text-sage-400 italic mt-2">+{guests.length - 25} more guests</p>
          )}
        </div>
      )}
      {guests.length === 0 && <p className="text-sm text-sage-400 italic">No guests added yet.</p>}
    </div>
  )
}

function ChecklistSection({ items }: { items: ChecklistItem[] }) {
  const completed = items.filter((c) => c.completed)
  const remaining = items.filter((c) => !c.completed)

  // Group by category
  const byCategory: Record<string, { done: number; total: number }> = {}
  for (const item of items) {
    const cat = item.category || 'General'
    if (!byCategory[cat]) byCategory[cat] = { done: 0, total: 0 }
    byCategory[cat].total++
    if (item.completed) byCategory[cat].done++
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-sm">
        <span className="text-sage-600">
          {completed.length}/{items.length} complete
        </span>
        {items.length > 0 && (
          <div className="flex-1 h-2 bg-sage-100 rounded-full overflow-hidden max-w-xs">
            <div
              className="h-full bg-emerald-500 rounded-full"
              style={{ width: `${(completed.length / items.length) * 100}%` }}
            />
          </div>
        )}
      </div>
      {Object.keys(byCategory).length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {Object.entries(byCategory).map(([cat, data]) => (
            <div key={cat} className="bg-warm-white rounded-lg px-3 py-2 border border-sage-100">
              <p className="text-xs text-sage-500 truncate">{cat}</p>
              <p className="text-sm font-semibold text-sage-900 tabular-nums">
                {data.done}/{data.total}
              </p>
            </div>
          ))}
        </div>
      )}
      {remaining.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">Remaining</p>
          <div className="space-y-1">
            {remaining.slice(0, 8).map((item) => (
              <div key={item.id} className="flex items-center gap-2 text-sm">
                <div className="w-3.5 h-3.5 rounded border border-sage-300 shrink-0" />
                <span className="text-sage-800">{item.title}</span>
              </div>
            ))}
            {remaining.length > 8 && (
              <p className="text-xs text-sage-400 italic">+{remaining.length - 8} more tasks</p>
            )}
          </div>
        </div>
      )}
      {items.length === 0 && <p className="text-sm text-sage-400 italic">No checklist items yet.</p>}
    </div>
  )
}

function PeopleSection({ people }: { people: Person[] }) {
  return (
    <div className="space-y-2">
      {people.map((p) => (
        <div key={p.id} className="flex items-center gap-3 text-sm">
          <div className="w-7 h-7 rounded-full bg-sage-100 flex items-center justify-center text-sage-600 text-xs font-semibold shrink-0">
            {p.first_name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-sage-900 font-medium">{p.first_name} {p.last_name}</span>
            <span className="text-sage-500 ml-2 text-xs capitalize">({p.role})</span>
          </div>
          {p.email && <span className="text-xs text-sage-500 truncate">{p.email}</span>}
          {p.phone && <span className="text-xs text-sage-500">{p.phone}</span>}
        </div>
      ))}
      {people.length === 0 && <p className="text-sm text-sage-400 italic">No people added yet.</p>}
    </div>
  )
}

function GenericDataSection({ label }: { label: string }) {
  return (
    <p className="text-sm text-sage-400 italic">
      {label} data will appear here once populated.
    </p>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function AdminPortalViewerPage() {
  const params = useParams()
  const weddingId = params.id as string

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [wedding, setWedding] = useState<Wedding | null>(null)
  const [venue, setVenue] = useState<VenueInfo | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [budget, setBudget] = useState<BudgetItem[]>([])
  const [checklist, setChecklist] = useState<ChecklistItem[]>([])
  const [guests, setGuests] = useState<Guest[]>([])
  const [sections, setSections] = useState<SectionConfig[]>([])

  const fetchData = useCallback(async () => {
    try {
      const supabase = createClient()

      // Fetch wedding
      const { data: weddingData, error: weddingErr } = await supabase
        .from('weddings')
        .select('*')
        .eq('id', weddingId)
        .single()

      if (weddingErr) throw weddingErr
      setWedding(weddingData as Wedding)

      const venueId = weddingData.venue_id

      // Fetch venue info
      const { data: venueData } = await supabase
        .from('venues')
        .select('slug, name')
        .eq('id', venueId)
        .single()

      if (venueData) setVenue(venueData as VenueInfo)

      // Fetch all related data in parallel
      const [
        peopleRes,
        timelineRes,
        budgetRes,
        checklistRes,
        guestRes,
        sectionRes,
      ] = await Promise.all([
        supabase.from('people').select('*').eq('wedding_id', weddingId),
        supabase.from('timeline').select('*').eq('wedding_id', weddingId).order('due_date', { ascending: true }),
        supabase.from('budget_items').select('*').eq('wedding_id', weddingId).order('category'),
        supabase.from('checklist_items').select('*').eq('wedding_id', weddingId),
        supabase.from('guest_list').select('*').eq('wedding_id', weddingId).order('last_name'),
        supabase.from('portal_section_config').select('*').eq('venue_id', venueId).neq('visibility', 'off').order('sort_order'),
      ])

      setPeople((peopleRes.data ?? []) as Person[])
      setTimeline((timelineRes.data ?? []) as TimelineItem[])
      setBudget((budgetRes.data ?? []) as BudgetItem[])
      setChecklist((checklistRes.data ?? []) as ChecklistItem[])
      setGuests((guestRes.data ?? []) as Guest[])
      setSections((sectionRes.data ?? []) as SectionConfig[])

      setError(null)
    } catch (err) {
      console.error('Failed to fetch wedding data:', err)
      setError('Failed to load wedding data')
    } finally {
      setLoading(false)
    }
  }, [weddingId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const coupleNames = people.length > 0 ? getCoupleNames(people) : 'Loading...'

  // Render content for a specific section
  function renderSectionContent(section: SectionConfig) {
    switch (section.section_key) {
      case 'dashboard':
        return wedding ? (
          <DashboardSummary
            wedding={wedding}
            people={people}
            checklist={checklist}
            budget={budget}
            guests={guests}
          />
        ) : null
      case 'timeline':
        return <TimelineSection items={timeline} />
      case 'budget':
        return <BudgetSection items={budget} />
      case 'guests':
      case 'seating':
        return <GuestSection guests={guests} />
      case 'checklist':
        return <ChecklistSection items={checklist} />
      case 'party':
      case 'wedding-details':
        return <PeopleSection people={people} />
      default:
        return <GenericDataSection label={section.label} />
    }
  }

  // Stats string for each section
  function getSectionStats(section: SectionConfig): string | undefined {
    switch (section.section_key) {
      case 'timeline':
        return `${timeline.filter((t) => !t.completed).length} upcoming, ${timeline.filter((t) => t.completed).length} done`
      case 'budget':
        return `${budget.length} items, ${fmt$(budget.reduce((s, b) => s + (b.budgeted ?? 0), 0))} est.`
      case 'guests':
        return `${guests.length} guests, ${guests.filter((g) => g.rsvp_status === 'confirmed').length} confirmed`
      case 'checklist':
        return `${checklist.filter((c) => c.completed).length}/${checklist.length} complete`
      case 'party':
      case 'wedding-details':
        return `${people.length} people`
      default:
        return undefined
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-sage-100 rounded mb-2" />
          <div className="h-4 w-64 bg-sage-50 rounded" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-xl p-4 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-sage-100 rounded-lg" />
                <div className="space-y-1.5 flex-1">
                  <div className="h-4 w-28 bg-sage-100 rounded" />
                  <div className="h-3 w-40 bg-sage-50 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
        <p className="text-sm text-red-700 mb-3">{error}</p>
        <button
          onClick={() => { setLoading(true); fetchData() }}
          className="text-sm font-medium text-red-600 hover:text-red-800"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6 print-container">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 no-print">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href="/portal/weddings"
              className="text-sage-400 hover:text-sage-600 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <span className="text-xs text-sage-400">Back to Weddings</span>
          </div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            {coupleNames}
          </h1>
          <p className="text-sage-600">
            Admin portal view{wedding?.wedding_date ? ` — ${formatDate(wedding.wedding_date)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/portal/weddings/${weddingId}/print`}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-surface border border-border text-sage-700 hover:bg-sage-50 transition-colors"
          >
            <Printer className="w-4 h-4" />
            Print Day-of Package
          </Link>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-surface border border-border text-sage-700 hover:bg-sage-50 transition-colors"
          >
            <Printer className="w-4 h-4" />
            Print
          </button>
          {venue?.slug && (
            <Link
              href={`/couple/${venue.slug}`}
              target="_blank"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-teal-600 text-white hover:bg-teal-700 transition-colors"
            >
              <Eye className="w-4 h-4" />
              Open as Couple
              <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>
      </div>

      {/* Print header (only visible in print) */}
      <div className="hidden print:block mb-6">
        <h1 className="text-2xl font-bold">{coupleNames}</h1>
        <p className="text-sm text-gray-600">
          {wedding?.wedding_date ? formatDate(wedding.wedding_date) : 'Date TBD'}
          {venue?.name ? ` — ${venue.name}` : ''}
        </p>
        <hr className="mt-3" />
      </div>

      {/* Section accordions */}
      <div className="space-y-3">
        {sections.map((section, idx) => (
          <SectionAccordion
            key={section.id}
            section={section}
            stats={getSectionStats(section)}
            defaultOpen={idx === 0}
            venueSlug={venue?.slug ?? null}
          >
            {renderSectionContent(section)}
          </SectionAccordion>
        ))}
      </div>

      {sections.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <Settings className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No sections configured
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            Configure portal sections in{' '}
            <Link href="/portal/section-settings" className="text-teal-600 hover:underline">
              Section Settings
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  )
}
