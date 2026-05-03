'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { useAiName } from '@/lib/hooks/use-ai-name'
import { createClient } from '@/lib/supabase/client'
import { dedupePeopleByName } from '@/lib/utils/couple-name'
import { htmlToText } from '@/lib/utils/html-text'
import {
  ArrowLeft,
  Mail,
  Phone,
  Calendar,
  Users,
  DollarSign,
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
  Bot,
  XCircle,
  MapPin,
  FileSignature,
  PenLine,
  Inbox,
  History,
  Sparkles,
  HelpCircle,
  TrendingDown,
  Minus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { WeddingJourney } from '@/components/agent/wedding-journey'
import { SourceBadgeEditable } from '@/components/agent/source-badge-editable'
import { formatBloomNumber } from '@/lib/bloom-number/format'
import { LeadInsightsPanel } from '@/components/intel/lead-insights-panel'
import { styleForTier } from '@/lib/heat/tier-colors'
import { HeatBadge } from '@/components/intel/heat-badge'
import { CandidateSignalEvidence } from '@/components/agent/candidate-signal-evidence'
import { JourneyNarrative } from '@/components/agent/journey-narrative'
import { TourInsightsPanel } from '@/components/agent/tour-insights-panel'
import { CommitmentSignalsPanel } from '@/components/agent/commitment-signals-panel'
import { HeatHistoryPanel } from '@/components/agent/heat-history-panel'

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
  wedding_date_precision: 'day' | 'month' | 'season' | 'year' | null
  guest_count_estimate: number | null
  // T5-schema-gap (migration 165): explicit lead-side headcount estimate.
  // Distinct from guest_count_estimate (legacy / mixed-purpose) and from
  // the couple-portal RSVP count (which lives in the guest_list table).
  estimated_guests: number | null
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
  code_extension: string | null
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
  occurred_at: string
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
  // T5-α.1: actual column is `action`, not `feedback_type`.
  action: string
  rejection_reason: string | null
  created_at: string
}

interface TourRow {
  id: string
  // T5-Rixey-GGG: actual column is scheduled_at (timestamptz). Earlier
  // code typed this as scheduled_date which caused the page query to
  // request a column that doesn't exist — silently failing the JOIN.
  scheduled_at: string | null
  status?: string
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
interface PlanningNoteRow {
  id: string
  category: string
  content: string
  source_message: string | null
  status: string
  created_at: string
}

// Row from intelligence_extractions for rows of type 'inquiry_classification'.
// metadata holds { classification, confidence, extractedData, via, subject }.
interface ExtractionRow {
  id: string
  extraction_type: string
  confidence: number | null
  created_at: string
  interaction_id: string | null
  metadata: {
    classification?: string
    confidence?: number
    subject?: string
    via?: string
    parsedEventDate?: {
      iso: string
      precision: 'day' | 'month' | 'season' | 'year'
      raw: string
    } | null
    extractedData?: {
      senderName?: string
      partnerName?: string
      eventDate?: string
      guestCount?: number | string
      source?: string
      questions?: string[]
      urgencyLevel?: 'low' | 'medium' | 'high'
      sentiment?: 'positive' | 'neutral' | 'negative'
    }
  } | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// T5-Rixey-UU Bug E: removed unused sourceBadge() — the lead detail
// page renders source via <SourceBadgeEditable> which goes through
// the shared formatSourceLabel() utility. The local switch had drifted
// out of sync with the canonical labels and was dead code.

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

// Heat rendering moved to <HeatBadge> primitive (ARCH-20.2.1 / T5-ζ.1).
// The remaining bare uses of styleForTier in this file are the
// score-history sparkline + progress bar, where we need a raw
// background-color class on a non-badge element. They use the same
// canonical TIER_STYLES map under the hood.

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

// Render a date honoring its precision: day -> "Jun 14, 2026",
// month -> "June 2026", season -> "Fall 2026", year -> "2026".
// Keeps us from pretending a fuzzy "Fall 2026" is precisely Oct 1.
function fmtDateWithPrecision(
  d: string | null,
  precision: 'day' | 'month' | 'season' | 'year' | null | undefined
): string {
  if (!d) return '--'
  if (!precision || precision === 'day') return fmtDate(d)
  const dt = new Date(d)
  const year = dt.getUTCFullYear()
  const month = dt.getUTCMonth()
  if (precision === 'year') return String(year)
  if (precision === 'month') {
    return dt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }
  // Season: map month back to label. We store month 3=Spring, 6=Summer,
  // 9=Fall, 0=Winter per the fuzzy parser.
  const seasonLabel =
    month === 3 ? 'Spring' :
    month === 6 ? 'Summer' :
    month === 9 ? 'Fall' :
    month === 0 ? 'Winter' : 'Season'
  return `${seasonLabel} ${year}`
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

// ---------------------------------------------------------------------------
// AI Insights panel
//
// Aggregates every inquiry_classification extraction for this wedding into
// a single view: the most-recent parse (date, guest count, partner name,
// urgency, sentiment, source) up top, then a rolled-up set of every
// question the couple has asked across all emails, then a per-email feed
// so the user can see how the AI read each message.
//
// This is the only place the classifier's extractedData currently surfaces
// after 065. All data is persisted; this is the first surface. More to come
// (pipeline card badges, inbox quick-view, intel digest).
// ---------------------------------------------------------------------------

function sentimentPill(s?: string) {
  switch (s) {
    case 'positive':
      return { icon: <TrendingUp className="w-3 h-3" />, bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Positive' }
    case 'negative':
      return { icon: <TrendingDown className="w-3 h-3" />, bg: 'bg-rose-50', text: 'text-rose-700', label: 'Negative' }
    default:
      return { icon: <Minus className="w-3 h-3" />, bg: 'bg-sage-50', text: 'text-sage-700', label: 'Neutral' }
  }
}

function urgencyPill(u?: string) {
  switch (u) {
    case 'high':
      return { bg: 'bg-rose-100', text: 'text-rose-700', label: 'High urgency' }
    case 'medium':
      return { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Medium urgency' }
    default:
      return { bg: 'bg-sage-100', text: 'text-sage-700', label: 'Low urgency' }
  }
}

function AIInsightsPanel({ extractions }: { extractions: ExtractionRow[] }) {
  const inquiryExtractions = extractions.filter(
    (e) => e.extraction_type === 'inquiry_classification'
  )

  if (inquiryExtractions.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">AI Insights</h2>
        </div>
        <div className="p-8 text-center">
          <Bot className="w-8 h-8 text-sage-300 mx-auto mb-2" />
          <p className="text-sm text-sage-500">
            No AI classifications yet. New emails will populate this panel automatically.
          </p>
        </div>
      </div>
    )
  }

  // Most recent extraction drives the header chips.
  const latest = inquiryExtractions[0]
  const latestData = latest.metadata?.extractedData ?? {}

  // Roll up every question asked across every email, dedup case-insensitively.
  const allQuestions = new Map<string, string>() // key -> original
  for (const e of inquiryExtractions) {
    const qs = e.metadata?.extractedData?.questions ?? []
    for (const q of qs) {
      const key = q.trim().toLowerCase()
      if (key && !allQuestions.has(key)) allQuestions.set(key, q.trim())
    }
  }
  const questions = Array.from(allQuestions.values())

  const sentiment = sentimentPill(latestData.sentiment)
  const urgency = urgencyPill(latestData.urgencyLevel)

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-6 py-4 border-b border-border flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-sage-500" />
        <h2 className="font-heading text-base font-semibold text-sage-900">AI Insights</h2>
        <span className="text-xs text-sage-500 ml-2">
          {inquiryExtractions.length} classification{inquiryExtractions.length === 1 ? '' : 's'} on file
        </span>
      </div>

      {/*
        Header chips deliberately exclude partnerName / eventDate / guestCount
        / source because those already render in the Contacts + Contact Info
        Cards + header badges above. Only show classifier-native signals that
        have no other surface on this page: sentiment, email urgency,
        confidence, classification. "Email urgency" is NOT the heat score —
        heat is lead-quality probability (engagement points over time),
        urgency is per-email "needs fast reply."
      */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium', sentiment.bg, sentiment.text)}>
          {sentiment.icon}
          {sentiment.label}
        </span>
        <span
          className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium', urgency.bg, urgency.text)}
          title="Per-email response-time pressure from the classifier. Separate from Heat Score, which scores lead-quality probability."
        >
          {urgency.label.replace('urgency', 'email urgency')}
        </span>
        {typeof latest.metadata?.confidence === 'number' && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-sage-100 text-sage-700"
            title="How confident the inquiry classifier was that this email is a real inquiry vs reply, vendor pitch, or noise. Stored on intelligence_extractions.metadata.confidence. Distinct from Draft quality on the Drafts page."
          >
            Inquiry classification: {latest.metadata.confidence}%
          </span>
        )}
        {latest.metadata?.classification && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-sage-50 text-sage-700 border border-sage-200">
            {latest.metadata.classification}
          </span>
        )}
      </div>

      {/* Rolled-up questions across all emails */}
      {questions.length > 0 && (
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <HelpCircle className="w-3.5 h-3.5 text-sage-500" />
            <div className="text-xs font-semibold text-sage-700 uppercase tracking-wide">
              What they&apos;ve asked ({questions.length})
            </div>
          </div>
          <ul className="space-y-1.5">
            {questions.map((q, i) => (
              <li key={i} className="text-sm text-sage-800 leading-snug pl-2 border-l-2 border-sage-200">
                {q}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-email feed */}
      <div className="max-h-64 overflow-y-auto">
        {inquiryExtractions.map((e) => {
          const d = e.metadata?.extractedData ?? {}
          return (
            <div key={e.id} className="px-6 py-2.5 border-b border-border last:border-b-0 text-xs text-sage-700 flex items-center gap-3">
              <span className="text-sage-400 shrink-0 w-24 truncate">
                {/* created-at-ok: intelligence_extractions.created_at
                    IS the AI extraction time (per-row action time).
                    JOIN to interactions.timestamp would be more
                    accurate but isn't worth the round-trip for this
                    secondary cell. */}
                {new Date(e.created_at).toLocaleDateString()}
              </span>
              <span className="text-sage-900 font-medium truncate flex-1">
                {e.metadata?.subject || e.metadata?.classification || 'classification'}
              </span>
              {d.urgencyLevel && (
                <span className="text-sage-500 shrink-0">{d.urgencyLevel}</span>
              )}
              {typeof e.metadata?.confidence === 'number' && (
                <span className="text-sage-400 shrink-0 w-10 text-right">{e.metadata.confidence}%</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function ClientProfilePage() {
  const router = useRouter()
  const params = useParams()
  const weddingId = params.id as string
  const VENUE_ID = useVenueId()
  const aiName = useAiName()

  const [wedding, setWedding] = useState<WeddingDetail | null>(null)
  const [people, setPeople] = useState<PersonRow[]>([])
  const [interactions, setInteractions] = useState<InteractionRow[]>([])
  const [events, setEvents] = useState<EngagementEventRow[]>([])
  // T5-Rixey-GGG Bug 25: scoreHistory snapshots are still fetched
  // (HeatHistoryPanel reads them) but the inline sparkline now derives
  // from engagement_events.occurred_at instead — see heatSparkline
  // below. Setter retained so the fetch keeps working.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_scoreHistory, setScoreHistory] = useState<LeadScoreRow[]>([])
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [draftFeedback, setDraftFeedback] = useState<DraftFeedbackRow[]>([])
  const [tours, setTours] = useState<TourRow[]>([])
  const [activityLog, setActivityLog] = useState<ActivityLogRow[]>([])
  const [planningNotes, setPlanningNotes] = useState<PlanningNoteRow[]>([])
  const [extractions, setExtractions] = useState<ExtractionRow[]>([])
  const [clientCode, setClientCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState(false)

  const fetchData = useCallback(async () => {
    const supabase = createClient()

    try {
      const [weddingRes, peopleRes, intRes, eventsRes, scoreRes, draftsRes, codeRes, notesRes, feedbackRes, toursRes, activityRes, extractionsRes] = await Promise.all([
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
          .select('id, event_type, points, metadata, occurred_at, created_at')
          .eq('wedding_id', weddingId)
          .order('occurred_at', { ascending: false })
          .limit(30),
        supabase
          .from('lead_score_history')
          .select('score, temperature_tier, calculated_at')
          .eq('wedding_id', weddingId)
          .order('calculated_at', { ascending: true }),
        supabase
          .from('drafts')
          .select('id, status, subject, body_preview, confidence_score, brain_used, auto_sent, approved_by, approved_at, created_at')
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
        supabase
          .from('draft_feedback')
          .select('id, draft_id, action, rejection_reason, created_at')
          .eq('venue_id', VENUE_ID)
          .in('draft_id', [weddingId]) // Placeholder — we'll filter in JS after fetching drafts
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('tours')
          .select('id, scheduled_at, outcome, notes, created_at')
          .eq('wedding_id', weddingId)
          .eq('venue_id', VENUE_ID)
          .order('scheduled_at', { ascending: false })
          .limit(20),
        supabase
          .from('activity_log')
          .select('id, activity_type, entity_type, details, created_at')
          .eq('venue_id', VENUE_ID)
          .eq('wedding_id', weddingId)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('intelligence_extractions')
          .select('id, extraction_type, confidence, created_at, interaction_id, metadata')
          .eq('venue_id', VENUE_ID)
          .eq('wedding_id', weddingId)
          .order('created_at', { ascending: false })
          .limit(100),
      ])

      if (weddingRes.error) throw weddingRes.error

      const fetchedDrafts = (draftsRes.data ?? []) as DraftRow[]
      setWedding(weddingRes.data as WeddingDetail)
      setPeople((peopleRes.data ?? []) as PersonRow[])
      setInteractions((intRes.data ?? []) as InteractionRow[])
      setEvents((eventsRes.data ?? []) as EngagementEventRow[])
      setScoreHistory((scoreRes.data ?? []) as LeadScoreRow[])
      setDrafts(fetchedDrafts)
      setPlanningNotes((notesRes.data ?? []) as PlanningNoteRow[])
      setClientCode((codeRes.data as { code?: string } | null)?.code ?? null)
      setTours((toursRes.data ?? []) as TourRow[])
      setActivityLog((activityRes.data ?? []) as ActivityLogRow[])
      setExtractions((extractionsRes.data ?? []) as ExtractionRow[])

      // Fetch draft feedback using actual draft IDs
      if (fetchedDrafts.length > 0) {
        const draftIds = fetchedDrafts.map((d) => d.id)
        const { data: feedbackData } = await supabase
          .from('draft_feedback')
          .select('id, draft_id, action, rejection_reason, created_at')
          .in('draft_id', draftIds)
          .order('created_at', { ascending: false })
          .limit(50)
        setDraftFeedback((feedbackData ?? []) as DraftFeedbackRow[])
      } else {
        setDraftFeedback([])
      }
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
    // T5-Rixey-EEE Bug 1 (defense-in-depth): dedupe by name so the
    // headline doesn't render "Sarah & Sarah & Sarah" when one human
    // exists under multiple email aliases (Knot proxy + real Gmail).
    // Root fix lives in people-merge-aliases.ts.
    return dedupePeopleByName(partners).map((p) => p.first_name).join(' & ')
  }, [partners])

  const primaryEmail = useMemo(
    () => partners.find((p) => p.email)?.email ?? null,
    [partners]
  )

  const primaryPhone = useMemo(
    () => partners.find((p) => p.phone)?.phone ?? null,
    [partners]
  )

  // T5-Rixey-GGG Bug 25: derive a real time-series for the heat
  // sparkline from engagement_events.occurred_at (the REAL event
  // time), NOT from lead_score_history.calculated_at. The history
  // table stamps every snapshot at recompute moment, so a fresh-
  // import venue would render a flat line at today's score across
  // months of bars. Bucket events into ISO-week starts and accumulate
  // a cumulative engagement-weight series — the closest legible
  // "heat trajectory" proxy that uses the real event timeline.
  const heatSparkline = useMemo(() => {
    if (events.length === 0) return [] as Array<{ weekStartIso: string; score: number; tier: string }>
    const ordered = [...events]
      .filter((e) => !!e.occurred_at)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    if (ordered.length === 0) return []

    function weekStart(iso: string): string {
      const d = new Date(iso)
      const day = d.getUTCDay()
      const diff = day === 0 ? -6 : 1 - day
      const monday = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff)
      return monday.toISOString().slice(0, 10)
    }

    const buckets = new Map<string, number>()
    for (const e of ordered) {
      const w = weekStart(e.occurred_at)
      buckets.set(w, (buckets.get(w) ?? 0) + (e.points ?? 0))
    }
    const sortedWeeks = [...buckets.keys()].sort()
    let running = 0
    const series: Array<{ weekStartIso: string; score: number; tier: string }> = []
    for (const w of sortedWeeks) {
      running += buckets.get(w) ?? 0
      const clamped = Math.max(0, Math.min(running, 100))
      const tier = clamped >= 80 ? 'hot' : clamped >= 60 ? 'warm' : clamped >= 40 ? 'cool' : 'cold'
      series.push({ weekStartIso: w, score: clamped, tier })
    }
    return series
  }, [events])

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
                  {formatBloomNumber(clientCode, wedding.code_extension)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${status.bg} ${status.text}`}>
                {status.label}
              </span>
              <SourceBadgeEditable
                weddingId={weddingId}
                initialSource={wedding.source}
                onUpdated={(newSource) => {
                  // Local optimistic update so the badge re-renders
                  // immediately even though wedding state is fetched
                  // separately. The next fetchData() call will reconcile.
                  setWedding((prev) => prev ? { ...prev, source: newSource } : prev)
                }}
              />
              <HeatBadge
                tier={wedding.temperature_tier}
                score={wedding.heat_score}
                variant="inline"
              />
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

      {/* Phase C / PC.3: AI-generated journey narrative. Self-hides
          when the wedding has no Phase B candidates so the page
          doesn't show an empty bar. */}
      <JourneyNarrative weddingId={weddingId} />

      {/* T3 lead insights — heat narration, negotiation phase, risk
          flags. Single fetch via /api/insights/lead/[id]; each
          generator's cache fast-paths repeat reads. */}
      <LeadInsightsPanel weddingId={weddingId} />

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
              <p className="text-sm font-semibold text-sage-900">{fmtDateWithPrecision(wedding.wedding_date, wedding.wedding_date_precision)}</p>
            </div>
            {/* T5-schema-gap (migration 165): "Headcount" surface backed by
                weddings.estimated_guests with a fallback to the legacy
                guest_count_estimate column. When neither is captured we
                say so plainly instead of rendering a "--" that looks like
                bad data — the platform shouldn't pretend a guess. */}
            <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-sage-400" />
                <span className="text-xs text-sage-500">Headcount</span>
              </div>
              {(() => {
                const headcount = wedding.estimated_guests ?? wedding.guest_count_estimate
                if (headcount != null) {
                  return (
                    <p className="text-sm font-semibold text-sage-900">{headcount}</p>
                  )
                }
                return (
                  <p
                    className="text-xs italic text-sage-400"
                    title="No guest count captured yet from the inquiry-brain extraction or coordinator entry."
                  >
                    not yet captured
                  </p>
                )
              })()}
            </div>
            <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <DollarSign className="w-4 h-4 text-sage-400" />
                <span className="text-xs text-sage-500">Booking Value</span>
              </div>
              <p className="text-sm font-semibold text-sage-900">
                {/* booking_value is cents per Bloom convention (T5-Rixey-NN bug #8) */}
                {wedding.booking_value ? fmt$(wedding.booking_value / 100) : '--'}
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

          {/* Lead Journey — server-aggregated, multi-source timeline.
              Pulls /api/agent/leads/[id]/journey which merges
              wedding_touchpoints, interactions, drafts, engagement
              signals, status changes, person merges, tangential
              signals, and milestones into one chronological feed. */}
          <WeddingJourney weddingId={weddingId} />

          {/* AI Insights — surfaced classifier output */}
          <AIInsightsPanel extractions={extractions} />

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
                          // T5-Rixey-EEE Bug 2 (display-time
                          // sanitization, layer 2 of 3): historical
                          // rows from MM bulk import + WW re-import
                          // hold raw HTML in body_preview. Always
                          // run htmlToText() — no-op for already-
                          // plain text.
                          <p className="text-xs text-sage-500 line-clamp-2">{htmlToText(int.body_preview)}</p>
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
                      // T5-Rixey-EEE Bug 2: same display-time
                      // sanitization as the inbound side.
                      <p className="text-xs text-sage-500 line-clamp-2 ml-5">{htmlToText(d.body_preview)}</p>
                    )}
                    {/* created-at-ok: drafts.created_at IS the AI
                        generation time (action timestamp). Per the
                        date-windows doctrine drafts is a TELEMETRY
                        table — created_at is the meaningful per-row
                        timestamp. */}
                    <p className="text-[11px] text-sage-400 mt-1 ml-5">{fmtDatetime(d.created_at)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column — Journey + Heat + Events */}
        <div className="space-y-6">
          {/* Phase B: platform-signal candidate evidence. Self-hides when
              no candidates resolve to this wedding so the column doesn't
              get an empty card. */}
          <CandidateSignalEvidence
            weddingId={weddingId}
            legacySource={wedding.source ?? null}
          />

          {/* Connective tissue II / fix #1: Tour insights — cached AI
              brief per tour. Self-hides when no tours exist. */}
          <TourInsightsPanel weddingId={weddingId} />

          {/* Connective tissue II / fix #5: Commitment signals
              checklist. Engagement events were rendering as a flat
              feed; this groups the qualitative cues so coordinator
              sees "X of N signals present" at a glance. Self-hides
              when no commitment signals have fired. */}
          <CommitmentSignalsPanel weddingId={weddingId} />

          {/* Connective tissue II / fix #8: heat history. lead_score_history
              snapshots existed unread until this panel — coordinator
              can now see "why did this lead get hot" via the
              progression of scores + the events that fired between
              snapshots. Self-hides when fewer than 2 snapshots. */}
          <HeatHistoryPanel weddingId={weddingId} />

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
              <HeatBadge
                tier={wedding.temperature_tier}
                score={wedding.heat_score}
                variant="header-icon"
              />
              Heat Score
            </h2>
            <div className="flex items-center gap-3 mb-4">
              <HeatBadge
                tier={wedding.temperature_tier}
                score={wedding.heat_score}
                variant="score-only"
              />
              <div>
                <HeatBadge
                  tier={wedding.temperature_tier}
                  score={wedding.heat_score}
                  variant="tier-pill"
                />
              </div>
            </div>

            {/* Score trend (T5-Rixey-GGG Bug 25): derived from
                engagement_events.occurred_at, NOT from
                lead_score_history.calculated_at. The history table
                stamps every snapshot at the moment of recompute, so a
                fresh-import venue would render a flat line at today's
                score. The sparkline now reflects the actual event
                timeline. */}
            {heatSparkline.length > 1 && (
              <div className="mb-4">
                <p className="text-xs text-sage-500 mb-2">
                  Heat over time
                  <span className="text-sage-400"> · weekly, by event date</span>
                </p>
                <div className="flex items-end gap-1 h-16">
                  {heatSparkline.map((s) => {
                    const max = Math.max(...heatSparkline.map((x) => x.score), 1)
                    const height = (s.score / max) * 100
                    return (
                      <div
                        key={s.weekStartIso}
                        className={cn('flex-1 rounded-sm', styleForTier(s.tier).dotBg)}
                        style={{ height: `${Math.max(height, 4)}%` }}
                        title={`Week of ${fmtDate(s.weekStartIso)}: ${s.score}`}
                      />
                    )
                  })}
                </div>
              </div>
            )}

            {/* Score bar */}
            <div className="h-2 bg-sage-100 rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', styleForTier(wedding.temperature_tier).dotBg)}
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
                      <p className="text-[10px] text-sage-400">{fmtDatetime(e.occurred_at ?? e.created_at)}</p>
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
                Auto-extracted from {aiName} conversations
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
                          {/* created-at-ok: planning_notes.created_at IS
                              the extraction time (per-row action time) —
                              listed as TELEMETRY in the date-windows
                              doctrine. The underlying conversation
                              timestamp would require a JOIN; this cell
                              is fine showing the extraction moment. */}
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
