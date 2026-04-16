'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft,
  Mail,
  Phone,
  Calendar,
  Users,
  DollarSign,
  Flame,
  Clock,
  ArrowUpRight,
  ArrowDownRight,
  Send,
  PhoneCall,
  Voicemail,
  MessageSquare,
  TrendingUp,
  FileText,
  AlertCircle,
  Copy,
  CheckCircle,
  Lightbulb,
  Store,
  Palette,
  ClipboardCheck,
  CalendarDays,
  ShieldCheck,
  StickyNote,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WeddingDetail {
  id: string
  venue_id: string
  status: string
  source: string | null
  source_detail: string | null
  wedding_date: string | null
  guest_count_estimate: number | null
  booking_value: number | null
  assigned_consultant_id: string | null
  inquiry_date: string | null
  first_response_at: string | null
  tour_date: string | null
  booked_at: string | null
  lost_at: string | null
  lost_reason: string | null
  heat_score: number
  temperature_tier: string
  notes: string | null
  created_at: string
  updated_at: string
}

interface PersonRow {
  id: string
  role: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
}

interface InteractionRow {
  id: string
  type: string
  direction: string
  subject: string | null
  body_preview: string | null
  timestamp: string
}

interface EngagementEventRow {
  id: string
  event_type: string
  points: number
  metadata: Record<string, unknown> | null
  created_at: string
}

interface LeadScoreRow {
  score: number
  temperature_tier: string
  calculated_at: string
}

interface DraftRow {
  id: string
  status: string
  subject: string | null
  body_preview: string | null
  confidence_score: number | null
  brain_used: string | null
  auto_sent: boolean
  approved_by: string | null
  approved_at: string | null
  created_at: string
}

interface DraftFeedbackRow {
  id: string
  draft_id: string
  feedback_type: string
  rejection_reason: string | null
  created_at: string
}

interface TourRow {
  id: string
  scheduled_date: string | null
  status: string
  outcome: string | null
  notes: string | null
  created_at: string
}

interface ActivityLogRow {
  id: string
  activity_type: string
  entity_type: string | null
  details: Record<string, unknown> | null
  created_at: string
}

// Unified timeline event
interface TimelineEvent {
  id: string
  timestamp: string
  icon: 'inbox' | 'send' | 'robot' | 'check' | 'reject' | 'calendar' | 'document' | 'flame' | 'note' | 'status' | 'tour' | 'contract' | 'edit'
  title: string
  description?: string
  actor?: string
}

interface PlanningNoteRow {
  id: string
  category: string
  content: string
  source_message: string | null
  status: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceBadge(source: string | null): { bg: string; text: string; label: string } {
  switch (source) {
    case 'the_knot':
      return { bg: 'bg-rose-50', text: 'text-rose-700', label: 'The Knot' }
    case 'weddingwire':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'WeddingWire' }
    case 'google':
      return { bg: 'bg-sky-50', text: 'text-sky-700', label: 'Google' }
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

function statusConfig(status: string): { bg: string; text: string; label: string } {
  switch (status) {
    case 'inquiry':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Inquiry' }
    case 'tour_scheduled':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label: 'Tour Scheduled' }
    case 'tour_completed':
      return { bg: 'bg-indigo-50', text: 'text-indigo-700', label: 'Tour Completed' }
    case 'proposal_sent':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Proposal Sent' }
    case 'booked':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Booked' }
    case 'completed':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Completed' }
    case 'lost':
      return { bg: 'bg-red-50', text: 'text-red-700', label: 'Lost' }
    case 'cancelled':
      return { bg: 'bg-gray-50', text: 'text-gray-700', label: 'Cancelled' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: status }
  }
}

function heatColor(tier: string): string {
  switch (tier) {
    case 'hot': return 'text-red-500'
    case 'warm': return 'text-amber-500'
    case 'cool': return 'text-blue-500'
    case 'cold': return 'text-blue-800'
    case 'frozen': return 'text-gray-400'
    default: return 'text-sage-400'
  }
}

function heatBg(tier: string): string {
  switch (tier) {
    case 'hot': return 'bg-red-500'
    case 'warm': return 'bg-amber-500'
    case 'cool': return 'bg-blue-500'
    case 'cold': return 'bg-blue-800'
    case 'frozen': return 'bg-gray-400'
    default: return 'bg-sage-300'
  }
}

function fmt$(v: number): string {
  return `$${v.toLocaleString()}`
}

function fmtDate(d: string | null): string {
  if (!d) return '--'
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function fmtDatetime(d: string): string {
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function eventTypeLabel(type: string): string {
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function noteCategoryConfig(category: string): {
  bg: string
  text: string
  label: string
  icon: React.ComponentType<{ className?: string }>
} {
  switch (category) {
    case 'vendor':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label: 'Vendor', icon: Store }
    case 'guest_count':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Guest Count', icon: Users }
    case 'decor':
      return { bg: 'bg-pink-50', text: 'text-pink-700', label: 'Decor', icon: Palette }
    case 'checklist':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Checklist', icon: ClipboardCheck }
    case 'cost':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Cost', icon: DollarSign }
    case 'date':
      return { bg: 'bg-indigo-50', text: 'text-indigo-700', label: 'Date', icon: CalendarDays }
    case 'policy':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Policy', icon: ShieldCheck }
    case 'note':
      return { bg: 'bg-gray-50', text: 'text-gray-700', label: 'Note', icon: StickyNote }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: category, icon: Lightbulb }
  }
}

function interactionIcon(type: string, direction: string) {
  if (type === 'call') return <PhoneCall className="w-4 h-4" />
  if (type === 'voicemail') return <Voicemail className="w-4 h-4" />
  if (type === 'sms') return <MessageSquare className="w-4 h-4" />
  return direction === 'inbound'
    ? <ArrowDownRight className="w-4 h-4" />
    : <ArrowUpRight className="w-4 h-4" />
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function ProfileSkeleton() {
  return (
    <div className="space-y-6">
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-64 bg-sage-100 rounded" />
        <div className="h-5 w-48 bg-sage-50 rounded" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm animate-pulse">
            <div className="h-40 bg-sage-50 rounded" />
          </div>
        </div>
        <div className="space-y-6">
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm animate-pulse">
            <div className="h-32 bg-sage-50 rounded" />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Client Journey Milestone
// ---------------------------------------------------------------------------

function JourneyMilestone({
  label,
  date,
  active,
  completed,
}: {
  label: string
  date: string | null
  active: boolean
  completed: boolean
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          'w-3 h-3 rounded-full shrink-0 border-2',
          completed
            ? 'bg-sage-500 border-sage-500'
            : active
              ? 'bg-white border-sage-500'
              : 'bg-white border-sage-200'
        )}
      />
      <div className="flex-1 min-w-0">
        <p className={cn('text-sm', completed || active ? 'text-sage-800 font-medium' : 'text-sage-400')}>
          {label}
        </p>
        {date && (
          <p className="text-xs text-sage-500">{fmtDate(date)}</p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function ClientProfilePage() {
  const router = useRouter()
  const params = useParams()
  const weddingId = params.id as string
  const VENUE_ID = useVenueId()

  const [wedding, setWedding] = useState<WeddingDetail | null>(null)
  const [people, setPeople] = useState<PersonRow[]>([])
  const [interactions, setInteractions] = useState<InteractionRow[]>([])
  const [events, setEvents] = useState<EngagementEventRow[]>([])
  const [scoreHistory, setScoreHistory] = useState<LeadScoreRow[]>([])
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [draftFeedback, setDraftFeedback] = useState<DraftFeedbackRow[]>([])
  const [tours, setTours] = useState<TourRow[]>([])
  const [activityLog, setActivityLog] = useState<ActivityLogRow[]>([])
  const [planningNotes, setPlanningNotes] = useState<PlanningNoteRow[]>([])
  const [clientCode, setClientCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)

  const fetchData = useCallback(async () => {
    const supabase = createClient()

    try {
      const [weddingRes, peopleRes, intRes, eventsRes, scoreRes, draftsRes, codeRes, notesRes] = await Promise.all([
        supabase
          .from('weddings')
          .select('*')
          .eq('id', weddingId)
          .eq('venue_id', VENUE_ID)
          .single(),
        supabase
          .from('people')
          .select('id, role, first_name, last_name, email, phone')
          .eq('wedding_id', weddingId)
          .eq('venue_id', VENUE_ID),
        supabase
          .from('interactions')
          .select('id, type, direction, subject, body_preview, timestamp')
          .eq('wedding_id', weddingId)
          .eq('venue_id', VENUE_ID)
          .order('timestamp', { ascending: false })
          .limit(50),
        supabase
          .from('engagement_events')
          .select('id, event_type, points, metadata, created_at')
          .eq('wedding_id', weddingId)
          .order('created_at', { ascending: false })
          .limit(30),
        supabase
          .from('lead_score_history')
          .select('score, temperature_tier, calculated_at')
          .eq('wedding_id', weddingId)
          .order('calculated_at', { ascending: true }),
        supabase
          .from('drafts')
          .select('id, status, subject, body_preview, created_at')
          .eq('wedding_id', weddingId)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('client_codes')
          .select('code')
          .eq('wedding_id', weddingId)
          .eq('venue_id', VENUE_ID)
          .maybeSingle(),
        supabase
          .from('planning_notes')
          .select('id, category, content, source_message, status, created_at')
          .eq('wedding_id', weddingId)
          .eq('venue_id', VENUE_ID)
          .order('created_at', { ascending: false })
          .limit(50),
      ])

      if (weddingRes.error) throw weddingRes.error

      setWedding(weddingRes.data as WeddingDetail)
      setPeople((peopleRes.data ?? []) as PersonRow[])
      setInteractions((intRes.data ?? []) as InteractionRow[])
      setEvents((eventsRes.data ?? []) as EngagementEventRow[])
      setScoreHistory((scoreRes.data ?? []) as LeadScoreRow[])
      setDrafts((draftsRes.data ?? []) as DraftRow[])
      setPlanningNotes((notesRes.data ?? []) as PlanningNoteRow[])
      setClientCode((codeRes.data as { code?: string } | null)?.code ?? null)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch client profile:', err)
      setError('Client not found or failed to load')
    } finally {
      setLoading(false)
    }
  }, [weddingId, VENUE_ID])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Derived data
  const partners = useMemo(
    () => people.filter((p) => p.role === 'partner1' || p.role === 'partner2'),
    [people]
  )

  const coupleName = useMemo(() => {
    if (partners.length === 0) return 'Unknown Client'
    return partners.map((p) => p.first_name).join(' & ')
  }, [partners])

  const primaryEmail = useMemo(
    () => partners.find((p) => p.email)?.email ?? null,
    [partners]
  )

  const primaryPhone = useMemo(
    () => partners.find((p) => p.phone)?.phone ?? null,
    [partners]
  )

  // Journey stages
  const journeyStages = useMemo(() => {
    if (!wedding) return []
    const stageOrder = ['inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent', 'booked', 'completed']
    const currentIdx = stageOrder.indexOf(wedding.status)
    return [
      { label: 'Inquiry Received', date: wedding.inquiry_date, completed: currentIdx >= 0, active: wedding.status === 'inquiry' },
      { label: 'First Response', date: wedding.first_response_at, completed: !!wedding.first_response_at, active: false },
      { label: 'Tour Scheduled', date: wedding.tour_date, completed: currentIdx >= 1, active: wedding.status === 'tour_scheduled' },
      { label: 'Tour Completed', date: wedding.tour_date && currentIdx >= 2 ? wedding.tour_date : null, completed: currentIdx >= 2, active: wedding.status === 'tour_completed' },
      { label: 'Proposal Sent', date: null, completed: currentIdx >= 3, active: wedding.status === 'proposal_sent' },
      { label: 'Booked', date: wedding.booked_at, completed: currentIdx >= 4, active: wedding.status === 'booked' },
      { label: 'Completed', date: null, completed: currentIdx >= 5, active: wedding.status === 'completed' },
    ]
  }, [wedding])

  // Interaction stats
  const interactionStats = useMemo(() => {
    const total = interactions.length
    const inbound = interactions.filter((i) => i.direction === 'inbound').length
    const outbound = interactions.filter((i) => i.direction === 'outbound').length
    return { total, inbound, outbound }
  }, [interactions])

  // Copy tracking ID
  function copyTrackingId() {
    navigator.clipboard.writeText(weddingId)
    setCopiedId(true)
    setTimeout(() => setCopiedId(false), 2000)
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <button onClick={() => router.back()} className="flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <ProfileSkeleton />
      </div>
    )
  }

  if (error || !wedding) {
    return (
      <div className="space-y-6">
        <button onClick={() => router.back()} className="flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-red-50 border border-red-200 rounded-xl p-8 text-center">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h2 className="font-heading text-lg font-semibold text-red-800 mb-1">{error}</h2>
          <p className="text-sm text-red-600">This client may not exist or you don&apos;t have access.</p>
        </div>
      </div>
    )
  }

  const source = sourceBadge(wedding.source)
  const status = statusConfig(wedding.status)

  return (
    <div className="space-y-6">
      {/* Back + Header */}
      <div>
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700 mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <h1 className="font-heading text-3xl font-bold text-sage-900">
                {coupleName}
              </h1>
              {clientCode && (
                <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-sage-50 border border-sage-200 text-sm font-mono font-semibold text-sage-700">
                  {clientCode}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${status.bg} ${status.text}`}>
                {status.label}
              </span>
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${source.bg} ${source.text}`}>
                {source.label}
              </span>
              <span className={cn('flex items-center gap-1 text-sm font-bold', heatColor(wedding.temperature_tier))}>
                <Flame className="w-4 h-4" />
                {wedding.heat_score} {wedding.temperature_tier}
              </span>
            </div>
          </div>

          {/* Tracking ID */}
          <button
            onClick={copyTrackingId}
            className="flex items-center gap-2 px-3 py-1.5 bg-sage-50 border border-sage-200 rounded-lg text-xs font-mono text-sage-600 hover:bg-sage-100 transition-colors shrink-0"
            title="Copy lifecycle tracking ID"
          >
            {copiedId ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            {weddingId.slice(0, 8)}...
          </button>
        </div>
      </div>

      {/* Main Layout: 2/3 + 1/3 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column — Story + Timeline */}
        <div className="lg:col-span-2 space-y-6">
          {/* Contact Info Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <Calendar className="w-4 h-4 text-sage-400" />
                <span className="text-xs text-sage-500">Wedding Date</span>
              </div>
              <p className="text-sm font-semibold text-sage-900">{fmtDate(wedding.wedding_date)}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-sage-400" />
                <span className="text-xs text-sage-500">Guest Count</span>
              </div>
              <p className="text-sm font-semibold text-sage-900">{wedding.guest_count_estimate ?? '--'}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <DollarSign className="w-4 h-4 text-sage-400" />
                <span className="text-xs text-sage-500">Booking Value</span>
              </div>
              <p className="text-sm font-semibold text-sage-900">
                {wedding.booking_value ? fmt$(wedding.booking_value) : '--'}
              </p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="w-4 h-4 text-sage-400" />
                <span className="text-xs text-sage-500">Days Since Inquiry</span>
              </div>
              <p className="text-sm font-semibold text-sage-900">
                {wedding.inquiry_date
                  ? Math.floor((Date.now() - new Date(wedding.inquiry_date).getTime()) / 86400000)
                  : '--'}
              </p>
            </div>
          </div>

          {/* Contact Details */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-base font-semibold text-sage-900 mb-4">Contacts</h2>
            <div className="space-y-3">
              {partners.map((p) => (
                <div key={p.id} className="flex items-center justify-between py-2 border-b border-sage-100 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-sage-900">
                      {p.first_name} {p.last_name}
                      <span className="ml-2 text-xs text-sage-400 font-normal capitalize">{p.role.replace('_', ' ')}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-sage-500">
                    {p.email && (
                      <a href={`mailto:${p.email}`} className="flex items-center gap-1 hover:text-sage-700 transition-colors">
                        <Mail className="w-3.5 h-3.5" /> {p.email}
                      </a>
                    )}
                    {p.phone && (
                      <a href={`tel:${p.phone}`} className="flex items-center gap-1 hover:text-sage-700 transition-colors">
                        <Phone className="w-3.5 h-3.5" /> {p.phone}
                      </a>
                    )}
                  </div>
                </div>
              ))}
              {partners.length === 0 && (
                <p className="text-sm text-sage-400">No contact info available</p>
              )}
            </div>
          </div>

          {/* Interaction Timeline */}
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <h2 className="font-heading text-base font-semibold text-sage-900">
                Communication History
              </h2>
              <div className="flex items-center gap-3 text-xs text-sage-500">
                <span>{interactionStats.total} total</span>
                <span className="flex items-center gap-1"><ArrowDownRight className="w-3 h-3 text-blue-500" /> {interactionStats.inbound} in</span>
                <span className="flex items-center gap-1"><ArrowUpRight className="w-3 h-3 text-emerald-500" /> {interactionStats.outbound} out</span>
              </div>
            </div>

            {interactions.length === 0 ? (
              <div className="p-8 text-center">
                <Send className="w-8 h-8 text-sage-300 mx-auto mb-2" />
                <p className="text-sm text-sage-500">No interactions recorded yet</p>
              </div>
            ) : (
              <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
                {interactions.map((int) => (
                  <div key={int.id} className="px-6 py-3 hover:bg-warm-white/50 transition-colors">
                    <div className="flex items-start gap-3">
                      <div className={cn(
                        'mt-0.5 shrink-0',
                        int.direction === 'inbound' ? 'text-blue-500' : 'text-emerald-500'
                      )}>
                        {interactionIcon(int.type, int.direction)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="text-sm font-medium text-sage-900 truncate">
                            {int.subject || `${int.type} ${int.direction}`}
                          </p>
                          <span className={cn(
                            'text-[10px] font-medium px-1.5 py-0.5 rounded',
                            int.direction === 'inbound'
                              ? 'bg-blue-50 text-blue-600'
                              : 'bg-emerald-50 text-emerald-600'
                          )}>
                            {int.direction}
                          </span>
                        </div>
                        {int.body_preview && (
                          <p className="text-xs text-sage-500 line-clamp-2">{int.body_preview}</p>
                        )}
                        <p className="text-[11px] text-sage-400 mt-1">{fmtDatetime(int.timestamp)}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* AI Drafts */}
          {drafts.length > 0 && (
            <div className="bg-surface border border-border rounded-xl shadow-sm">
              <div className="px-6 py-4 border-b border-border">
                <h2 className="font-heading text-base font-semibold text-sage-900">
                  AI Draft History
                </h2>
              </div>
              <div className="divide-y divide-border">
                {drafts.map((d) => (
                  <div key={d.id} className="px-6 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <FileText className="w-3.5 h-3.5 text-sage-400" />
                      <p className="text-sm font-medium text-sage-900 truncate">
                        {d.subject || 'Draft'}
                      </p>
                      <span className={cn(
                        'text-[10px] font-medium px-1.5 py-0.5 rounded',
                        d.status === 'approved' ? 'bg-emerald-50 text-emerald-600' :
                        d.status === 'rejected' ? 'bg-red-50 text-red-600' :
                        d.status === 'sent' ? 'bg-teal-50 text-teal-600' :
                        'bg-amber-50 text-amber-600'
                      )}>
                        {d.status}
                      </span>
                    </div>
                    {d.body_preview && (
                      <p className="text-xs text-sage-500 line-clamp-2 ml-5">{d.body_preview}</p>
                    )}
                    <p className="text-[11px] text-sage-400 mt-1 ml-5">{fmtDatetime(d.created_at)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column — Journey + Heat + Events */}
        <div className="space-y-6">
          {/* Client Journey */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-base font-semibold text-sage-900 mb-4">
              Client Journey
            </h2>
            <div className="space-y-3 relative">
              {/* Connecting line */}
              <div className="absolute left-[5px] top-2 bottom-2 w-[2px] bg-sage-100" />
              {journeyStages.map((stage, i) => (
                <JourneyMilestone key={i} {...stage} />
              ))}
            </div>
            {wedding.status === 'lost' && wedding.lost_reason && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-xs font-medium text-red-700 mb-1">Lost Reason</p>
                <p className="text-sm text-red-600">{wedding.lost_reason}</p>
              </div>
            )}
          </div>

          {/* Heat Score */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h2 className="font-heading text-base font-semibold text-sage-900 mb-4 flex items-center gap-2">
              <Flame className={cn('w-5 h-5', heatColor(wedding.temperature_tier))} />
              Heat Score
            </h2>
            <div className="flex items-center gap-3 mb-4">
              <div className={cn('text-4xl font-bold', heatColor(wedding.temperature_tier))}>
                {wedding.heat_score}
              </div>
              <div>
                <span className={cn(
                  'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold text-white capitalize',
                  heatBg(wedding.temperature_tier)
                )}>
                  {wedding.temperature_tier}
                </span>
              </div>
            </div>

            {/* Score trend */}
            {scoreHistory.length > 1 && (
              <div className="mb-4">
                <p className="text-xs text-sage-500 mb-2">Score over time</p>
                <div className="flex items-end gap-1 h-16">
                  {scoreHistory.map((s, i) => {
                    const max = Math.max(...scoreHistory.map((x) => x.score))
                    const height = max > 0 ? (s.score / max) * 100 : 0
                    return (
                      <div
                        key={i}
                        className={cn('flex-1 rounded-sm', heatBg(s.temperature_tier))}
                        style={{ height: `${Math.max(height, 4)}%` }}
                        title={`${fmtDate(s.calculated_at)}: ${s.score}`}
                      />
                    )
                  })}
                </div>
              </div>
            )}

            {/* Score bar */}
            <div className="h-2 bg-sage-100 rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', heatBg(wedding.temperature_tier))}
                style={{ width: `${Math.min(wedding.heat_score, 100)}%` }}
              />
            </div>
          </div>

          {/* Engagement Events */}
          {events.length > 0 && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <h2 className="font-heading text-base font-semibold text-sage-900 mb-4 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-teal-500" />
                Engagement Events
              </h2>
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {events.map((e) => (
                  <div key={e.id} className="flex items-center justify-between py-1.5 border-b border-sage-50 last:border-0">
                    <div>
                      <p className="text-xs font-medium text-sage-800">{eventTypeLabel(e.event_type)}</p>
                      <p className="text-[10px] text-sage-400">{fmtDatetime(e.created_at)}</p>
                    </div>
                    <span className={cn(
                      'text-xs font-bold',
                      e.points > 0 ? 'text-emerald-600' : 'text-red-500'
                    )}>
                      {e.points > 0 ? '+' : ''}{e.points}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Planning Notes (extracted from Sage conversations) */}
          {planningNotes.length > 0 && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <h2 className="font-heading text-base font-semibold text-sage-900 mb-4 flex items-center gap-2">
                <Lightbulb className="w-4 h-4 text-amber-500" />
                Planning Notes
              </h2>
              <p className="text-xs text-sage-500 mb-3">
                Auto-extracted from Sage conversations
              </p>
              <div className="space-y-3 max-h-[400px] overflow-y-auto">
                {planningNotes.map((note) => {
                  const config = noteCategoryConfig(note.category)
                  const NoteIcon = config.icon
                  return (
                    <div key={note.id} className="border-b border-sage-50 pb-2.5 last:border-0 last:pb-0">
                      <div className="flex items-start gap-2">
                        <NoteIcon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', config.text)} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                            <span className={cn(
                              'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium',
                              config.bg,
                              config.text
                            )}>
                              {config.label}
                            </span>
                          </div>
                          <p className="text-sm text-sage-800 leading-snug">{note.content}</p>
                          {note.source_message && (
                            <p className="text-[11px] text-sage-400 mt-1 line-clamp-1 italic">
                              &quot;{note.source_message.substring(0, 80)}{note.source_message.length > 80 ? '...' : ''}&quot;
                            </p>
                          )}
                          <p className="text-[10px] text-sage-400 mt-0.5">{fmtDatetime(note.created_at)}</p>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Notes */}
          {wedding.notes && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <h2 className="font-heading text-base font-semibold text-sage-900 mb-3">Notes</h2>
              <p className="text-sm text-sage-600 leading-relaxed whitespace-pre-wrap">{wedding.notes}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
