'use client'

import { useState, useEffect, useCallback } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  Mail,
  RefreshCw,
  Search,
  Inbox,
  ArrowLeft,
  Clock,
  Tag,
  MailOpen,
  Send,
  Plus,
  X,
  Reply,
  Loader2,
  Sparkles,
  CheckCircle,
  XCircle,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Interaction {
  id: string
  venue_id: string
  wedding_id: string | null
  person_id: string | null
  type: string
  direction: 'inbound' | 'outbound'
  subject: string | null
  body_preview: string | null
  full_body: string | null
  gmail_thread_id: string | null
  timestamp: string
  // Joined
  person_name?: string
  person_email?: string
  wedding_status?: string
  classification?: 'inquiry' | 'client' | 'vendor'
  is_read?: boolean
  client_code?: string | null
}

type FilterTab = 'all' | 'inquiries' | 'client' | 'unread'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function formatFullDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function classifyInteraction(
  weddingStatus: string | null,
  direction: string
): 'inquiry' | 'client' | 'vendor' {
  if (!weddingStatus || weddingStatus === 'inquiry') return 'inquiry'
  if (['booked', 'completed'].includes(weddingStatus)) return 'client'
  return 'client'
}

function classificationBadge(cls: 'inquiry' | 'client' | 'vendor') {
  switch (cls) {
    case 'inquiry':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Inquiry' }
    case 'client':
      return { bg: 'bg-sage-50', text: 'text-sage-700', label: 'Client' }
    case 'vendor':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Vendor' }
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function EmailListSkeleton() {
  return (
    <div className="divide-y divide-border">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="p-4">
          <div className="animate-pulse space-y-2">
            <div className="flex items-center justify-between">
              <div className="h-4 w-32 bg-sage-100 rounded" />
              <div className="h-3 w-12 bg-sage-100 rounded" />
            </div>
            <div className="h-4 w-3/4 bg-sage-100 rounded" />
            <div className="h-3 w-full bg-sage-50 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="p-6">
      <div className="animate-pulse space-y-4">
        <div className="h-6 w-2/3 bg-sage-100 rounded" />
        <div className="h-4 w-1/3 bg-sage-100 rounded" />
        <div className="space-y-2 mt-6">
          <div className="h-4 w-full bg-sage-50 rounded" />
          <div className="h-4 w-full bg-sage-50 rounded" />
          <div className="h-4 w-5/6 bg-sage-50 rounded" />
          <div className="h-4 w-3/4 bg-sage-50 rounded" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Email List Item
// ---------------------------------------------------------------------------

function EmailListItem({
  interaction,
  isSelected,
  onClick,
}: {
  interaction: Interaction
  isSelected: boolean
  onClick: () => void
}) {
  const cls = interaction.classification ?? 'inquiry'
  const badge = classificationBadge(cls)
  const isRead = interaction.is_read ?? interaction.direction === 'outbound'

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 transition-colors border-l-2 ${
        isSelected
          ? 'bg-sage-50 border-l-sage-500'
          : 'border-l-transparent hover:bg-sage-50/50'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          {!isRead && (
            <span className="w-2 h-2 rounded-full bg-sage-500 shrink-0" />
          )}
          <span
            className={`text-sm truncate ${
              isRead ? 'text-sage-600' : 'font-semibold text-sage-900'
            }`}
          >
            {interaction.direction === 'inbound'
              ? interaction.person_name || interaction.person_email || 'No sender on record'
              : `To: ${interaction.person_name || interaction.person_email || 'No recipient on record'}`}
          </span>
        </div>
        <span className="text-xs text-sage-400 shrink-0">
          {timeAgo(interaction.timestamp)}
        </span>
      </div>
      <p
        className={`text-sm truncate mb-1 ${
          isRead ? 'text-sage-600' : 'font-medium text-sage-800'
        }`}
      >
        {interaction.subject || '(No subject)'}
      </p>
      <div className="flex items-center gap-2">
        <p className="text-xs text-sage-400 truncate flex-1">
          {interaction.body_preview || 'No preview available'}
        </p>
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${badge.bg} ${badge.text}`}
        >
          {badge.label}
        </span>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Thread View
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compose Modal
// ---------------------------------------------------------------------------

function ComposeModal({
  venueId,
  onClose,
  onSent,
}: {
  venueId: string
  onClose: () => void
  onSent: () => void
}) {
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  const handleSend = async () => {
    if (!to.trim() || !body.trim()) return
    setSending(true)
    try {
      const res = await fetch('/api/agent/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to.trim(), subject: subject.trim(), body: body.trim() }),
      })
      if (!res.ok) throw new Error('Send failed')
      onSent()
      onClose()
    } catch (err) {
      console.error('Failed to send email:', err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface border border-border rounded-xl shadow-xl w-full max-w-xl mx-4">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-heading text-lg font-semibold text-sage-900">New Email</h3>
          <button onClick={onClose} className="text-sage-400 hover:text-sage-600 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <input
            type="email"
            placeholder="To"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 bg-warm-white"
          />
          <input
            type="text"
            placeholder="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 bg-warm-white"
          />
          <textarea
            placeholder="Write your message..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            className="w-full px-3 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 bg-warm-white resize-y"
          />
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || !to.trim() || !body.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reply Form
// ---------------------------------------------------------------------------

function ReplyForm({
  interactionId,
  personEmail,
  onSent,
}: {
  interactionId: string
  personEmail: string | undefined
  onSent: () => void
}) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const handleSend = async () => {
    if (!body.trim()) return
    setSending(true)
    try {
      const res = await fetch('/api/agent/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interactionId, body: body.trim() }),
      })
      if (!res.ok) throw new Error('Reply failed')
      setBody('')
      setExpanded(false)
      onSent()
    } catch (err) {
      console.error('Failed to send reply:', err)
    } finally {
      setSending(false)
    }
  }

  if (!expanded) {
    return (
      <div className="p-4 border-t border-border">
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700 transition-colors"
        >
          <Reply className="w-4 h-4" />
          Reply{personEmail ? ` to ${personEmail}` : ''}
        </button>
      </div>
    )
  }

  return (
    <div className="p-4 border-t border-border space-y-3">
      <div className="flex items-center gap-2 text-sm text-sage-600">
        <Reply className="w-4 h-4" />
        <span>Replying{personEmail ? ` to ${personEmail}` : ''}</span>
      </div>
      <textarea
        autoFocus
        placeholder="Write your reply..."
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        className="w-full px-3 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 bg-warm-white resize-y"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => { setExpanded(false); setBody('') }}
          className="px-3 py-1.5 text-sm text-sage-500 hover:text-sage-700 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSend}
          disabled={sending || !body.trim()}
          className="flex items-center gap-2 px-4 py-1.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {sending ? 'Sending...' : 'Send Reply'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Draft Approval Card (inline in thread)
// ---------------------------------------------------------------------------

function DraftApprovalCard({
  draft,
  onApprove,
  onReject,
}: {
  draft: { id: string; draft_body: string; subject: string }
  onApprove: (draftId: string) => Promise<void>
  onReject: (draftId: string) => Promise<void>
}) {
  const [processing, setProcessing] = useState(false)
  const [action, setAction] = useState<'approve' | 'reject' | null>(null)

  const handleApprove = async () => {
    setProcessing(true)
    setAction('approve')
    try {
      await onApprove(draft.id)
    } finally {
      setProcessing(false)
      setAction(null)
    }
  }

  const handleReject = async () => {
    setProcessing(true)
    setAction('reject')
    try {
      await onReject(draft.id)
    } finally {
      setProcessing(false)
      setAction(null)
    }
  }

  return (
    <div className="rounded-xl p-4 bg-amber-50 border-2 border-amber-300 ml-8">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-amber-600" />
        <span className="text-sm font-semibold text-amber-800">
          AI Draft — Pending Your Approval
        </span>
      </div>
      <div className="text-sm text-amber-800 whitespace-pre-wrap leading-relaxed mb-4 bg-white/60 rounded-lg p-3 border border-amber-200">
        {draft.draft_body}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleApprove}
          disabled={processing}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {action === 'approve' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <CheckCircle className="w-4 h-4" />
          )}
          Approve & Send
        </button>
        <button
          onClick={handleReject}
          disabled={processing}
          className="flex items-center gap-2 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 text-sm font-medium rounded-lg border border-red-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {action === 'reject' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <XCircle className="w-4 h-4" />
          )}
          Reject
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Thread View
// ---------------------------------------------------------------------------

function ThreadView({
  interaction,
  threadMessages,
  draft,
  onBack,
  onReply,
  onApproveDraft,
  onRejectDraft,
}: {
  interaction: Interaction
  threadMessages: Interaction[]
  draft: { id: string; draft_body: string; subject: string } | null
  onBack: () => void
  onReply: () => void
  onApproveDraft: (draftId: string) => Promise<void>
  onRejectDraft: (draftId: string) => Promise<void>
}) {
  return (
    <div className="flex flex-col h-full">
      {/* Thread header */}
      <div className="p-4 border-b border-border">
        <button
          onClick={onBack}
          className="lg:hidden flex items-center gap-1 text-sm text-sage-500 hover:text-sage-700 mb-2 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            {interaction.subject || '(No subject)'}
          </h2>
          {interaction.client_code && (
            <span className="inline-flex items-center px-2 py-0.5 rounded bg-sage-50 border border-sage-200 text-xs font-mono font-semibold text-sage-600">
              {interaction.client_code}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 text-sm text-sage-500">
          <span className="flex items-center gap-1">
            <Mail className="w-3.5 h-3.5" />
            {interaction.person_name || interaction.person_email || 'No contact on record'}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            {formatFullDate(interaction.timestamp)}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {threadMessages.map((msg) => (
          <div
            key={msg.id}
            className={`rounded-xl p-4 ${
              msg.direction === 'inbound'
                ? 'bg-warm-white border border-border'
                : 'bg-sage-50 border border-sage-200 ml-8'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-sage-800">
                {msg.direction === 'inbound'
                  ? msg.person_name || msg.person_email || 'Contact'
                  : 'You'}
              </span>
              <span className="text-xs text-sage-400">
                {formatFullDate(msg.timestamp)}
              </span>
            </div>
            <div className="text-sm text-sage-700 whitespace-pre-wrap leading-relaxed">
              {msg.full_body || msg.body_preview || '(No content)'}
            </div>
          </div>
        ))}

        {/* Draft reply if exists — with approve/reject controls */}
        {draft && (
          <DraftApprovalCard
            draft={draft}
            onApprove={onApproveDraft}
            onReject={onRejectDraft}
          />
        )}
      </div>

      {/* Reply form */}
      <ReplyForm
        interactionId={interaction.id}
        personEmail={interaction.person_email}
        onSent={onReply}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function InboxPage() {
  const VENUE_ID = useVenueId()
  const [interactions, setInteractions] = useState<Interaction[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<FilterTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [threadMessages, setThreadMessages] = useState<Interaction[]>([])
  const [threadDraft, setThreadDraft] = useState<{
    id: string
    draft_body: string
    subject: string
  } | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [showCompose, setShowCompose] = useState(false)
  const [pendingDraftCount, setPendingDraftCount] = useState(0)

  const supabase = createClient()

  // ---- Fetch pending draft count ----
  useEffect(() => {
    supabase
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', VENUE_ID)
      .eq('status', 'pending')
      .then(({ count }) => setPendingDraftCount(count ?? 0))
  }, [threadDraft])

  // ---- Fetch interactions ----
  const fetchInteractions = useCallback(async () => {
    try {
      const { data: interactionsData, error: fetchError } = await supabase
        .from('interactions')
        .select(`
          id,
          venue_id,
          wedding_id,
          person_id,
          type,
          direction,
          subject,
          body_preview,
          gmail_thread_id,
          timestamp,
          people!interactions_person_id_fkey ( first_name, last_name, email ),
          weddings!interactions_wedding_id_fkey (
            status,
            people ( first_name, last_name, email, role ),
            client_codes ( code )
          )
        `)
        .eq('venue_id', VENUE_ID)
        .eq('type', 'email')
        .order('timestamp', { ascending: false })
        .limit(200)

      if (fetchError) throw fetchError

      const mapped: Interaction[] = (interactionsData ?? []).map((row: any) => {
        const person = row.people
        const wedding = row.weddings
        // Fall back to the wedding's partner1 when the interaction isn't linked
        // to a specific person_id yet (common for demo/inquiry data).
        const weddingPeople: Array<{ first_name?: string; last_name?: string; email?: string; role?: string }> =
          Array.isArray(wedding?.people) ? wedding.people : []
        const partner1 = weddingPeople.find((p) => p.role === 'partner1') ?? weddingPeople[0]
        const partner2 = weddingPeople.find((p) => p.role === 'partner2')
        const coupleDisplay = partner1
          ? partner2 && partner2.last_name === partner1.last_name
            ? `${partner1.first_name} & ${partner2.first_name} ${partner1.last_name}`
            : partner2
              ? `${partner1.first_name} ${partner1.last_name} & ${partner2.first_name} ${partner2.last_name}`
              : [partner1.first_name, partner1.last_name].filter(Boolean).join(' ')
          : null
        const personName = person
          ? [person.first_name, person.last_name].filter(Boolean).join(' ')
          : coupleDisplay
        const personEmail = person?.email || partner1?.email || null
        const weddingStatus = wedding?.status ?? null
        const weddingCodes: Array<{ code?: string }> = Array.isArray(wedding?.client_codes)
          ? wedding.client_codes
          : []
        const clientCode = weddingCodes.length > 0 ? weddingCodes[0]?.code ?? null : null

        return {
          id: row.id,
          venue_id: row.venue_id,
          wedding_id: row.wedding_id,
          person_id: row.person_id,
          type: row.type,
          direction: row.direction,
          subject: row.subject,
          body_preview: row.body_preview,
          full_body: null,
          gmail_thread_id: row.gmail_thread_id,
          timestamp: row.timestamp,
          person_name: personName || undefined,
          person_email: personEmail || undefined,
          wedding_status: weddingStatus,
          classification: classifyInteraction(weddingStatus, row.direction),
          is_read: row.direction === 'outbound',
          client_code: clientCode,
        }
      })

      setInteractions(mapped)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch interactions:', err)
      setError('Failed to load emails')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchInteractions()
  }, [fetchInteractions])

  // ---- Load thread when selecting an email ----
  const loadThread = useCallback(
    async (interaction: Interaction) => {
      setSelectedId(interaction.id)
      setThreadLoading(true)
      setThreadDraft(null)

      try {
        // Fetch all messages in this thread
        let query = supabase
          .from('interactions')
          .select(`
            id,
            venue_id,
            wedding_id,
            person_id,
            type,
            direction,
            subject,
            body_preview,
            full_body,
            gmail_thread_id,
            timestamp,
            people!interactions_person_id_fkey ( first_name, last_name, email ),
            weddings!interactions_wedding_id_fkey (
              people ( first_name, last_name, email, role )
            )
          `)
          .eq('venue_id', VENUE_ID)
          .order('timestamp', { ascending: true })

        if (interaction.gmail_thread_id) {
          query = query.eq('gmail_thread_id', interaction.gmail_thread_id)
        } else {
          query = query.eq('id', interaction.id)
        }

        const { data: threadData } = await query

        const mapped: Interaction[] = (threadData ?? []).map((row: any) => {
          const person = row.people
          const wedding = row.weddings
          const weddingPeople: Array<{ first_name?: string; last_name?: string; email?: string; role?: string }> =
            Array.isArray(wedding?.people) ? wedding.people : []
          const partner1 = weddingPeople.find((p) => p.role === 'partner1') ?? weddingPeople[0]
          const partner2 = weddingPeople.find((p) => p.role === 'partner2')
          const coupleDisplay = partner1
            ? partner2 && partner2.last_name === partner1.last_name
              ? `${partner1.first_name} & ${partner2.first_name} ${partner1.last_name}`
              : partner2
                ? `${partner1.first_name} ${partner1.last_name} & ${partner2.first_name} ${partner2.last_name}`
                : [partner1.first_name, partner1.last_name].filter(Boolean).join(' ')
            : null
          const personName = person
            ? [person.first_name, person.last_name].filter(Boolean).join(' ')
            : coupleDisplay
          return {
            ...row,
            person_name: personName || undefined,
            person_email: person?.email || partner1?.email || undefined,
          }
        })

        setThreadMessages(mapped.length > 0 ? mapped : [interaction])

        // Check for a pending draft
        const { data: draftData } = await supabase
          .from('drafts')
          .select('id, draft_body, subject')
          .eq('venue_id', VENUE_ID)
          .eq('interaction_id', interaction.id)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (draftData) {
          setThreadDraft(draftData)
        }
      } catch (err) {
        console.error('Failed to load thread:', err)
      } finally {
        setThreadLoading(false)
      }
    },
    []
  )

  // ---- Sync emails ----
  const handleSync = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/agent/sync', { method: 'POST' })
      if (!res.ok) throw new Error('Sync failed')
      await fetchInteractions()
    } catch (err) {
      console.error('Failed to sync emails:', err)
      setError('Email sync failed. Check Gmail connection.')
    } finally {
      setSyncing(false)
    }
  }

  // ---- Filtering ----
  const filteredInteractions = interactions.filter((i) => {
    // Tab filter
    if (activeTab === 'inquiries' && i.classification !== 'inquiry') return false
    if (activeTab === 'client' && i.classification !== 'client') return false
    if (activeTab === 'unread' && i.is_read) return false

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      return (
        (i.subject?.toLowerCase().includes(q) ?? false) ||
        (i.person_name?.toLowerCase().includes(q) ?? false) ||
        (i.person_email?.toLowerCase().includes(q) ?? false) ||
        (i.body_preview?.toLowerCase().includes(q) ?? false)
      )
    }
    return true
  })

  // ---- Stats ----
  const totalCount = interactions.length
  const unreadCount = interactions.filter((i) => !i.is_read).length

  const selectedInteraction = interactions.find((i) => i.id === selectedId) ?? null

  const tabs: { key: FilterTab; label: string; count?: number }[] = [
    { key: 'all', label: 'All' },
    {
      key: 'inquiries',
      label: 'Inquiries',
      count: interactions.filter((i) => i.classification === 'inquiry').length,
    },
    {
      key: 'client',
      label: 'Client',
      count: interactions.filter((i) => i.classification === 'client').length,
    },
    { key: 'unread', label: 'Unread', count: unreadCount },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Inbox
            {pendingDraftCount > 0 && (
              <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium bg-amber-100 text-amber-700">
                {pendingDraftCount} pending approval
              </span>
            )}
          </h1>
          <p className="text-sage-600">
            Your unified email inbox — every inquiry, client reply, and vendor message in one place. Click any email to view the full thread, and approve or reject AI-drafted replies directly from here.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowCompose(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            Compose
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2.5 text-sage-700 border border-sage-300 text-sm font-medium rounded-lg hover:bg-sage-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
        </div>
      </div>

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Mail className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => {
              setError(null)
              setLoading(true)
              fetchInteractions()
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Filters + Search ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                activeTab === tab.key
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full ${
                    activeTab === tab.key
                      ? 'bg-sage-100 text-sage-700'
                      : 'bg-sage-100/50 text-sage-500'
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search emails..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
          />
        </div>
      </div>

      {/* ---- Main content: list + detail ---- */}
      <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="grid grid-cols-1 lg:grid-cols-5">
            <div className="lg:col-span-2 border-r border-border">
              <EmailListSkeleton />
            </div>
            <div className="lg:col-span-3 hidden lg:block">
              <DetailSkeleton />
            </div>
          </div>
        ) : filteredInteractions.length === 0 ? (
          <div className="p-12 text-center">
            <Inbox className="w-12 h-12 text-sage-300 mx-auto mb-4" />
            <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
              {searchQuery
                ? 'No matching emails'
                : activeTab !== 'all'
                  ? `No ${activeTab} emails`
                  : 'Inbox is empty'}
            </h3>
            <p className="text-sm text-sage-600 max-w-md mx-auto">
              {searchQuery
                ? `No emails match "${searchQuery}". Try a different search term.`
                : 'Click "Sync Emails" to pull in the latest from Gmail.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-5 min-h-[600px]">
            {/* Left panel: email list */}
            <div
              className={`lg:col-span-2 border-r border-border overflow-y-auto max-h-[700px] divide-y divide-border ${
                selectedId ? 'hidden lg:block' : ''
              }`}
            >
              {filteredInteractions.map((interaction) => (
                <EmailListItem
                  key={interaction.id}
                  interaction={interaction}
                  isSelected={interaction.id === selectedId}
                  onClick={() => loadThread(interaction)}
                />
              ))}
            </div>

            {/* Right panel: detail / thread */}
            <div
              className={`lg:col-span-3 overflow-y-auto max-h-[700px] ${
                selectedId ? '' : 'hidden lg:flex'
              }`}
            >
              {selectedInteraction ? (
                threadLoading ? (
                  <DetailSkeleton />
                ) : (
                  <ThreadView
                    interaction={selectedInteraction}
                    threadMessages={threadMessages}
                    draft={threadDraft}
                    onBack={() => setSelectedId(null)}
                    onReply={() => {
                      if (selectedInteraction) loadThread(selectedInteraction)
                    }}
                    onApproveDraft={async (draftId: string) => {
                      await supabase
                        .from('drafts')
                        .update({ status: 'approved', approved_at: new Date().toISOString() })
                        .eq('id', draftId)
                      await supabase.from('draft_feedback').insert({
                        venue_id: VENUE_ID,
                        draft_id: draftId,
                        action: 'approved',
                      })
                      try {
                        await fetch('/api/agent/drafts', {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ draftId }),
                        })
                      } catch { /* email send is best-effort */ }
                      setThreadDraft(null)
                    }}
                    onRejectDraft={async (draftId: string) => {
                      await supabase
                        .from('drafts')
                        .update({ status: 'rejected' })
                        .eq('id', draftId)
                      await supabase.from('draft_feedback').insert({
                        venue_id: VENUE_ID,
                        draft_id: draftId,
                        action: 'rejected',
                      })
                      setThreadDraft(null)
                    }}
                  />
                )
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
                  <MailOpen className="w-12 h-12 text-sage-200 mb-4" />
                  <p className="text-sm text-sage-400">
                    Select an email to view the conversation
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Compose modal */}
      {showCompose && (
        <ComposeModal
          venueId={VENUE_ID}
          onClose={() => setShowCompose(false)}
          onSent={fetchInteractions}
        />
      )}
    </div>
  )
}
