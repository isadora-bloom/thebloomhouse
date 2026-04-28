'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import {
  ArrowLeft,
  Calendar,
  Users,
  DollarSign,
  Heart,
  Clock,
  CheckCircle,
  XCircle,
  Eye,
  ExternalLink,
  MessageCircle,
  FileText,
  ListChecks,
  Utensils,
  StickyNote,
  Lock,
  Save,
  Loader2,
  Activity,
  AlertCircle,
  Star,
  ClipboardCheck,
  Sparkles,
  ThumbsUp,
  Send,
  Mail,
  UserCheck,
  UserPlus,
  Check,
  Camera,
} from 'lucide-react'
import { CommunicationPulse } from '../communication-pulse'
import { checkEscalation } from '@/config/escalation-keywords'
import { DayOfMemoriesTab } from './_components/day-of-memories-tab'
import { VendorChecklistSection } from './_components/vendor-checklist-section'
import { InternalNotesFeed } from './_components/internal-notes-feed'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WeddingRow {
  id: string
  venue_id: string
  status: string
  wedding_date: string | null
  guest_count_estimate: number | null
  booking_value: number | null
  couple_photo_url: string | null
  notes: string | null
  assigned_consultant_id: string | null
  event_code: string | null
  couple_invited_at: string | null
  couple_registered_at: string | null
  created_at: string
  updated_at: string
}

interface PersonRow {
  id: string
  first_name: string
  last_name: string
  role: string
  email: string | null
  phone: string | null
}

interface ClientCodeRow {
  code: string
}

interface VenueRow {
  name: string
  slug: string
}

interface PlanningNoteRow {
  id: string
  category: string | null
  content: string
  source_message: string | null
  status: string | null
  created_at: string
}

interface BookedVendorRow {
  id: string
  vendor_type: string
  vendor_name: string | null
  vendor_contact: string | null
  is_booked: boolean
  contract_uploaded: boolean
  notes: string | null
}

interface GuestRow {
  id: string
  rsvp_status: string | null
  dietary_restrictions: string | null
  table_assignment_id: string | null
}

interface TimelineItemRow {
  id: string
  time: string | null
  title: string
  description: string | null
  category: string | null
  location: string | null
  sort_order: number | null
}

interface BudgetRow {
  id: string
  category: string | null
  item_name: string
  budgeted: number | null
  committed: number | null
  paid: number | null
}

interface MessageRow {
  id: string
  sender_role: string | null
  content: string
  created_at: string
}

interface SageConversationRow {
  id: string
  role: string
  content: string
  created_at: string
}

interface ChecklistItemRow {
  id: string
  title: string
  is_completed: boolean
  category: string | null
}

interface ConsultantRow {
  first_name: string | null
  last_name: string | null
}

interface EventFeedbackRow {
  id: string
  venue_id: string
  wedding_id: string
  overall_rating: number
  couple_satisfaction: number | null
  timeline_adherence: string | null
  delay_phases: string[] | null
  delay_notes: string | null
  guest_complaints: string | null
  guest_complaint_count: number | null
  catering_quality: number | null
  dietary_handling: number | null
  service_timing: number | null
  catering_notes: string | null
  review_readiness: string | null
  review_readiness_notes: string | null
  what_went_well: string | null
  what_to_change: string | null
  proactive_response_draft: string | null
  proactive_response_approved: boolean
  submitted_at: string | null
  created_at: string
}

interface EventFeedbackVendorRow {
  id: string
  event_feedback_id: string
  vendor_id: string | null
  vendor_name: string
  vendor_type: string
  rating: number
  notes: string | null
  would_recommend: boolean | null
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type TabKey = 'overview' | 'completeness' | 'planning-notes' | 'vendors' | 'guests' | 'timeline' | 'budget' | 'ceremony-chairs' | 'table-map' | 'communications' | 'internal-notes' | 'feedback' | 'day-of-memories'

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'completeness', label: 'File Completeness', icon: CheckCircle },
  { key: 'planning-notes', label: 'Planning Notes', icon: StickyNote },
  { key: 'vendors', label: 'Vendors', icon: Utensils },
  { key: 'guests', label: 'Guests', icon: Users },
  { key: 'timeline', label: 'Timeline', icon: Clock },
  { key: 'budget', label: 'Budget', icon: DollarSign },
  { key: 'ceremony-chairs', label: 'Ceremony Chairs', icon: ListChecks },
  { key: 'table-map', label: 'Table Map', icon: Eye },
  { key: 'communications', label: 'Communications', icon: MessageCircle },
  { key: 'internal-notes', label: 'Internal Notes', icon: Lock },
  { key: 'day-of-memories', label: 'Day-of Memories', icon: Camera },
  { key: 'feedback', label: 'Feedback', icon: ClipboardCheck },
]

// ---------------------------------------------------------------------------
// Delay phase options
// ---------------------------------------------------------------------------

const DELAY_PHASES = [
  { value: 'ceremony_start', label: 'Ceremony Start' },
  { value: 'cocktail_to_reception', label: 'Cocktail to Reception' },
  { value: 'dinner_service', label: 'Dinner Service' },
  { value: 'formalities', label: 'Formalities (Toasts/Dances)' },
  { value: 'vendor_setup', label: 'Vendor Setup' },
  { value: 'photos_ran_long', label: 'Photos Ran Long' },
  { value: 'other', label: 'Other' },
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCoupleNames(people: PersonRow[]): string {
  const principals = people.filter(
    (p) => p.role === 'partner1' || p.role === 'partner2' || p.role === 'bride' || p.role === 'groom' || p.role === 'partner'
  )
  if (principals.length === 0) {
    const first = people.slice(0, 2)
    return first.map((p) => p.first_name).join(' & ') || 'Unnamed Wedding'
  }
  return principals.map((p) => p.first_name).join(' & ')
}

function getCoupleFullNames(people: PersonRow[]): string {
  const principals = people.filter(
    (p) => p.role === 'partner1' || p.role === 'partner2' || p.role === 'bride' || p.role === 'groom' || p.role === 'partner'
  )
  if (principals.length === 0) {
    const first = people.slice(0, 2)
    return first.map((p) => `${p.first_name} ${p.last_name}`).join(' & ') || 'Unnamed Wedding'
  }
  return principals.map((p) => `${p.first_name} ${p.last_name}`).join(' & ')
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
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatShortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
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
      return { label: 'Booked', className: 'bg-emerald-50 text-emerald-700 border border-emerald-200', icon: CheckCircle }
    case 'completed':
      return { label: 'Completed', className: 'bg-teal-50 text-teal-700 border border-teal-200', icon: CheckCircle }
    case 'inquiry':
      return { label: 'Inquiry', className: 'bg-amber-50 text-amber-700 border border-amber-200', icon: Clock }
    case 'lost':
      return { label: 'Lost', className: 'bg-red-50 text-red-600 border border-red-200', icon: XCircle }
    case 'cancelled':
      return { label: 'Cancelled', className: 'bg-gray-50 text-gray-600 border border-gray-200', icon: XCircle }
    case 'tour_scheduled':
      return { label: 'Tour Scheduled', className: 'bg-purple-50 text-purple-700 border border-purple-200', icon: Clock }
    case 'tour_completed':
      return { label: 'Tour Completed', className: 'bg-indigo-50 text-indigo-700 border border-indigo-200', icon: CheckCircle }
    case 'proposal_sent':
      return { label: 'Proposal Sent', className: 'bg-amber-50 text-amber-700 border border-amber-200', icon: Clock }
    default:
      return { label: status, className: 'bg-sage-50 text-sage-600 border border-sage-200', icon: Clock }
  }
}

// CommunicationPulse moved to ../communication-pulse.tsx (page files can't
// export non-default symbols in Next.js App Router).

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function ProfileSkeleton() {
  return (
    <div className="space-y-6">
      <div className="animate-pulse space-y-3">
        <div className="h-6 w-32 bg-sage-100 rounded" />
        <div className="h-8 w-64 bg-sage-100 rounded" />
        <div className="h-5 w-48 bg-sage-50 rounded" />
      </div>
      <div className="flex gap-2 overflow-x-auto">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-9 w-28 bg-sage-50 rounded-lg animate-pulse shrink-0" />
        ))}
      </div>
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm animate-pulse">
        <div className="h-40 bg-sage-50 rounded" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab content components
// ---------------------------------------------------------------------------

function OverviewTab({
  wedding,
  people,
  checklist,
  budget,
  guests,
  messages,
  sageConversations,
  consultant,
}: {
  wedding: WeddingRow
  people: PersonRow[]
  checklist: ChecklistItemRow[]
  budget: BudgetRow[]
  guests: GuestRow[]
  messages: MessageRow[]
  sageConversations: SageConversationRow[]
  consultant: ConsultantRow | null
}) {
  const completedChecklist = checklist.filter((c) => c.is_completed).length
  const totalChecklist = checklist.length
  const checklistPct = totalChecklist > 0 ? Math.round((completedChecklist / totalChecklist) * 100) : 0

  const totalEstimated = budget.reduce((s, b) => s + (b.budgeted ?? 0), 0)
  const totalActual = budget.reduce((s, b) => s + (b.committed ?? 0), 0)
  const totalPaid = budget.reduce((s, b) => s + (b.paid ?? 0), 0)

  const totalGuests = guests.length
  const attending = guests.filter((g) => g.rsvp_status === 'attending').length
  const rsvpPct = totalGuests > 0 ? Math.round((attending / totalGuests) * 100) : 0

  // Communication pulse: count messages + sage conversations in the last 30 days
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const recentMessages = messages.filter((m) => new Date(m.created_at) >= thirtyDaysAgo).length
  const recentSage = sageConversations.filter((s) => s.role === 'user' && new Date(s.created_at) >= thirtyDaysAgo).length
  const commCount = recentMessages + recentSage

  // Last activity
  const allTimestamps = [
    ...messages.map((m) => m.created_at),
    ...sageConversations.map((s) => s.created_at),
  ].sort((a, b) => b.localeCompare(a))
  const lastActivity = allTimestamps[0] ?? wedding.updated_at

  // Escalation detection: scan recent couple messages for keywords.
  // Uses the canonical helper from @/config/escalation-keywords so this view
  // stays aligned with the same list the email pipeline + couple-side
  // message paths use (see src/lib/services/escalation-detector.ts).
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const recentCoupleMessages = messages.filter(m =>
    m.sender_role === 'couple' && new Date(m.created_at) >= sevenDaysAgo
  )
  const escalationMessages = recentCoupleMessages.filter(m =>
    checkEscalation(m.content).shouldEscalate
  )

  return (
    <div className="space-y-6">
      {/* Escalation alert */}
      {escalationMessages.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-800">
                {escalationMessages.length} message{escalationMessages.length > 1 ? 's' : ''} flagged in the last 7 days
              </p>
              <div className="mt-2 space-y-1">
                {escalationMessages.slice(0, 3).map(m => (
                  <p key={m.id} className="text-xs text-red-700 line-clamp-1">
                    {new Date(m.created_at).toLocaleDateString()}: &ldquo;{m.content.slice(0, 120)}&rdquo;
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Key metrics grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="bg-warm-white rounded-xl p-4 border border-sage-100">
          <div className="flex items-center gap-2 mb-2">
            <Users className="w-4 h-4 text-sage-400" />
            <span className="text-xs text-sage-500">Guests</span>
          </div>
          <p className="text-2xl font-bold text-sage-900 tabular-nums">{wedding.guest_count_estimate ?? totalGuests}</p>
          <p className="text-xs text-sage-500 mt-1">{attending} RSVP yes ({rsvpPct}%)</p>
        </div>
        <div className="bg-warm-white rounded-xl p-4 border border-sage-100">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4 text-sage-400" />
            <span className="text-xs text-sage-500">Budget</span>
          </div>
          <p className="text-2xl font-bold text-sage-900 tabular-nums">{fmt$(totalEstimated)}</p>
          <p className="text-xs text-sage-500 mt-1">{fmt$(totalActual)} spent, {fmt$(totalPaid)} paid</p>
        </div>
        <div className="bg-warm-white rounded-xl p-4 border border-sage-100">
          <div className="flex items-center gap-2 mb-2">
            <ListChecks className="w-4 h-4 text-sage-400" />
            <span className="text-xs text-sage-500">Checklist</span>
          </div>
          <p className="text-2xl font-bold text-sage-900 tabular-nums">{checklistPct}%</p>
          <div className="mt-1.5 h-1.5 bg-sage-100 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${checklistPct}%` }} />
          </div>
        </div>
        <div className="bg-warm-white rounded-xl p-4 border border-sage-100">
          <div className="flex items-center gap-2 mb-2">
            <MessageCircle className="w-4 h-4 text-sage-400" />
            <span className="text-xs text-sage-500">Comm. Pulse</span>
          </div>
          <CommunicationPulse messageCount={commCount} />
          <p className="text-xs text-sage-500 mt-1">{commCount} msgs (30d)</p>
        </div>
        <div className="bg-warm-white rounded-xl p-4 border border-sage-100">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-sage-400" />
            <span className="text-xs text-sage-500">Last Activity</span>
          </div>
          <p className="text-sm font-semibold text-sage-900">{formatShortDate(lastActivity)}</p>
        </div>
      </div>

      {/* Wedding details summary */}
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-sage-900 mb-4">Wedding Details</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs text-sage-500">Date</p>
            <p className="font-medium text-sage-900">{formatDate(wedding.wedding_date)}</p>
          </div>
          <div>
            <p className="text-xs text-sage-500">Status</p>
            <p className="font-medium text-sage-900 capitalize">{wedding.status.replace(/_/g, ' ')}</p>
          </div>
          <div>
            <p className="text-xs text-sage-500">Booking Value</p>
            <p className="font-medium text-sage-900">{fmt$(wedding.booking_value)}</p>
          </div>
          <div>
            <p className="text-xs text-sage-500">Coordinator</p>
            <p className="font-medium text-sage-900">
              {consultant ? `${consultant.first_name ?? ''} ${consultant.last_name ?? ''}`.trim() || 'Assigned' : 'Unassigned'}
            </p>
          </div>
          <div>
            <p className="text-xs text-sage-500">Contacts</p>
            <div className="space-y-0.5">
              {people.filter((p) => p.role === 'partner1' || p.role === 'partner2' || p.role === 'bride' || p.role === 'groom').map((p) => (
                <p key={p.id} className="font-medium text-sage-900 text-xs">
                  {p.first_name} {p.last_name} {p.email && <span className="text-sage-500">({p.email})</span>}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PlanningNotesTab({ notes }: { notes: PlanningNoteRow[] }) {
  const grouped = useMemo(() => {
    const map: Record<string, PlanningNoteRow[]> = {}
    for (const note of notes) {
      const cat = note.category || 'general'
      if (!map[cat]) map[cat] = []
      map[cat].push(note)
    }
    return map
  }, [notes])

  const categoryLabels: Record<string, string> = {
    vendor: 'Vendors',
    guest_count: 'Guest Count',
    decor: 'Decor',
    checklist: 'Checklist',
    cost: 'Cost',
    date: 'Date',
    policy: 'Policy',
    note: 'Note',
    general: 'General',
  }

  if (notes.length === 0) {
    return (
      <div className="text-center py-12">
        <StickyNote className="w-10 h-10 text-sage-300 mx-auto mb-3" />
        <p className="text-sm text-sage-500">No planning notes extracted yet.</p>
        <p className="text-xs text-sage-400 mt-1">Notes are automatically extracted from Sage conversations.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {Object.entries(grouped).map(([cat, catNotes]) => (
        <div key={cat}>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
            {categoryLabels[cat] ?? cat}
            <span className="ml-2 text-sage-400 font-normal">({catNotes.length})</span>
          </h4>
          <div className="space-y-2">
            {catNotes.map((note) => (
              <div key={note.id} className="bg-warm-white rounded-lg p-3 border border-sage-100">
                <p className="text-sm text-sage-900">{note.content}</p>
                {note.source_message && (
                  <p className="text-xs text-sage-400 mt-2 italic line-clamp-2">
                    Source: &quot;{note.source_message}&quot;
                  </p>
                )}
                <p className="text-[10px] text-sage-400 mt-1">{formatShortDate(note.created_at)}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function VendorsTab({ vendors, weddingId, venueId }: { vendors: BookedVendorRow[]; weddingId: string; venueId: string }) {
  if (vendors.length === 0) {
    return (
      <div className="text-center py-12">
        <Utensils className="w-10 h-10 text-sage-300 mx-auto mb-3" />
        <p className="text-sm text-sage-500">No vendors added yet.</p>
      </div>
    )
  }

  const booked = vendors.filter((v) => v.is_booked)
  const pending = vendors.filter((v) => !v.is_booked)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-sm text-sage-600">
        <span>Total: <strong className="text-sage-900">{vendors.length}</strong></span>
        <span className="text-emerald-600">Booked: <strong>{booked.length}</strong></span>
        <span className="text-amber-600">Pending: <strong>{pending.length}</strong></span>
      </div>
      <div className="space-y-3">
        {vendors.map((vendor) => (
          <div key={vendor.id} className="space-y-2">
            <div className="flex items-center gap-3 bg-warm-white rounded-lg p-3 border border-sage-100">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-sage-900">{vendor.vendor_name || vendor.vendor_type}</span>
                <span className="text-xs text-sage-500 capitalize">{vendor.vendor_type.replace(/_/g, ' ')}</span>
              </div>
              {vendor.vendor_contact && (
                <p className="text-xs text-sage-500 mt-0.5">{vendor.vendor_contact}</p>
              )}
              {vendor.notes && (
                <p className="text-xs text-sage-400 mt-0.5 line-clamp-1">{vendor.notes}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {vendor.contract_uploaded && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-teal-50 text-teal-700 border border-teal-200">
                  <FileText className="w-2.5 h-2.5" />
                  Contract
                </span>
              )}
              <span className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium',
                vendor.is_booked ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'
              )}>
                {vendor.is_booked ? 'Booked' : 'Pending'}
              </span>
            </div>
            </div>
            <VendorChecklistSection
              weddingId={weddingId}
              venueId={venueId}
              vendorId={vendor.id}
              vendorType={vendor.vendor_type}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function GuestsTab({ guests, guestCountEstimate }: { guests: GuestRow[]; guestCountEstimate: number | null }) {
  const total = guests.length
  const attending = guests.filter((g) => g.rsvp_status === 'attending').length
  const declined = guests.filter((g) => g.rsvp_status === 'declined').length
  const pending = guests.filter((g) => !g.rsvp_status || g.rsvp_status === 'pending' || g.rsvp_status === 'maybe').length
  const assigned = guests.filter((g) => g.table_assignment_id).length

  // Dietary summary
  const dietaryMap: Record<string, number> = {}
  for (const g of guests) {
    if (g.dietary_restrictions) {
      const key = g.dietary_restrictions.toLowerCase().trim()
      dietaryMap[key] = (dietaryMap[key] || 0) + 1
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100 text-center">
          <p className="text-2xl font-bold text-sage-900 tabular-nums">{guestCountEstimate ?? total}</p>
          <p className="text-xs text-sage-500">Expected</p>
        </div>
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100 text-center">
          <p className="text-2xl font-bold text-emerald-700 tabular-nums">{attending}</p>
          <p className="text-xs text-sage-500">Attending</p>
        </div>
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100 text-center">
          <p className="text-2xl font-bold text-amber-700 tabular-nums">{pending}</p>
          <p className="text-xs text-sage-500">Pending</p>
        </div>
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100 text-center">
          <p className="text-2xl font-bold text-red-600 tabular-nums">{declined}</p>
          <p className="text-xs text-sage-500">Declined</p>
        </div>
      </div>

      <div className="flex items-center gap-4 text-sm text-sage-600">
        <span>Table assigned: <strong className="text-sage-900">{assigned}/{total}</strong></span>
        {total > 0 && (
          <span>RSVP rate: <strong className="text-sage-900">{Math.round(((attending + declined) / total) * 100)}%</strong></span>
        )}
      </div>

      {Object.keys(dietaryMap).length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">Dietary Restrictions</h4>
          <div className="flex flex-wrap gap-2">
            {Object.entries(dietaryMap).sort(([, a], [, b]) => b - a).map(([diet, count]) => (
              <span key={diet} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-sage-50 text-sage-700 border border-sage-200">
                {diet} <span className="font-bold">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {guests.length === 0 && (
        <div className="text-center py-8">
          <Users className="w-10 h-10 text-sage-300 mx-auto mb-3" />
          <p className="text-sm text-sage-500">No guests added yet.</p>
        </div>
      )}
    </div>
  )
}

function TimelineTab({ items }: { items: TimelineItemRow[] }) {
  const sorted = [...items].sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999))

  if (sorted.length === 0) {
    return (
      <div className="text-center py-12">
        <Clock className="w-10 h-10 text-sage-300 mx-auto mb-3" />
        <p className="text-sm text-sage-500">No day-of timeline items yet.</p>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {sorted.map((item, idx) => (
        <div key={item.id} className="flex items-start gap-3 py-2">
          <div className="flex flex-col items-center shrink-0 w-16">
            <span className="text-xs font-mono font-semibold text-sage-700">
              {item.time ?? '--:--'}
            </span>
          </div>
          <div className="relative flex-1 pl-4 border-l-2 border-sage-200">
            {idx < sorted.length - 1 && <div className="absolute left-[-1px] top-6 bottom-0 w-0.5 bg-sage-100" />}
            <div className="absolute left-[-5px] top-1.5 w-2 h-2 rounded-full bg-teal-500" />
            <p className="text-sm font-medium text-sage-900">{item.title}</p>
            {item.description && <p className="text-xs text-sage-500 mt-0.5">{item.description}</p>}
            <div className="flex items-center gap-3 mt-1 text-xs text-sage-400">
              {item.category && <span className="capitalize">{item.category}</span>}
              {item.location && <span>{item.location}</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function CompletenessTab({ weddingId, guests, vendors, checklist, budgetItems, timelineItems }: {
  weddingId: string
  guests: GuestRow[]
  vendors: BookedVendorRow[]
  checklist: ChecklistItemRow[]
  budgetItems: BudgetRow[]
  timelineItems: TimelineItemRow[]
}) {
  const supabase = createClient()
  const [extra, setExtra] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      const checks: Record<string, boolean> = {}

      const safeCount = async (table: string) => {
        const { count } = await supabase.from(table).select('*', { count: 'exact', head: true }).eq('wedding_id', weddingId)
        return (count ?? 0) > 0
      }

      const [details, ceremony, chairs, allergies, shuttles, makeup, rehearsal, bedrooms, decor, bar, staffing, contracts, photos] = await Promise.all([
        supabase.from('wedding_details').select('*').eq('wedding_id', weddingId).maybeSingle(),
        safeCount('ceremony_order'),
        supabase.from('ceremony_chair_plans').select('plan').eq('wedding_id', weddingId).maybeSingle(),
        safeCount('allergy_registry'),
        safeCount('shuttle_schedule'),
        safeCount('makeup_schedule'),
        supabase.from('rehearsal_dinner').select('*').eq('wedding_id', weddingId).maybeSingle(),
        supabase.from('bedroom_assignments').select('*').eq('wedding_id', weddingId).maybeSingle(),
        safeCount('decor_inventory'),
        safeCount('bar_shopping_list'),
        supabase.from('staffing_plans').select('*').eq('wedding_id', weddingId).maybeSingle(),
        safeCount('contracts'),
        safeCount('wedding_photos'),
      ])

      const d = details.data || {} as Record<string, unknown>
      checks.wedding_colors = !!d.wedding_colors
      checks.ceremony_location = !!d.ceremony_location
      checks.arbor_choice = !!d.arbor_choice
      checks.dogs_info = d.dogs_coming !== null && d.dogs_coming !== undefined
      checks.send_off_type = !!d.send_off_type
      checks.seating_method = !!d.seating_method
      checks.ceremony_order = ceremony
      checks.ceremony_chairs = !!(chairs.data?.plan?.rows?.length)
      checks.allergies = allergies
      checks.shuttles = shuttles
      checks.makeup = makeup
      checks.rehearsal = !!(rehearsal.data?.bar_type || rehearsal.data?.food_type)
      checks.bedrooms = !!(bedrooms.data && Object.values(bedrooms.data).some((v: unknown) => typeof v === 'string' && v.length > 0))
      checks.decor = decor
      checks.bar = bar
      checks.staffing = !!staffing.data
      checks.contracts = contracts
      checks.photos = photos

      setExtra(checks)
      setLoading(false)
    })()
  }, [weddingId])

  const sections = [
    { title: 'Basics', items: [
      { label: 'Guests added', done: guests.length > 0, detail: guests.length > 0 ? `${guests.length} guests` : undefined },
      { label: 'Budget started', done: budgetItems.length > 0 },
      { label: 'Checklist started', done: checklist.length > 0, detail: checklist.length > 0 ? `${checklist.filter(c => c.is_completed).length}/${checklist.length} done` : undefined },
      { label: 'Wedding colors', done: extra.wedding_colors },
      { label: 'Dogs info', done: extra.dogs_info },
    ]},
    { title: 'Ceremony & Day-of', items: [
      { label: 'Ceremony location', done: extra.ceremony_location },
      { label: 'Arbor choice', done: extra.arbor_choice },
      { label: 'Ceremony order', done: extra.ceremony_order },
      { label: 'Ceremony chairs', done: extra.ceremony_chairs },
      { label: 'Timeline built', done: timelineItems.length > 0 },
      { label: 'H&M schedule', done: extra.makeup },
      { label: 'Rehearsal dinner', done: extra.rehearsal },
    ]},
    { title: 'Logistics', items: [
      { label: 'Vendors booked', done: vendors.length > 0, detail: vendors.length > 0 ? `${vendors.length} vendors` : undefined },
      { label: 'Contracts uploaded', done: extra.contracts },
      { label: 'Shuttle schedule', done: extra.shuttles },
      { label: 'Bedroom assignments', done: extra.bedrooms },
      { label: 'Staffing plan', done: extra.staffing },
    ]},
    { title: 'Details & Content', items: [
      { label: 'Allergy registry', done: extra.allergies },
      { label: 'Bar planner', done: extra.bar },
      { label: 'Decor inventory', done: extra.decor },
      { label: 'Photos uploaded', done: extra.photos },
      { label: 'Send-off type', done: extra.send_off_type },
      { label: 'Seating method', done: extra.seating_method },
    ]},
  ]

  const totalItems = sections.reduce((s, sec) => s + sec.items.length, 0)
  const doneItems = sections.reduce((s, sec) => s + sec.items.filter(i => i.done).length, 0)
  const pct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0

  if (loading) return <p className="text-muted-foreground text-sm py-4">Checking completeness...</p>

  return (
    <div className="space-y-5">
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="font-medium text-sm">Wedding File Completeness</p>
          <span className="text-lg font-bold">{pct}%</span>
        </div>
        <div className="w-full h-2.5 bg-muted rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full transition-all', pct === 100 ? 'bg-green-500' : pct >= 70 ? 'bg-primary' : 'bg-amber-500')}
            style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground mt-1">{doneItems} of {totalItems} items</p>
      </div>

      {sections.map(sec => {
        const done = sec.items.filter(i => i.done).length
        return (
          <div key={sec.title} className="rounded-lg border overflow-hidden">
            <div className={cn('px-4 py-2.5 border-b flex items-center justify-between', done === sec.items.length ? 'bg-green-50' : 'bg-muted/50')}>
              <p className="text-sm font-medium">{sec.title}</p>
              <span className="text-xs text-muted-foreground">{done}/{sec.items.length}</span>
            </div>
            <div className="divide-y">
              {sec.items.map(item => (
                <div key={item.label} className="flex items-center gap-3 px-4 py-2">
                  <span className={cn('w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0', item.done ? 'bg-green-100 text-green-600' : 'bg-muted')}>
                    {item.done ? <Check className="w-2.5 h-2.5" /> : <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />}
                  </span>
                  <span className={cn('text-sm flex-1', item.done ? 'text-foreground' : 'text-muted-foreground')}>{item.label}</span>
                  {item.done && item.detail && <span className="text-xs text-muted-foreground">{item.detail}</span>}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CeremonyChairsTab({ weddingId }: { weddingId: string }) {
  const supabase = createClient()
  const [rows, setRows] = useState<{ left: number; right: number; label: string }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('ceremony_chair_plans').select('plan').eq('wedding_id', weddingId).maybeSingle()
      .then(({ data }) => { if (data?.plan?.rows) setRows(data.plan.rows); setLoading(false) })
  }, [weddingId])

  if (loading) return <p className="text-muted-foreground text-sm py-4">Loading...</p>
  if (rows.length === 0) return <p className="text-muted-foreground text-sm py-4">No ceremony chair plan created yet.</p>

  const total = rows.reduce((s, r) => s + (r.left || 0) + (r.right || 0), 0)
  const maxSide = Math.max(...rows.map(r => Math.max(r.left || 0, r.right || 0)), 1)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <p className="text-sm font-medium">{total} chairs across {rows.length} rows</p>
      </div>
      <div className="bg-muted/30 rounded-lg p-4 space-y-1 overflow-x-auto">
        <div className="text-center mb-3">
          <span className="text-xs bg-muted px-3 py-1 rounded font-medium">Altar</span>
        </div>
        {rows.map((row, idx) => (
          <div key={idx} className="flex items-center justify-center gap-1">
            <span className="text-xs text-muted-foreground w-7 text-right tabular-nums">R{idx + 1}</span>
            <div className="flex justify-end gap-px" style={{ width: `${maxSide * 1.1}rem` }}>
              {Array.from({ length: row.left || 0 }).map((_, i) => (
                <span key={i} className="w-3.5 h-3.5 flex items-center justify-center text-[10px] font-bold">X</span>
              ))}
            </div>
            <span className="text-[10px] font-bold w-5 text-center tabular-nums">{row.left}</span>
            <div className="w-8 border-l border-r border-dashed border-muted-foreground/30 mx-0.5" />
            <span className="text-[10px] font-bold w-5 text-center tabular-nums">{row.right}</span>
            <div className="flex justify-start gap-px" style={{ width: `${maxSide * 1.1}rem` }}>
              {Array.from({ length: row.right || 0 }).map((_, i) => (
                <span key={i} className="w-3.5 h-3.5 flex items-center justify-center text-[10px] font-bold">X</span>
              ))}
            </div>
            <span className="text-[10px] text-muted-foreground ml-1 tabular-nums">={(row.left||0)+(row.right||0)}</span>
            {row.label && <span className="text-[10px] text-muted-foreground ml-1">{row.label}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function BudgetTab({ items }: { items: BudgetRow[] }) {
  const totalEstimated = items.reduce((s, b) => s + (b.budgeted ?? 0), 0)
  const totalActual = items.reduce((s, b) => s + (b.committed ?? 0), 0)
  const totalPaid = items.reduce((s, b) => s + (b.paid ?? 0), 0)
  const remaining = totalEstimated - totalActual

  // Group by category
  const byCategory: Record<string, { estimated: number; actual: number; paid: number; count: number }> = {}
  for (const item of items) {
    const cat = item.category || 'Uncategorized'
    if (!byCategory[cat]) byCategory[cat] = { estimated: 0, actual: 0, paid: 0, count: 0 }
    byCategory[cat].estimated += item.budgeted ?? 0
    byCategory[cat].actual += item.committed ?? 0
    byCategory[cat].paid += item.paid ?? 0
    byCategory[cat].count++
  }

  return (
    <div className="space-y-4">
      {/* Budget summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100 text-center">
          <p className="text-[10px] text-sage-500 uppercase mb-1">Total Budget</p>
          <p className="text-xl font-bold text-sage-900 tabular-nums">{fmt$(totalEstimated)}</p>
        </div>
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100 text-center">
          <p className="text-[10px] text-sage-500 uppercase mb-1">Committed</p>
          <p className="text-xl font-bold text-sage-900 tabular-nums">{fmt$(totalActual)}</p>
        </div>
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100 text-center">
          <p className="text-[10px] text-sage-500 uppercase mb-1">Paid</p>
          <p className="text-xl font-bold text-teal-700 tabular-nums">{fmt$(totalPaid)}</p>
        </div>
        <div className="bg-warm-white rounded-lg p-3 border border-sage-100 text-center">
          <p className="text-[10px] text-sage-500 uppercase mb-1">Remaining</p>
          <p className={cn('text-xl font-bold tabular-nums', remaining >= 0 ? 'text-emerald-700' : 'text-red-600')}>
            {fmt$(remaining)}
          </p>
        </div>
      </div>

      {/* Categories table */}
      {items.length > 0 ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-sage-200">
              <th className="text-left py-2 text-xs text-sage-500 font-medium">Category</th>
              <th className="text-right py-2 text-xs text-sage-500 font-medium">Items</th>
              <th className="text-right py-2 text-xs text-sage-500 font-medium">Estimated</th>
              <th className="text-right py-2 text-xs text-sage-500 font-medium">Actual</th>
              <th className="text-right py-2 text-xs text-sage-500 font-medium">Paid</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(byCategory)
              .sort(([, a], [, b]) => b.estimated - a.estimated)
              .map(([cat, data]) => (
                <tr key={cat} className="border-b border-sage-50">
                  <td className="py-2 text-sage-900 capitalize">{cat.replace(/_/g, ' ')}</td>
                  <td className="text-right py-2 text-sage-600 tabular-nums">{data.count}</td>
                  <td className="text-right py-2 text-sage-800 tabular-nums">{fmt$(data.estimated)}</td>
                  <td className="text-right py-2 text-sage-800 tabular-nums">{fmt$(data.actual)}</td>
                  <td className="text-right py-2 text-sage-800 tabular-nums">{fmt$(data.paid)}</td>
                </tr>
              ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-sage-200 font-semibold">
              <td className="py-2 text-sage-900">Total</td>
              <td className="text-right py-2 text-sage-600 tabular-nums">{items.length}</td>
              <td className="text-right py-2 text-sage-900 tabular-nums">{fmt$(totalEstimated)}</td>
              <td className="text-right py-2 text-sage-900 tabular-nums">{fmt$(totalActual)}</td>
              <td className="text-right py-2 text-sage-900 tabular-nums">{fmt$(totalPaid)}</td>
            </tr>
          </tfoot>
        </table>
      ) : (
        <div className="text-center py-8">
          <DollarSign className="w-10 h-10 text-sage-300 mx-auto mb-3" />
          <p className="text-sm text-sage-500">No budget items yet.</p>
        </div>
      )}
    </div>
  )
}

function CommunicationsTab({
  messages,
  sageConversations,
}: {
  messages: MessageRow[]
  sageConversations: SageConversationRow[]
}) {
  const sortedMessages = [...messages].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const sageMessages = sageConversations.filter((s) => s.role === 'user')

  return (
    <div className="space-y-6">
      {/* Sage conversation summary */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
          Sage Conversations
          <span className="ml-2 text-sage-400 font-normal">({sageConversations.length} messages)</span>
        </h4>
        {sageMessages.length > 0 ? (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {sageMessages.slice(0, 20).map((msg) => (
              <div key={msg.id} className="bg-warm-white rounded-lg p-3 border border-sage-100">
                <p className="text-sm text-sage-900 line-clamp-2">{msg.content}</p>
                <p className="text-[10px] text-sage-400 mt-1">{formatShortDate(msg.created_at)}</p>
              </div>
            ))}
            {sageMessages.length > 20 && (
              <p className="text-xs text-sage-400 italic">+{sageMessages.length - 20} more questions</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-sage-400 italic">No Sage conversations yet.</p>
        )}
      </div>

      {/* Coordinator messages */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
          Direct Messages
          <span className="ml-2 text-sage-400 font-normal">({messages.length})</span>
        </h4>
        {sortedMessages.length > 0 ? (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {sortedMessages.slice(0, 20).map((msg) => (
              <div key={msg.id} className={cn(
                'rounded-lg p-3 border',
                msg.sender_role === 'couple' ? 'bg-teal-50 border-teal-100' : 'bg-warm-white border-sage-100'
              )}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-medium text-sage-500 capitalize">{msg.sender_role || 'unknown'}</span>
                  <span className="text-[10px] text-sage-400">{formatShortDate(msg.created_at)}</span>
                </div>
                <p className="text-sm text-sage-900 line-clamp-3">{msg.content}</p>
              </div>
            ))}
            {sortedMessages.length > 20 && (
              <p className="text-xs text-sage-400 italic">+{sortedMessages.length - 20} more messages</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-sage-400 italic">No direct messages yet.</p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Star Rating Input
// ---------------------------------------------------------------------------

function StarRating({
  value,
  onChange,
  readonly = false,
  size = 'md',
}: {
  value: number
  onChange?: (v: number) => void
  readonly?: boolean
  size?: 'sm' | 'md'
}) {
  const iconSize = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'

  return (
    <div className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          disabled={readonly}
          onClick={() => onChange?.(star)}
          className={cn(
            'transition-colors',
            readonly ? 'cursor-default' : 'cursor-pointer hover:scale-110'
          )}
        >
          <Star
            className={cn(
              iconSize,
              star <= value
                ? 'text-gold-500 fill-gold-500'
                : 'text-sage-300'
            )}
          />
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Post-Event Feedback Tab
// ---------------------------------------------------------------------------

function PostEventFeedbackTab({
  wedding,
  vendors,
  existingFeedback,
  existingVendorRatings,
  onSubmit,
}: {
  wedding: WeddingRow
  vendors: BookedVendorRow[]
  existingFeedback: EventFeedbackRow | null
  existingVendorRatings: EventFeedbackVendorRow[]
  onSubmit: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [generatingDraft, setGeneratingDraft] = useState(false)

  // Form state
  const [overallRating, setOverallRating] = useState(existingFeedback?.overall_rating ?? 0)
  const [coupleSatisfaction, setCoupleSatisfaction] = useState(existingFeedback?.couple_satisfaction ?? 0)
  const [timelineAdherence, setTimelineAdherence] = useState(existingFeedback?.timeline_adherence ?? '')
  const [delayPhases, setDelayPhases] = useState<string[]>(existingFeedback?.delay_phases ?? [])
  const [delayNotes, setDelayNotes] = useState(existingFeedback?.delay_notes ?? '')
  const [guestComplaints, setGuestComplaints] = useState(existingFeedback?.guest_complaints ?? '')
  const [guestComplaintCount, setGuestComplaintCount] = useState(existingFeedback?.guest_complaint_count ?? 0)
  const [cateringQuality, setCateringQuality] = useState(existingFeedback?.catering_quality ?? 0)
  const [dietaryHandling, setDietaryHandling] = useState(existingFeedback?.dietary_handling ?? 0)
  const [serviceTiming, setServiceTiming] = useState(existingFeedback?.service_timing ?? 0)
  const [cateringNotes, setCateringNotes] = useState(existingFeedback?.catering_notes ?? '')
  const [reviewReadiness, setReviewReadiness] = useState(existingFeedback?.review_readiness ?? '')
  const [reviewReadinessNotes, setReviewReadinessNotes] = useState(existingFeedback?.review_readiness_notes ?? '')
  const [whatWentWell, setWhatWentWell] = useState(existingFeedback?.what_went_well ?? '')
  const [whatToChange, setWhatToChange] = useState(existingFeedback?.what_to_change ?? '')
  const [proactiveDraft, setProactiveDraft] = useState(existingFeedback?.proactive_response_draft ?? '')

  // Per-vendor state
  const [vendorFeedback, setVendorFeedback] = useState<
    Record<string, { rating: number; notes: string; wouldRecommend: boolean | null }>
  >(() => {
    const initial: Record<string, { rating: number; notes: string; wouldRecommend: boolean | null }> = {}
    for (const v of vendors) {
      const existing = existingVendorRatings.find((vr) => vr.vendor_id === v.id)
      initial[v.id] = {
        rating: existing?.rating ?? 0,
        notes: existing?.notes ?? '',
        wouldRecommend: existing?.would_recommend ?? null,
      }
    }
    return initial
  })

  const isReadOnly = !!existingFeedback?.submitted_at && !!existingFeedback?.overall_rating
  const showDelayDetails = timelineAdherence === 'minor_delays' || timelineAdherence === 'significant_delays'

  // Check if wedding date is in the past
  const weddingInPast = wedding.wedding_date
    ? new Date(wedding.wedding_date + 'T00:00:00') < new Date()
    : false

  if (!weddingInPast) {
    return (
      <div className="text-center py-12">
        <ClipboardCheck className="w-10 h-10 text-sage-300 mx-auto mb-3" />
        <p className="text-sm text-sage-500">Post-event feedback will be available after the wedding date.</p>
        <p className="text-xs text-sage-400 mt-1">Wedding date: {formatDate(wedding.wedding_date)}</p>
      </div>
    )
  }

  async function handleSubmit() {
    if (overallRating === 0) {
      alert('Please provide an overall rating.')
      return
    }

    setSubmitting(true)
    try {
      const supabase = createClient()

      // Insert event_feedback
      const { data: feedbackRow, error: fbErr } = await supabase
        .from('event_feedback')
        .insert({
          venue_id: wedding.venue_id,
          wedding_id: wedding.id,
          overall_rating: overallRating,
          couple_satisfaction: coupleSatisfaction || null,
          timeline_adherence: timelineAdherence || null,
          delay_phases: delayPhases.length > 0 ? delayPhases : [],
          delay_notes: delayNotes || null,
          guest_complaints: guestComplaints || null,
          guest_complaint_count: guestComplaintCount,
          catering_quality: cateringQuality || null,
          dietary_handling: dietaryHandling || null,
          service_timing: serviceTiming || null,
          catering_notes: cateringNotes || null,
          review_readiness: reviewReadiness || null,
          review_readiness_notes: reviewReadinessNotes || null,
          what_went_well: whatWentWell || null,
          what_to_change: whatToChange || null,
          proactive_response_draft: proactiveDraft || null,
          submitted_at: new Date().toISOString(),
        })
        .select('id')
        .single()

      if (fbErr) throw fbErr

      // Insert vendor feedback rows
      const vendorRows = vendors
        .filter((v) => vendorFeedback[v.id]?.rating > 0)
        .map((v) => ({
          event_feedback_id: feedbackRow.id,
          vendor_id: v.id,
          vendor_name: v.vendor_name || v.vendor_type,
          vendor_type: v.vendor_type,
          rating: vendorFeedback[v.id].rating,
          notes: vendorFeedback[v.id].notes || null,
          would_recommend: vendorFeedback[v.id].wouldRecommend,
        }))

      if (vendorRows.length > 0) {
        const { error: vrErr } = await supabase
          .from('event_feedback_vendors')
          .insert(vendorRows)

        if (vrErr) throw vrErr
      }

      onSubmit()
    } catch (err) {
      console.error('Failed to submit feedback:', err)
      alert('Failed to submit feedback. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleGenerateDraft() {
    if (!existingFeedback?.id && overallRating === 0) {
      alert('Please fill in the feedback form first, then generate the draft.')
      return
    }

    // If there's no existing feedback yet, we need to submit first to get an ID
    // For now, we just call the API with the existing feedback ID
    if (!existingFeedback?.id) {
      alert('Please submit the feedback first, then generate the response draft.')
      return
    }

    setGeneratingDraft(true)
    try {
      const res = await fetch('/api/portal/event-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventFeedbackId: existingFeedback.id,
          venueId: wedding.venue_id,
        }),
      })

      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || 'Failed to generate draft')
      }

      const data = await res.json()
      setProactiveDraft(data.draft)
    } catch (err) {
      console.error('Failed to generate draft:', err)
      alert('Failed to generate review response draft. Please try again.')
    } finally {
      setGeneratingDraft(false)
    }
  }

  function toggleDelayPhase(phase: string) {
    setDelayPhases((prev) =>
      prev.includes(phase) ? prev.filter((p) => p !== phase) : [...prev, phase]
    )
  }

  // Read-only view
  if (isReadOnly) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-xs text-sage-500">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
          Feedback submitted on {existingFeedback.submitted_at ? formatShortDate(existingFeedback.submitted_at) : 'Unknown'}
        </div>

        {/* Overall Assessment */}
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-semibold text-sage-900">Overall Assessment</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-sage-500 mb-1">Overall Rating</p>
              <StarRating value={existingFeedback.overall_rating} readonly />
            </div>
            {existingFeedback.couple_satisfaction && (
              <div>
                <p className="text-xs text-sage-500 mb-1">Couple Satisfaction</p>
                <StarRating value={existingFeedback.couple_satisfaction} readonly />
              </div>
            )}
            {existingFeedback.timeline_adherence && (
              <div>
                <p className="text-xs text-sage-500 mb-1">Timeline</p>
                <p className="text-sm font-medium text-sage-900 capitalize">
                  {existingFeedback.timeline_adherence.replace(/_/g, ' ')}
                </p>
              </div>
            )}
          </div>
          {existingFeedback.delay_phases && existingFeedback.delay_phases.length > 0 && (
            <div>
              <p className="text-xs text-sage-500 mb-1">Delay Phases</p>
              <div className="flex flex-wrap gap-1">
                {existingFeedback.delay_phases.map((phase) => (
                  <span key={phase} className="px-2 py-0.5 rounded-full text-xs bg-amber-50 text-amber-700 border border-amber-200">
                    {DELAY_PHASES.find((d) => d.value === phase)?.label ?? phase}
                  </span>
                ))}
              </div>
            </div>
          )}
          {existingFeedback.delay_notes && (
            <div>
              <p className="text-xs text-sage-500 mb-1">Delay Notes</p>
              <p className="text-sm text-sage-700">{existingFeedback.delay_notes}</p>
            </div>
          )}
        </div>

        {/* Vendor Ratings */}
        {existingVendorRatings.length > 0 && (
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-3">
            <h3 className="text-sm font-semibold text-sage-900">Vendor Ratings</h3>
            <div className="space-y-2">
              {existingVendorRatings.map((vr) => (
                <div key={vr.id} className="flex items-center justify-between bg-warm-white rounded-lg p-3 border border-sage-100">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-sage-900">{vr.vendor_name}</span>
                      <span className="text-xs text-sage-500 capitalize">{vr.vendor_type.replace(/_/g, ' ')}</span>
                    </div>
                    {vr.notes && <p className="text-xs text-sage-500 mt-0.5">{vr.notes}</p>}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <StarRating value={vr.rating} readonly size="sm" />
                    {vr.would_recommend !== null && (
                      <span className={cn(
                        'text-xs px-1.5 py-0.5 rounded',
                        vr.would_recommend ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                      )}>
                        {vr.would_recommend ? 'Recommended' : 'Not recommended'}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Guest Experience */}
        {(existingFeedback.guest_complaints || existingFeedback.guest_complaint_count) && (
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-2">
            <h3 className="text-sm font-semibold text-sage-900">Guest Experience</h3>
            {existingFeedback.guest_complaint_count !== null && existingFeedback.guest_complaint_count > 0 && (
              <p className="text-sm text-sage-700">Complaints: {existingFeedback.guest_complaint_count}</p>
            )}
            {existingFeedback.guest_complaints && (
              <p className="text-sm text-sage-700">{existingFeedback.guest_complaints}</p>
            )}
          </div>
        )}

        {/* Catering */}
        {(existingFeedback.catering_quality || existingFeedback.dietary_handling || existingFeedback.service_timing) && (
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-3">
            <h3 className="text-sm font-semibold text-sage-900">Catering</h3>
            <div className="grid grid-cols-3 gap-4">
              {existingFeedback.catering_quality && (
                <div>
                  <p className="text-xs text-sage-500 mb-1">Quality</p>
                  <StarRating value={existingFeedback.catering_quality} readonly size="sm" />
                </div>
              )}
              {existingFeedback.dietary_handling && (
                <div>
                  <p className="text-xs text-sage-500 mb-1">Dietary Handling</p>
                  <StarRating value={existingFeedback.dietary_handling} readonly size="sm" />
                </div>
              )}
              {existingFeedback.service_timing && (
                <div>
                  <p className="text-xs text-sage-500 mb-1">Service Timing</p>
                  <StarRating value={existingFeedback.service_timing} readonly size="sm" />
                </div>
              )}
            </div>
            {existingFeedback.catering_notes && (
              <p className="text-sm text-sage-700">{existingFeedback.catering_notes}</p>
            )}
          </div>
        )}

        {/* Freeform */}
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-semibold text-sage-900">Reflections</h3>
          {existingFeedback.what_went_well && (
            <div>
              <p className="text-xs text-sage-500 mb-1">What Went Well</p>
              <p className="text-sm text-sage-700">{existingFeedback.what_went_well}</p>
            </div>
          )}
          {existingFeedback.what_to_change && (
            <div>
              <p className="text-xs text-sage-500 mb-1">What Would You Change</p>
              <p className="text-sm text-sage-700">{existingFeedback.what_to_change}</p>
            </div>
          )}
          {existingFeedback.review_readiness && (
            <div>
              <p className="text-xs text-sage-500 mb-1">Review Readiness</p>
              <p className="text-sm font-medium text-sage-900 capitalize">{existingFeedback.review_readiness}</p>
              {existingFeedback.review_readiness_notes && (
                <p className="text-xs text-sage-500 mt-0.5">{existingFeedback.review_readiness_notes}</p>
              )}
            </div>
          )}
        </div>

        {/* Proactive Response Draft */}
        {existingFeedback.proactive_response_draft && (
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-gold-500" />
              <h3 className="text-sm font-semibold text-sage-900">AI Review Response Draft</h3>
              {existingFeedback.proactive_response_approved && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Approved</span>
              )}
            </div>
            <p className="text-sm text-sage-700 whitespace-pre-wrap">{existingFeedback.proactive_response_draft}</p>
            {!existingFeedback.proactive_response_approved && (
              <button
                type="button"
                onClick={handleGenerateDraft}
                disabled={generatingDraft}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-gold-50 text-gold-700 border border-gold-200 hover:bg-gold-100 transition-colors"
              >
                {generatingDraft ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Regenerate Draft
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  // Editable form
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-sage-500">
        <ClipboardCheck className="w-3.5 h-3.5" />
        Share your post-event observations. This helps Bloom House learn and improve.
      </div>

      {/* Overall Assessment */}
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
        <h3 className="text-sm font-semibold text-sage-900">Overall Assessment</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-2">
              Overall Rating <span className="text-red-500">*</span>
            </label>
            <StarRating value={overallRating} onChange={setOverallRating} />
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-2">
              Couple Satisfaction (your read)
            </label>
            <StarRating value={coupleSatisfaction} onChange={setCoupleSatisfaction} />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-sage-700 mb-2">Timeline Adherence</label>
          <div className="flex flex-wrap gap-2">
            {[
              { value: 'on_time', label: 'On Time' },
              { value: 'minor_delays', label: 'Minor Delays' },
              { value: 'significant_delays', label: 'Significant Delays' },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTimelineAdherence(opt.value)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                  timelineAdherence === opt.value
                    ? 'bg-sage-600 text-white border-sage-600'
                    : 'bg-warm-white text-sage-700 border-sage-200 hover:border-sage-400'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {showDelayDetails && (
          <div className="space-y-3 pl-4 border-l-2 border-amber-200">
            <div>
              <label className="block text-xs font-medium text-sage-700 mb-2">Delay Phases (select all that apply)</label>
              <div className="flex flex-wrap gap-2">
                {DELAY_PHASES.map((phase) => (
                  <button
                    key={phase.value}
                    type="button"
                    onClick={() => toggleDelayPhase(phase.value)}
                    className={cn(
                      'px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors',
                      delayPhases.includes(phase.value)
                        ? 'bg-amber-600 text-white border-amber-600'
                        : 'bg-warm-white text-sage-700 border-sage-200 hover:border-amber-400'
                    )}
                  >
                    {phase.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-sage-700 mb-1">Delay Notes</label>
              <textarea
                value={delayNotes}
                onChange={(e) => setDelayNotes(e.target.value)}
                placeholder="What caused the delays? How were they managed?"
                className="w-full min-h-[80px] p-3 rounded-lg border border-sage-200 bg-warm-white text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 resize-y"
              />
            </div>
          </div>
        )}
      </div>

      {/* Per-Vendor Ratings */}
      {vendors.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-semibold text-sage-900">Vendor Ratings</h3>
          <div className="space-y-3">
            {vendors.map((vendor) => {
              const vf = vendorFeedback[vendor.id] ?? { rating: 0, notes: '', wouldRecommend: null }
              return (
                <div key={vendor.id} className="bg-warm-white rounded-lg p-4 border border-sage-100 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium text-sage-900">{vendor.vendor_name || vendor.vendor_type}</span>
                      <span className="text-xs text-sage-500 ml-2 capitalize">{vendor.vendor_type.replace(/_/g, ' ')}</span>
                    </div>
                    <StarRating
                      value={vf.rating}
                      onChange={(v) => setVendorFeedback((prev) => ({
                        ...prev,
                        [vendor.id]: { ...prev[vendor.id], rating: v },
                      }))}
                      size="sm"
                    />
                  </div>
                  <div className="flex items-center gap-4">
                    <input
                      type="text"
                      value={vf.notes}
                      onChange={(e) => setVendorFeedback((prev) => ({
                        ...prev,
                        [vendor.id]: { ...prev[vendor.id], notes: e.target.value },
                      }))}
                      placeholder="Notes (optional)"
                      className="flex-1 px-3 py-1.5 rounded-lg border border-sage-200 bg-white text-xs text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-1 focus:ring-sage-300"
                    />
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] text-sage-500">Recommend?</span>
                      <button
                        type="button"
                        onClick={() => setVendorFeedback((prev) => ({
                          ...prev,
                          [vendor.id]: { ...prev[vendor.id], wouldRecommend: vf.wouldRecommend === true ? null : true },
                        }))}
                        className={cn(
                          'p-1 rounded transition-colors',
                          vf.wouldRecommend === true ? 'bg-emerald-100 text-emerald-600' : 'bg-sage-50 text-sage-400 hover:bg-emerald-50'
                        )}
                      >
                        <ThumbsUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setVendorFeedback((prev) => ({
                          ...prev,
                          [vendor.id]: { ...prev[vendor.id], wouldRecommend: vf.wouldRecommend === false ? null : false },
                        }))}
                        className={cn(
                          'p-1 rounded transition-colors rotate-180',
                          vf.wouldRecommend === false ? 'bg-red-100 text-red-600' : 'bg-sage-50 text-sage-400 hover:bg-red-50'
                        )}
                      >
                        <ThumbsUp className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Guest Experience */}
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-semibold text-sage-900">Guest Experience</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-3">
            <label className="block text-xs font-medium text-sage-700 mb-1">Guest Complaints</label>
            <textarea
              value={guestComplaints}
              onChange={(e) => setGuestComplaints(e.target.value)}
              placeholder="Any complaints or issues raised by guests?"
              className="w-full min-h-[80px] p-3 rounded-lg border border-sage-200 bg-warm-white text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 resize-y"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-1">Complaint Count</label>
            <input
              type="number"
              min={0}
              value={guestComplaintCount}
              onChange={(e) => setGuestComplaintCount(parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 rounded-lg border border-sage-200 bg-warm-white text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300"
            />
          </div>
        </div>
      </div>

      {/* Catering */}
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-semibold text-sage-900">Catering</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-2">Quality</label>
            <StarRating value={cateringQuality} onChange={setCateringQuality} size="sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-2">Dietary Handling</label>
            <StarRating value={dietaryHandling} onChange={setDietaryHandling} size="sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-700 mb-2">Service Timing</label>
            <StarRating value={serviceTiming} onChange={setServiceTiming} size="sm" />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-sage-700 mb-1">Catering Notes</label>
          <textarea
            value={cateringNotes}
            onChange={(e) => setCateringNotes(e.target.value)}
            placeholder="Any notes on the catering experience?"
            className="w-full min-h-[60px] p-3 rounded-lg border border-sage-200 bg-warm-white text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 resize-y"
          />
        </div>
      </div>

      {/* Review Readiness */}
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-semibold text-sage-900">Review Readiness</h3>
        <div>
          <label className="block text-xs font-medium text-sage-700 mb-2">Would this couple leave a positive review?</label>
          <div className="flex flex-wrap gap-2">
            {[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
              { value: 'wait', label: 'Wait and See' },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setReviewReadiness(opt.value)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                  reviewReadiness === opt.value
                    ? 'bg-sage-600 text-white border-sage-600'
                    : 'bg-warm-white text-sage-700 border-sage-200 hover:border-sage-400'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-sage-700 mb-1">Review Notes</label>
          <textarea
            value={reviewReadinessNotes}
            onChange={(e) => setReviewReadinessNotes(e.target.value)}
            placeholder="Any context on review likelihood?"
            className="w-full min-h-[60px] p-3 rounded-lg border border-sage-200 bg-warm-white text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 resize-y"
          />
        </div>
      </div>

      {/* Reflections */}
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-semibold text-sage-900">Reflections</h3>
        <div>
          <label className="block text-xs font-medium text-sage-700 mb-1">What went well?</label>
          <textarea
            value={whatWentWell}
            onChange={(e) => setWhatWentWell(e.target.value)}
            placeholder="Highlights, smooth moments, things that worked beautifully..."
            className="w-full min-h-[80px] p-3 rounded-lg border border-sage-200 bg-warm-white text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 resize-y"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-sage-700 mb-1">What would you change?</label>
          <textarea
            value={whatToChange}
            onChange={(e) => setWhatToChange(e.target.value)}
            placeholder="Lessons learned, things to improve for next time..."
            className="w-full min-h-[80px] p-3 rounded-lg border border-sage-200 bg-warm-white text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 resize-y"
          />
        </div>
      </div>

      {/* Submit + AI Draft */}
      <div className="flex items-center justify-between gap-4 pt-2">
        <button
          type="button"
          onClick={handleGenerateDraft}
          disabled={generatingDraft || !existingFeedback?.id}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
            existingFeedback?.id
              ? 'bg-gold-50 text-gold-700 border-gold-200 hover:bg-gold-100'
              : 'bg-sage-50 text-sage-400 border-sage-200 cursor-not-allowed'
          )}
          title={existingFeedback?.id ? 'Generate AI review response draft' : 'Submit feedback first to generate a draft'}
        >
          {generatingDraft ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          Generate Review Response Draft
        </button>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || overallRating === 0}
          className={cn(
            'inline-flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors',
            overallRating > 0
              ? 'bg-sage-600 text-white hover:bg-sage-700'
              : 'bg-sage-100 text-sage-400 cursor-not-allowed'
          )}
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Submit Feedback
        </button>
      </div>

      {proactiveDraft && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-gold-500" />
            <h3 className="text-sm font-semibold text-sage-900">AI Review Response Draft</h3>
          </div>
          <p className="text-sm text-sage-700 whitespace-pre-wrap">{proactiveDraft}</p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Invite Status Badge
// ---------------------------------------------------------------------------

function InviteStatusBadge({
  wedding,
  weddingId,
  venueId,
  venueSlug,
  people,
  onUpdated,
}: {
  wedding: WeddingRow
  weddingId: string
  venueId: string
  venueSlug: string | null
  people: PersonRow[]
  onUpdated: () => void
}) {
  const [sending, setSending] = useState(false)

  async function sendInvite() {
    const partner1 = people.find((p) => p.role === 'partner1' || p.role === 'bride')
    const partner2 = people.find((p) => p.role === 'partner2' || p.role === 'groom')

    if (!partner1?.email) {
      alert('Partner 1 must have an email address to send an invitation.')
      return
    }

    setSending(true)
    try {
      const supabase = createClient()

      // Generate event code if not already set
      let eventCode = wedding.event_code
      if (!eventCode) {
        const prefix = (venueSlug || 'BLM').slice(0, 3).toUpperCase()
        eventCode = `${prefix}-${Math.floor(100 + Math.random() * 900)}`
        await supabase
          .from('weddings')
          .update({ event_code: eventCode })
          .eq('id', weddingId)
      }

      const coupleName = partner2
        ? `${partner1.first_name} & ${partner2.first_name}`
        : partner1.first_name

      await fetch('/api/portal/invite-couple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weddingId,
          venueId,
          email: partner1.email,
          partnerEmail: partner2?.email || null,
          eventCode,
          coupleName,
        }),
      })

      onUpdated()
    } catch (err) {
      console.error('Failed to send invite:', err)
      alert('Failed to send invitation. Please try again.')
    } finally {
      setSending(false)
    }
  }

  if (wedding.couple_registered_at) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
        <UserCheck className="w-3.5 h-3.5" />
        Couple Registered
      </span>
    )
  }

  if (wedding.event_code && wedding.couple_invited_at) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
          <Mail className="w-3.5 h-3.5" />
          Invited (pending)
        </span>
        <button
          onClick={sendInvite}
          disabled={sending}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-sage-600 hover:text-sage-800 hover:bg-sage-50 border border-sage-200 transition-colors disabled:opacity-50"
        >
          {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          Resend
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={sendInvite}
      disabled={sending}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sage-50 text-sage-700 border border-sage-200 hover:bg-sage-100 transition-colors disabled:opacity-50"
    >
      {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
      Send Invite
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function WeddingProfilePage() {
  const params = useParams()
  const weddingId = params.id as string

  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Data
  const [wedding, setWedding] = useState<WeddingRow | null>(null)
  const [people, setPeople] = useState<PersonRow[]>([])
  const [clientCode, setClientCode] = useState<string | null>(null)
  const [venue, setVenue] = useState<VenueRow | null>(null)
  const [planningNotes, setPlanningNotes] = useState<PlanningNoteRow[]>([])
  const [vendors, setVendors] = useState<BookedVendorRow[]>([])
  const [guests, setGuests] = useState<GuestRow[]>([])
  const [timelineItems, setTimelineItems] = useState<TimelineItemRow[]>([])
  const [budgetItems, setBudgetItems] = useState<BudgetRow[]>([])
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [sageConversations, setSageConversations] = useState<SageConversationRow[]>([])
  const [checklist, setChecklist] = useState<ChecklistItemRow[]>([])
  const [internalNotes, setInternalNotes] = useState('')
  const [consultant, setConsultant] = useState<ConsultantRow | null>(null)
  const [eventFeedback, setEventFeedback] = useState<EventFeedbackRow | null>(null)
  const [feedbackVendorRatings, setFeedbackVendorRatings] = useState<EventFeedbackVendorRow[]>([])

  const fetchData = useCallback(async () => {
    try {
      const supabase = createClient()

      // Fetch wedding first
      const { data: weddingData, error: weddingErr } = await supabase
        .from('weddings')
        .select('*')
        .eq('id', weddingId)
        .single()

      if (weddingErr) throw weddingErr
      const w = weddingData as WeddingRow
      setWedding(w)
      setInternalNotes(w.notes ?? '')

      // Fetch all related data in parallel
      const [
        peopleRes,
        codeRes,
        venueRes,
        notesRes,
        vendorsRes,
        guestsRes,
        timelineRes,
        budgetRes,
        messagesRes,
        sageRes,
        checklistRes,
        feedbackRes,
      ] = await Promise.all([
        supabase.from('people').select('id, first_name, last_name, role, email, phone').eq('wedding_id', weddingId),
        supabase.from('client_codes').select('code').eq('wedding_id', weddingId).maybeSingle(),
        supabase.from('venues').select('name, slug').eq('id', w.venue_id).single(),
        supabase.from('planning_notes').select('id, category, content, source_message, status, created_at').eq('wedding_id', weddingId).order('created_at', { ascending: false }),
        supabase.from('booked_vendors').select('id, vendor_type, vendor_name, vendor_contact, is_booked, contract_uploaded, notes').eq('wedding_id', weddingId),
        supabase.from('guest_list').select('id, rsvp_status, dietary_restrictions, table_assignment_id').eq('wedding_id', weddingId),
        supabase.from('timeline').select('id, time, title, description, category, location, sort_order').eq('wedding_id', weddingId).order('sort_order'),
        supabase.from('budget_items').select('id, category, item_name, budgeted, committed, paid').eq('wedding_id', weddingId),
        supabase.from('messages').select('id, sender_role, content, created_at').eq('wedding_id', weddingId).order('created_at', { ascending: false }).limit(100),
        supabase.from('sage_conversations').select('id, role, content, created_at').eq('wedding_id', weddingId).order('created_at', { ascending: false }).limit(200),
        supabase.from('checklist_items').select('id, title, is_completed, category').eq('wedding_id', weddingId),
        supabase.from('event_feedback').select('*').eq('wedding_id', weddingId).maybeSingle(),
      ])

      setPeople((peopleRes.data ?? []) as PersonRow[])
      setClientCode((codeRes.data as ClientCodeRow | null)?.code ?? null)
      setVenue((venueRes.data as VenueRow) ?? null)
      setPlanningNotes((notesRes.data ?? []) as PlanningNoteRow[])
      setVendors((vendorsRes.data ?? []) as BookedVendorRow[])
      setGuests((guestsRes.data ?? []) as GuestRow[])
      setTimelineItems((timelineRes.data ?? []) as TimelineItemRow[])
      setBudgetItems((budgetRes.data ?? []) as BudgetRow[])
      setMessages((messagesRes.data ?? []) as MessageRow[])
      setSageConversations((sageRes.data ?? []) as SageConversationRow[])
      setChecklist((checklistRes.data ?? []) as ChecklistItemRow[])

      // Fetch event feedback
      const fb = (feedbackRes.data as EventFeedbackRow | null) ?? null
      setEventFeedback(fb)

      // If feedback exists, fetch vendor ratings
      if (fb) {
        const { data: vrData } = await supabase
          .from('event_feedback_vendors')
          .select('id, event_feedback_id, vendor_id, vendor_name, vendor_type, rating, notes, would_recommend')
          .eq('event_feedback_id', fb.id)

        setFeedbackVendorRatings((vrData ?? []) as EventFeedbackVendorRow[])
      } else {
        setFeedbackVendorRatings([])
      }

      // Fetch consultant name if assigned
      if (w.assigned_consultant_id) {
        const { data: consultantData } = await supabase
          .from('user_profiles')
          .select('first_name, last_name')
          .eq('id', w.assigned_consultant_id)
          .maybeSingle()
        setConsultant((consultantData as ConsultantRow) ?? null)
      }

      setError(null)
    } catch (err) {
      console.error('Failed to fetch wedding profile:', err)
      setError('Failed to load wedding profile')
    } finally {
      setLoading(false)
    }
  }, [weddingId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Derived
  const coupleNames = useMemo(() => getCoupleNames(people), [people])
  const coupleFullNames = useMemo(() => getCoupleFullNames(people), [people])
  const days = wedding ? daysUntil(wedding.wedding_date) : null
  const status = wedding ? statusConfig(wedding.status) : null
  const StatusIcon = status?.icon ?? Clock

  if (loading) {
    return (
      <div className="space-y-6">
        <Link href="/portal/weddings" className="flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to Weddings
        </Link>
        <ProfileSkeleton />
      </div>
    )
  }

  if (error || !wedding) {
    return (
      <div className="space-y-6">
        <Link href="/portal/weddings" className="flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to Weddings
        </Link>
        <div className="bg-red-50 border border-red-200 rounded-xl p-8 text-center">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h2 className="font-heading text-lg font-semibold text-red-800 mb-1">{error ?? 'Wedding not found'}</h2>
          <p className="text-sm text-red-600">This wedding may not exist or you may not have access.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/portal/weddings"
        className="inline-flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Weddings
      </Link>

      {/* Header */}
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-start gap-4">
            {/* Couple photo or initials */}
            {wedding.couple_photo_url ? (
              <img
                src={wedding.couple_photo_url}
                alt={coupleNames}
                className="w-16 h-16 rounded-xl object-cover border-2 border-sage-100 shrink-0"
              />
            ) : (
              <div className="w-16 h-16 rounded-xl bg-sage-100 flex items-center justify-center shrink-0">
                <Heart className="w-7 h-7 text-sage-400" />
              </div>
            )}
            <div>
              <h1 className="font-heading text-2xl font-bold text-sage-900 mb-1">
                {coupleFullNames}
              </h1>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Status badge */}
                {status && (
                  <span className={cn('inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold', status.className)}>
                    <StatusIcon className="w-3 h-3" />
                    {status.label}
                  </span>
                )}
                {/* Client code */}
                {clientCode && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-sage-50 border border-sage-200 text-xs font-mono font-semibold text-sage-700">
                    {clientCode}
                  </span>
                )}
                {/* Days until */}
                {days !== null && days >= 0 && wedding.status !== 'completed' && wedding.status !== 'lost' && (
                  <span className={cn(
                    'text-xs font-medium px-2 py-0.5 rounded-full',
                    days <= 30 ? 'bg-red-50 text-red-700' :
                    days <= 90 ? 'bg-amber-50 text-amber-700' :
                    'bg-teal-50 text-teal-700'
                  )}>
                    {days === 0 ? 'Today!' : `${days} days away`}
                  </span>
                )}
                {days !== null && days < 0 && wedding.status !== 'completed' && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-sage-100 text-sage-500">
                    {Math.abs(days)}d ago
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-2 text-sm text-sage-600">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-sage-400" />
                  {formatDate(wedding.wedding_date)}
                </span>
                {venue && (
                  <span className="text-sage-500">{venue.name}</span>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <Link
                href={`/portal/weddings/${weddingId}/portal`}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-sage-600 text-white hover:bg-sage-700 transition-colors"
              >
                <Eye className="w-3.5 h-3.5" />
                View Portal
              </Link>
              {venue?.slug && (
                <Link
                  href={`/couple/${venue.slug}?wedding=${weddingId}`}
                  target="_blank"
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open as Couple
                </Link>
              )}
            </div>

            {/* Invitation status + resend */}
            <InviteStatusBadge
              wedding={wedding}
              weddingId={weddingId}
              venueId={wedding.venue_id}
              venueSlug={venue?.slug || null}
              people={people}
              onUpdated={fetchData}
            />
          </div>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="border-b border-sage-200 -mb-px">
        <nav className="flex gap-1 overflow-x-auto pb-px" aria-label="Wedding profile tabs">
          {TABS.map((tab) => {
            const Icon = tab.icon
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors',
                  isActive
                    ? 'border-sage-600 text-sage-900'
                    : 'border-transparent text-sage-500 hover:text-sage-700 hover:border-sage-300'
                )}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Tab content */}
      <div className="min-h-[300px]">
        {activeTab === 'overview' && (
          <OverviewTab
            wedding={wedding}
            people={people}
            checklist={checklist}
            budget={budgetItems}
            guests={guests}
            messages={messages}
            sageConversations={sageConversations}
            consultant={consultant}
          />
        )}
        {activeTab === 'completeness' && (
          <CompletenessTab weddingId={weddingId} guests={guests} vendors={vendors} checklist={checklist} budgetItems={budgetItems} timelineItems={timelineItems} />
        )}
        {activeTab === 'planning-notes' && (
          <PlanningNotesTab notes={planningNotes} />
        )}
        {activeTab === 'vendors' && wedding && (
          <VendorsTab vendors={vendors} weddingId={weddingId} venueId={wedding.venue_id} />
        )}
        {activeTab === 'guests' && (
          <GuestsTab guests={guests} guestCountEstimate={wedding.guest_count_estimate} />
        )}
        {activeTab === 'timeline' && (
          <TimelineTab items={timelineItems} />
        )}
        {activeTab === 'budget' && (
          <BudgetTab items={budgetItems} />
        )}
        {activeTab === 'ceremony-chairs' && (
          <CeremonyChairsTab weddingId={weddingId} />
        )}
        {activeTab === 'table-map' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">View the couple&apos;s floor plan layout. Use the full editor to place tables.</p>
            <Link
              href={`/portal/weddings/${weddingId}/table-map`}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition"
            >
              Open Table Map Editor
            </Link>
          </div>
        )}
        {activeTab === 'communications' && (
          <CommunicationsTab messages={messages} sageConversations={sageConversations} />
        )}
        {activeTab === 'internal-notes' && wedding && (
          <InternalNotesFeed
            weddingId={weddingId}
            venueId={wedding.venue_id}
            legacyNote={internalNotes}
            onLegacyDismiss={() => setInternalNotes('')}
          />
        )}
        {activeTab === 'day-of-memories' && wedding && (
          <DayOfMemoriesTab weddingId={weddingId} venueId={wedding.venue_id} />
        )}
        {activeTab === 'feedback' && (
          <PostEventFeedbackTab
            wedding={wedding}
            vendors={vendors}
            existingFeedback={eventFeedback}
            existingVendorRatings={feedbackVendorRatings}
            onSubmit={fetchData}
          />
        )}
      </div>
    </div>
  )
}
