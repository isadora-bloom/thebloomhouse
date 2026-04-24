'use client'

import { useState, useEffect, useCallback } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createBrowserClient } from '@supabase/ssr'
import { VenueChip } from '@/components/intel/venue-chip'
import { normalizeSource } from '@/lib/services/normalize-source'
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
  User,
  Plus,
  X,
  Mail,
  Send,
  Loader2,
  UserCheck,
  UserPlus,
} from 'lucide-react'
import { CommunicationPulse } from './communication-pulse'
import Link from 'next/link'
import { cn } from '@/lib/utils'

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
  event_code: string | null
  couple_invited_at: string | null
  couple_registered_at: string | null
  people: Person[]
  timeline: TimelineItem[]
  budget: BudgetItem[]
  checklist_items: ChecklistItem[]
  venue_name?: string | null
  comm_pulse_count?: number
}

// Weddings portal list — the "real weddings" surface. Inquiries live
// on /agent/leads (email funnel); this page is for couples who've at
// least booked a tour. Anyone still in 'inquiry' status is excluded
// from the base query below; the filter chips let a coordinator
// narrow further (tour/proposal/booked/completed/lost).
type StatusFilter = 'all' | 'tour_scheduled' | 'proposal_sent' | 'booked' | 'completed' | 'lost'

// Status values allowed on this surface. 'inquiry' is intentionally
// absent — if a coordinator wants inquiries, they go to Agent mode.
const WEDDING_STATUSES = [
  'tour_scheduled',
  'tour_completed',
  'proposal_sent',
  'booked',
  'completed',
  'lost',
] as const
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

function WeddingCard({ wedding, venueSlug, showVenueChip }: { wedding: Wedding; venueSlug: string | null; showVenueChip: boolean }) {
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
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-heading text-lg font-semibold text-sage-900 truncate">
                {coupleNames}
              </h3>
              {showVenueChip && <VenueChip venueName={wedding.venue_name} size="sm" />}
            </div>
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
        <div className="flex items-center gap-4 text-sm flex-wrap">
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
          <CommunicationPulse messageCount={wedding.comm_pulse_count ?? 0} />

          {/* Invitation status badge */}
          {wedding.couple_registered_at ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
              <UserCheck className="w-3 h-3" />
              Registered
            </span>
          ) : wedding.event_code && wedding.couple_invited_at ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
              <Mail className="w-3 h-3" />
              Invited (pending)
            </span>
          ) : !wedding.event_code ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sage-50 text-sage-500 border border-sage-200">
              <UserPlus className="w-3 h-3" />
              Not invited
            </span>
          ) : null}
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
              href={`/portal/weddings/${wedding.id}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sage-800 text-white hover:bg-sage-900 transition-colors"
            >
              <User className="w-3.5 h-3.5" />
              View Profile
            </Link>
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
// Source options
// ---------------------------------------------------------------------------

const SOURCE_OPTIONS = [
  { value: 'the_knot', label: 'The Knot' },
  { value: 'wedding_wire', label: 'Wedding Wire' },
  { value: 'google', label: 'Google' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'referral', label: 'Referral' },
  { value: 'website', label: 'Website' },
  { value: 'walk_in', label: 'Walk-In' },
  { value: 'other', label: 'Other' },
]

// ---------------------------------------------------------------------------
// New Booking Modal
// ---------------------------------------------------------------------------

interface BookingForm {
  partner1FirstName: string
  partner1LastName: string
  partner1Email: string
  partner1Phone: string
  partner2FirstName: string
  partner2LastName: string
  partner2Email: string
  partner2Phone: string
  weddingDate: string
  guestCount: string
  source: string
  estimatedValue: string
  notes: string
  sendInvite: boolean
}

const emptyForm: BookingForm = {
  partner1FirstName: '',
  partner1LastName: '',
  partner1Email: '',
  partner1Phone: '',
  partner2FirstName: '',
  partner2LastName: '',
  partner2Email: '',
  partner2Phone: '',
  weddingDate: '',
  guestCount: '',
  source: 'website',
  estimatedValue: '',
  notes: '',
  sendInvite: true,
}

function NewBookingModal({
  open,
  onClose,
  venueId,
  venueSlug,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  venueId: string
  venueSlug: string | null
  onCreated: () => void
}) {
  const [form, setForm] = useState<BookingForm>({ ...emptyForm })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof BookingForm>(key: K, value: BookingForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!form.partner1FirstName.trim() || !form.partner1LastName.trim()) {
      setError('Partner 1 name is required.')
      return
    }
    if (!form.partner1Email.trim()) {
      setError('Partner 1 email is required.')
      return
    }

    setSaving(true)

    try {
      const supabase = getSupabase()

      // 1. Generate event code (3 letter venue prefix + 3 digits)
      const prefix = (venueSlug || 'BLM').slice(0, 3).toUpperCase()
      const code = `${prefix}-${Math.floor(100 + Math.random() * 900)}`

      // 2. Create wedding record
      const { data: wedding, error: weddingErr } = await supabase
        .from('weddings')
        .insert({
          venue_id: venueId,
          status: 'booked',
          wedding_date: form.weddingDate || null,
          guest_count_estimate: form.guestCount ? parseInt(form.guestCount) : null,
          source: form.source ? normalizeSource(form.source) : null,
          booking_value: form.estimatedValue ? parseFloat(form.estimatedValue) : null,
          notes: form.notes || null,
          event_code: code,
          couple_invited_at: form.sendInvite ? new Date().toISOString() : null,
        })
        .select()
        .single()

      if (weddingErr) {
        // If event code collision, try once more with different code
        if (weddingErr.message?.includes('unique') || weddingErr.message?.includes('duplicate')) {
          const retryCode = `${prefix}-${Math.floor(100 + Math.random() * 900)}`
          const { data: retryWedding, error: retryErr } = await supabase
            .from('weddings')
            .insert({
              venue_id: venueId,
              status: 'booked',
              wedding_date: form.weddingDate || null,
              guest_count_estimate: form.guestCount ? parseInt(form.guestCount) : null,
              source: form.source ? normalizeSource(form.source) : null,
              booking_value: form.estimatedValue ? parseFloat(form.estimatedValue) : null,
              notes: form.notes || null,
              event_code: retryCode,
              couple_invited_at: form.sendInvite ? new Date().toISOString() : null,
            })
            .select()
            .single()
          if (retryErr) throw retryErr
          // Use the retry wedding below
          await createPeopleAndInvite(supabase, retryWedding, retryCode)
        } else {
          throw weddingErr
        }
      } else {
        await createPeopleAndInvite(supabase, wedding, code)
      }

      // Track booking_closed in consultant_metrics
      fetch('/api/tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'booking_closed' }),
      }).catch((trackErr) => console.warn('Booking tracking failed:', trackErr))

      // Reset form and close
      setForm({ ...emptyForm })
      onClose()
      onCreated()
    } catch (err: any) {
      console.error('Failed to create booking:', err)
      setError(err?.message || 'Failed to create booking. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function createPeopleAndInvite(
    supabase: ReturnType<typeof getSupabase>,
    wedding: any,
    code: string,
  ) {
    // 3. Create people records
    const peopleToInsert = [
      {
        venue_id: venueId,
        wedding_id: wedding.id,
        role: 'partner1',
        first_name: form.partner1FirstName.trim(),
        last_name: form.partner1LastName.trim(),
        email: form.partner1Email.trim() || null,
        phone: form.partner1Phone.trim() || null,
      },
    ]

    if (form.partner2FirstName.trim()) {
      peopleToInsert.push({
        venue_id: venueId,
        wedding_id: wedding.id,
        role: 'partner2',
        first_name: form.partner2FirstName.trim(),
        last_name: form.partner2LastName.trim(),
        email: form.partner2Email.trim() || null,
        phone: form.partner2Phone.trim() || null,
      })
    }

    await supabase.from('people').insert(peopleToInsert)

    // 4. Send invitation email if checked
    if (form.sendInvite && form.partner1Email.trim()) {
      await fetch('/api/portal/invite-couple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weddingId: wedding.id,
          venueId,
          email: form.partner1Email.trim(),
          partnerEmail: form.partner2Email.trim() || null,
          eventCode: code,
          coupleName: form.partner2FirstName.trim()
            ? `${form.partner1FirstName.trim()} & ${form.partner2FirstName.trim()}`
            : form.partner1FirstName.trim(),
        }),
      })
    }
  }

  if (!open) return null

  const inputClasses =
    'w-full rounded-lg border border-sage-200 bg-warm-white px-3 py-2 text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 sm:pt-20">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-surface rounded-xl border border-border shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto mx-4">
        {/* Header */}
        <div className="sticky top-0 bg-surface border-b border-border px-6 py-4 flex items-center justify-between rounded-t-xl z-10">
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            New Booking
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Partner 1 */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
              Partner 1
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  First Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.partner1FirstName}
                  onChange={(e) => set('partner1FirstName', e.target.value)}
                  required
                  className={inputClasses}
                  placeholder="First name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Last Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.partner1LastName}
                  onChange={(e) => set('partner1LastName', e.target.value)}
                  required
                  className={inputClasses}
                  placeholder="Last name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Email <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  value={form.partner1Email}
                  onChange={(e) => set('partner1Email', e.target.value)}
                  required
                  className={inputClasses}
                  placeholder="partner1@email.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Phone
                </label>
                <input
                  type="tel"
                  value={form.partner1Phone}
                  onChange={(e) => set('partner1Phone', e.target.value)}
                  className={inputClasses}
                  placeholder="(555) 123-4567"
                />
              </div>
            </div>
          </div>

          {/* Partner 2 */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
              Partner 2 <span className="text-sage-400 normal-case tracking-normal font-normal">(optional)</span>
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  First Name
                </label>
                <input
                  type="text"
                  value={form.partner2FirstName}
                  onChange={(e) => set('partner2FirstName', e.target.value)}
                  className={inputClasses}
                  placeholder="First name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Last Name
                </label>
                <input
                  type="text"
                  value={form.partner2LastName}
                  onChange={(e) => set('partner2LastName', e.target.value)}
                  className={inputClasses}
                  placeholder="Last name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={form.partner2Email}
                  onChange={(e) => set('partner2Email', e.target.value)}
                  className={inputClasses}
                  placeholder="partner2@email.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Phone
                </label>
                <input
                  type="tel"
                  value={form.partner2Phone}
                  onChange={(e) => set('partner2Phone', e.target.value)}
                  className={inputClasses}
                  placeholder="(555) 987-6543"
                />
              </div>
            </div>
          </div>

          {/* Wedding Details */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
              Wedding Details
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Wedding Date
                </label>
                <input
                  type="date"
                  value={form.weddingDate}
                  onChange={(e) => set('weddingDate', e.target.value)}
                  className={inputClasses}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Estimated Guest Count
                </label>
                <input
                  type="number"
                  value={form.guestCount}
                  onChange={(e) => set('guestCount', e.target.value)}
                  className={inputClasses}
                  placeholder="150"
                  min="0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Source
                </label>
                <select
                  value={form.source}
                  onChange={(e) => set('source', e.target.value)}
                  className={inputClasses}
                >
                  {SOURCE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Package / Estimated Value
                </label>
                <input
                  type="number"
                  value={form.estimatedValue}
                  onChange={(e) => set('estimatedValue', e.target.value)}
                  className={inputClasses}
                  placeholder="12500"
                  min="0"
                  step="100"
                />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              Notes
            </label>
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              className={cn(inputClasses, 'min-h-[80px] resize-y')}
              placeholder="Any additional notes about this booking..."
            />
          </div>

          {/* Send Invite checkbox */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={form.sendInvite}
              onChange={(e) => set('sendInvite', e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-sage-300 text-sage-600 focus:ring-sage-500"
            />
            <div>
              <span className="text-sm font-medium text-sage-900 group-hover:text-sage-700 transition-colors">
                Send invitation email to the couple
              </span>
              <p className="text-xs text-sage-500 mt-0.5">
                They will receive a link to set up their wedding portal account.
              </p>
            </div>
          </label>

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-sage-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium bg-sage-800 text-white hover:bg-sage-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  Create Booking
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function WeddingsPage() {
  const scope = useScope()
  const showVenueChip = scope.level !== 'venue'
  const [weddings, setWeddings] = useState<Wedding[]>([])
  const [venueSlug, setVenueSlug] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortBy, setSortBy] = useState<SortKey>('date')
  const [searchQuery, setSearchQuery] = useState('')
  const [showNewBooking, setShowNewBooking] = useState(false)

  // ---- Fetch data ----
  const fetchData = useCallback(async () => {
    if (scope.loading) return
    const supabase = getSupabase()

    try {
      // Resolve scope → list of venue IDs (null = all venues / company)
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
        // Company scope — filter to user's org's venues only (prevents cross-org leak)
        const { data: orgVenues } = await supabase
          .from('venues')
          .select('id')
          .eq('org_id', scope.orgId)
        venueIds = (orgVenues ?? []).map((v) => v.id as string)
      }

      // Fetch venue slug for "Open as Couple" links — only meaningful
      // when a single venue is in scope.
      if (scope.level === 'venue' && scope.venueId) {
        const { data: venueData } = await supabase
          .from('venues')
          .select('slug')
          .eq('id', scope.venueId)
          .single()
        if (venueData) setVenueSlug(venueData.slug)
      } else {
        setVenueSlug(null)
      }

      let query = supabase
        .from('weddings')
        .select(`
          *,
          venues:venue_id ( name ),
          people (*),
          timeline (*),
          budget (*),
          checklist_items (*)
        `)

      if (venueIds && venueIds.length > 0) {
        query = query.in('venue_id', venueIds)
      }

      // Base filter: inquiries belong on /agent/leads, not here. This
      // surface only shows weddings that have at least booked a tour.
      if (statusFilter === 'all') {
        query = query.in('status', WEDDING_STATUSES as unknown as string[])
      } else {
        query = query.eq('status', statusFilter)
      }

      const { data, error: fetchErr } = await query

      if (fetchErr) throw fetchErr

      const weddingIds = ((data ?? []) as any[]).map((r) => r.id as string)

      // Fetch communication pulse: message + sage_conversation counts in last 30 days
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      const since = thirtyDaysAgo.toISOString()

      const [msgRes, sageRes] = await Promise.all([
        weddingIds.length > 0
          ? supabase
              .from('messages')
              .select('wedding_id')
              .in('wedding_id', weddingIds)
              .gte('created_at', since)
          : Promise.resolve({ data: [] }),
        weddingIds.length > 0
          ? supabase
              .from('sage_conversations')
              .select('wedding_id')
              .in('wedding_id', weddingIds)
              .eq('role', 'user')
              .gte('created_at', since)
          : Promise.resolve({ data: [] }),
      ])

      // Tally counts per wedding
      const commCounts: Record<string, number> = {}
      for (const row of (msgRes.data ?? []) as { wedding_id: string }[]) {
        commCounts[row.wedding_id] = (commCounts[row.wedding_id] ?? 0) + 1
      }
      for (const row of (sageRes.data ?? []) as { wedding_id: string }[]) {
        commCounts[row.wedding_id] = (commCounts[row.wedding_id] ?? 0) + 1
      }

      const mapped: Wedding[] = ((data ?? []) as any[]).map((row) => {
        const venueRel = row.venues as { name?: string } | { name?: string }[] | null | undefined
        const venueName = Array.isArray(venueRel) ? venueRel[0]?.name ?? null : venueRel?.name ?? null
        return { ...row, venue_name: venueName, comm_pulse_count: commCounts[row.id] ?? 0 } as Wedding
      })
      setWeddings(mapped)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch weddings:', err)
      setError('Failed to load weddings')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, scope.level, scope.venueId, scope.groupId, scope.loading])

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
        // Progression order — touring → proposal → booked → completed → lost.
        // 'inquiry' excluded (can't appear on this surface) but kept with
        // rank 0 as a safety valve in case a lagging record slips through.
        const order: Record<string, number> = {
          inquiry: 0,
          tour_scheduled: 1,
          tour_completed: 2,
          proposal_sent: 3,
          booked: 4,
          completed: 5,
          lost: 6,
        }
        return (order[a.status] ?? 99) - (order[b.status] ?? 99)
      }
      case 'value':
        return (b.booking_value ?? 0) - (a.booking_value ?? 0)
    }
  })

  const statusCounts = {
    all: weddings.length,
    tour_scheduled: weddings.filter((w) => w.status === 'tour_scheduled' || w.status === 'tour_completed').length,
    proposal_sent: weddings.filter((w) => w.status === 'proposal_sent').length,
    booked: weddings.filter((w) => w.status === 'booked').length,
    completed: weddings.filter((w) => w.status === 'completed').length,
    lost: weddings.filter((w) => w.status === 'lost').length,
  }

  const statuses: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'tour_scheduled', label: 'Touring' },
    { key: 'proposal_sent', label: 'Proposal' },
    { key: 'booked', label: 'Booked' },
    { key: 'completed', label: 'Completed' },
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
            All weddings managed through your portal — booked, in-planning, and completed. Click any couple to view their portal, or open it as the couple would see it.
          </p>
        </div>
        {scope.level === 'venue' && scope.venueId && (
          <button
            onClick={() => setShowNewBooking(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-sage-800 text-white hover:bg-sage-900 transition-colors shrink-0 self-start"
          >
            <Plus className="w-4 h-4" />
            New Booking
          </button>
        )}
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
            <WeddingCard key={wedding.id} wedding={wedding} venueSlug={venueSlug} showVenueChip={showVenueChip} />
          ))}
        </div>
      )}

      {/* New Booking Modal */}
      {scope.venueId && (
        <NewBookingModal
          open={showNewBooking}
          onClose={() => setShowNewBooking(false)}
          venueId={scope.venueId}
          venueSlug={venueSlug}
          onCreated={() => {
            setLoading(true)
            fetchData()
          }}
        />
      )}
    </div>
  )
}
