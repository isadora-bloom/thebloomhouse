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
} from 'lucide-react'

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
  estimated_cost: number | null
  actual_cost: number | null
  paid_amount: number | null
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

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type TabKey = 'overview' | 'planning-notes' | 'vendors' | 'guests' | 'timeline' | 'budget' | 'communications' | 'internal-notes'

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'planning-notes', label: 'Planning Notes', icon: StickyNote },
  { key: 'vendors', label: 'Vendors', icon: Utensils },
  { key: 'guests', label: 'Guests', icon: Users },
  { key: 'timeline', label: 'Timeline', icon: Clock },
  { key: 'budget', label: 'Budget', icon: DollarSign },
  { key: 'communications', label: 'Communications', icon: MessageCircle },
  { key: 'internal-notes', label: 'Internal Notes', icon: Lock },
]

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

// ---------------------------------------------------------------------------
// Communication Pulse
// ---------------------------------------------------------------------------

export function CommunicationPulse({ messageCount }: { messageCount: number }) {
  let label: string
  let bgClass: string
  let textClass: string
  let dotClass: string

  if (messageCount <= 2) {
    label = 'Quiet'
    bgClass = 'bg-amber-50'
    textClass = 'text-amber-700'
    dotClass = 'bg-amber-400'
  } else if (messageCount <= 8) {
    label = 'Typical'
    bgClass = 'bg-sage-50'
    textClass = 'text-sage-700'
    dotClass = 'bg-sage-500'
  } else {
    label = 'Active'
    bgClass = 'bg-emerald-50'
    textClass = 'text-emerald-700'
    dotClass = 'bg-emerald-500'
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium', bgClass, textClass)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', dotClass)} />
      {label}
    </span>
  )
}

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

  const totalEstimated = budget.reduce((s, b) => s + (b.estimated_cost ?? 0), 0)
  const totalActual = budget.reduce((s, b) => s + (b.actual_cost ?? 0), 0)
  const totalPaid = budget.reduce((s, b) => s + (b.paid_amount ?? 0), 0)

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

  return (
    <div className="space-y-6">
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

function VendorsTab({ vendors }: { vendors: BookedVendorRow[] }) {
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
      <div className="space-y-2">
        {vendors.map((vendor) => (
          <div key={vendor.id} className="flex items-center gap-3 bg-warm-white rounded-lg p-3 border border-sage-100">
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

function BudgetTab({ items }: { items: BudgetRow[] }) {
  const totalEstimated = items.reduce((s, b) => s + (b.estimated_cost ?? 0), 0)
  const totalActual = items.reduce((s, b) => s + (b.actual_cost ?? 0), 0)
  const totalPaid = items.reduce((s, b) => s + (b.paid_amount ?? 0), 0)
  const remaining = totalEstimated - totalActual

  // Group by category
  const byCategory: Record<string, { estimated: number; actual: number; paid: number; count: number }> = {}
  for (const item of items) {
    const cat = item.category || 'Uncategorized'
    if (!byCategory[cat]) byCategory[cat] = { estimated: 0, actual: 0, paid: 0, count: 0 }
    byCategory[cat].estimated += item.estimated_cost ?? 0
    byCategory[cat].actual += item.actual_cost ?? 0
    byCategory[cat].paid += item.paid_amount ?? 0
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

function InternalNotesTab({
  notes,
  weddingId,
  onSave,
  saving,
}: {
  notes: string
  weddingId: string
  onSave: (text: string) => void
  saving: boolean
}) {
  const [text, setText] = useState(notes)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-sage-500">
        <Lock className="w-3.5 h-3.5" />
        Staff-only notes. Not visible to the couple.
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add internal notes about this wedding — coordination details, special requests, concerns, anything the team should know..."
        className="w-full min-h-[200px] p-4 rounded-xl border border-sage-200 bg-warm-white text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-y"
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-sage-400">
          {text !== notes ? 'Unsaved changes' : 'Saved'}
        </p>
        <button
          onClick={() => onSave(text)}
          disabled={saving || text === notes}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            text !== notes
              ? 'bg-sage-600 text-white hover:bg-sage-700'
              : 'bg-sage-100 text-sage-400 cursor-not-allowed'
          )}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Notes
        </button>
      </div>
    </div>
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
  const [saving, setSaving] = useState(false)

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
      ] = await Promise.all([
        supabase.from('people').select('id, first_name, last_name, role, email, phone').eq('wedding_id', weddingId),
        supabase.from('client_codes').select('code').eq('wedding_id', weddingId).maybeSingle(),
        supabase.from('venues').select('name, slug').eq('id', w.venue_id).single(),
        supabase.from('planning_notes').select('id, category, content, source_message, status, created_at').eq('wedding_id', weddingId).order('created_at', { ascending: false }),
        supabase.from('booked_vendors').select('id, vendor_type, vendor_name, vendor_contact, is_booked, contract_uploaded, notes').eq('wedding_id', weddingId),
        supabase.from('guest_list').select('id, rsvp_status, dietary_restrictions, table_assignment_id').eq('wedding_id', weddingId),
        supabase.from('timeline').select('id, time, title, description, category, location, sort_order').eq('wedding_id', weddingId).order('sort_order'),
        supabase.from('budget').select('id, category, item_name, estimated_cost, actual_cost, paid_amount').eq('wedding_id', weddingId),
        supabase.from('messages').select('id, sender_role, content, created_at').eq('wedding_id', weddingId).order('created_at', { ascending: false }).limit(100),
        supabase.from('sage_conversations').select('id, role, content, created_at').eq('wedding_id', weddingId).order('created_at', { ascending: false }).limit(200),
        supabase.from('checklist_items').select('id, title, is_completed, category').eq('wedding_id', weddingId),
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

  // Save internal notes
  async function saveInternalNotes(text: string) {
    setSaving(true)
    try {
      const supabase = createClient()
      const { error: updateErr } = await supabase
        .from('weddings')
        .update({ notes: text, updated_at: new Date().toISOString() })
        .eq('id', weddingId)

      if (updateErr) throw updateErr
      setInternalNotes(text)
      if (wedding) {
        setWedding({ ...wedding, notes: text })
      }
    } catch (err) {
      console.error('Failed to save notes:', err)
    } finally {
      setSaving(false)
    }
  }

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
          <div className="flex items-center gap-2 shrink-0">
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
        {activeTab === 'planning-notes' && (
          <PlanningNotesTab notes={planningNotes} />
        )}
        {activeTab === 'vendors' && (
          <VendorsTab vendors={vendors} />
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
        {activeTab === 'communications' && (
          <CommunicationsTab messages={messages} sageConversations={sageConversations} />
        )}
        {activeTab === 'internal-notes' && (
          <InternalNotesTab
            notes={internalNotes}
            weddingId={weddingId}
            onSave={saveInternalNotes}
            saving={saving}
          />
        )}
      </div>
    </div>
  )
}
