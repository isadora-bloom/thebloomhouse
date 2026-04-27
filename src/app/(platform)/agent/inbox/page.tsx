'use client'

import { useState, useEffect, useCallback } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import { VenueChip } from '@/components/intel/venue-chip'
import { InlineInsightBanner } from '@/components/intel/inline-insight-banner'
import { PriorTouchesChip } from '@/components/agent/PriorTouchesChip'
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
  FileSignature,
  AlertTriangle,
  PenLine,
  Trash2,
  Save,
  Brain,
  Pencil,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// HTML → plain text for previews and collapsed body view
//
// Outbound drafts (Sage replies) are stored as HTML in interactions.full_body
// and the first 300 chars get sliced into body_preview — which renders
// literally as `<div>Hi Sarah!<br>...` in the inbox list. We strip tags +
// decode a handful of common entities here so the text surface stays clean.
// Full HTML rendering is intentionally NOT used (XSS surface on inbound
// forwarded email is not worth it for a preview).
// ---------------------------------------------------------------------------

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

function stripHtml(input: string | null | undefined): string {
  if (!input) return ''
  return input
    // Convert block/line breaks to newlines before stripping tags so
    // "Hi there<br>How are you" doesn't collapse to "Hi thereHow are you".
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => HTML_ENTITY_MAP[m.toLowerCase()] ?? m)
    // Collapse runs of whitespace but preserve single newlines.
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

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
  from_email?: string | null
  from_name?: string | null
  to_email?: string | null
  gmail_thread_id: string | null
  timestamp: string
  // Joined
  person_name?: string
  person_email?: string
  wedding_status?: string
  classification?: 'inquiry' | 'client' | 'vendor'
  is_read?: boolean
  client_code?: string | null
  venue_name?: string | null
  pending_draft?: PendingDraft | null
}

interface PendingDraft {
  id: string
  draft_body: string
  subject: string | null
  to_email: string | null
  brain_used: string | null
  confidence_score: number | null
  auto_sent: boolean
  created_at: string
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
  showVenueChip,
}: {
  interaction: Interaction
  isSelected: boolean
  onClick: () => void
  showVenueChip: boolean
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
          {stripHtml(interaction.body_preview) || 'No preview available'}
        </p>
        {showVenueChip && <VenueChip venueName={interaction.venue_name} />}
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${badge.bg} ${badge.text}`}
        >
          {badge.label}
        </span>
      </div>
      {/* Phase 8 multi-touch history: hides itself if the person has no
          prior touchpoints. On inquiry rows this surfaces "3 prior
          touchpoints" (hot) or "1 prior touchpoint" (warm) with an
          expandable list of each touch. */}
      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
        <PriorTouchesChip personId={interaction.person_id} />
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
  venueId,
  personEmail,
  onSent,
  threadLock,
  currentUserName: userName,
}: {
  interactionId: string
  venueId: string
  personEmail: string | undefined
  onSent: () => void
  threadLock: { locked: boolean; lockedBy: string; lockedAt: string } | null
  currentUserName: string
}) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Acquire thread lock when composer expands
  const acquireLock = useCallback(async () => {
    try {
      await fetch('/api/agent/thread-lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId,
          interactionId,
          lockedBy: userName,
        }),
      })
    } catch {
      // Lock acquisition is best-effort
    }
  }, [venueId, interactionId, userName])

  // Release thread lock when composer closes
  const releaseLock = useCallback(async () => {
    try {
      await fetch('/api/agent/thread-lock', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId,
          interactionId,
          lockedBy: userName,
        }),
      })
    } catch {
      // Lock release is best-effort
    }
  }, [venueId, interactionId, userName])

  const handleExpand = () => {
    setExpanded(true)
    acquireLock()
  }

  const handleCollapse = () => {
    setExpanded(false)
    setBody('')
    releaseLock()
  }

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
      releaseLock()
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
        {/* Thread lock warning */}
        {threadLock?.locked && (
          <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
            <PenLine className="w-4 h-4 text-amber-600 shrink-0" />
            <span className="text-sm text-amber-800">
              <strong>{threadLock.lockedBy}</strong> is currently drafting a reply to this thread
            </span>
          </div>
        )}
        <button
          onClick={handleExpand}
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
      {/* Thread lock warning when composing */}
      {threadLock?.locked && (
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <span className="text-sm text-amber-800">
            <strong>{threadLock.lockedBy}</strong> is also drafting a reply. Sending may cause a conflicting response.
          </span>
        </div>
      )}
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
          onClick={handleCollapse}
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
  onSave,
  onSaveAndSend,
  onDelete,
}: {
  draft: { id: string; draft_body: string; subject: string }
  onSave: (draftId: string, body: string) => Promise<void>
  onSaveAndSend: (draftId: string, body: string) => Promise<void>
  onDelete: (draftId: string) => Promise<void>
}) {
  // Local copy so edits are free-form and only committed on Save / Save & Send.
  const [body, setBody] = useState(draft.draft_body)
  const [processing, setProcessing] = useState(false)
  const [action, setAction] = useState<'save' | 'send' | 'delete' | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const dirty = body !== draft.draft_body

  const runAction = async (
    kind: 'save' | 'send' | 'delete',
    fn: () => Promise<void>
  ) => {
    setProcessing(true)
    setAction(kind)
    try {
      await fn()
      if (kind === 'save') setSavedAt(Date.now())
    } finally {
      setProcessing(false)
      setAction(null)
    }
  }

  return (
    <div className="rounded-xl p-4 bg-amber-50 border-2 border-amber-300 ml-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-600" />
          <span className="text-sm font-semibold text-amber-800">
            AI Draft — Edit, save, or send
          </span>
        </div>
        {dirty && !savedAt && (
          <span className="text-xs text-amber-700">Unsaved changes</span>
        )}
        {savedAt && !dirty && (
          <span className="text-xs text-emerald-700">Saved</span>
        )}
      </div>
      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          if (savedAt) setSavedAt(null)
        }}
        rows={Math.max(6, Math.min(20, body.split('\n').length + 1))}
        className="w-full text-sm text-amber-900 leading-relaxed mb-4 bg-white rounded-lg p-3 border border-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-400 font-sans"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => runAction('save', () => onSave(draft.id, body))}
          disabled={processing || !dirty}
          title="Save edits without sending. Comes back later for review."
          className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-amber-100 text-amber-800 text-sm font-medium rounded-lg border border-amber-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {action === 'save' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Save
        </button>
        <button
          onClick={() => runAction('send', () => onSaveAndSend(draft.id, body))}
          disabled={processing}
          title="Save current edits and send the reply right now."
          className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {action === 'send' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
          Save & Send
        </button>
        <button
          onClick={() => {
            if (!window.confirm('Delete this draft? This cannot be undone.')) return
            runAction('delete', () => onDelete(draft.id))
          }}
          disabled={processing}
          title="Remove this draft entirely."
          className="flex items-center gap-2 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 text-sm font-medium rounded-lg border border-red-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
        >
          {action === 'delete' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
          Delete
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Thread View
// ---------------------------------------------------------------------------

function ContractSigningPrompt({
  coupleName,
  onConfirm,
  onDismiss,
}: {
  coupleName: string
  onConfirm: () => Promise<void>
  onDismiss: () => Promise<void>
}) {
  const [processing, setProcessing] = useState(false)

  const handleConfirm = async () => {
    setProcessing(true)
    try {
      await onConfirm()
    } finally {
      setProcessing(false)
    }
  }

  const handleDismiss = async () => {
    setProcessing(true)
    try {
      await onDismiss()
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center justify-between gap-3 mx-4 mt-4">
      <div className="flex items-center gap-2 text-sm text-amber-900">
        <FileSignature className="w-4 h-4 text-amber-600 shrink-0" />
        <span>
          Possible contract signing detected — move <strong>{coupleName}</strong> to
          Contracted stage?
        </span>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={handleConfirm}
          disabled={processing}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {processing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <CheckCircle className="w-3.5 h-3.5" />
          )}
          Yes, move
        </button>
        <button
          onClick={handleDismiss}
          disabled={processing}
          className="px-3 py-1.5 text-amber-800 hover:bg-amber-100 text-xs font-medium rounded-lg border border-amber-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Not yet
        </button>
      </div>
    </div>
  )
}

function ThreadView({
  interaction,
  threadMessages,
  draft,
  signingPrompt,
  threadLock,
  currentUserName: userName,
  onBack,
  onReply,
  onSaveDraft,
  onSaveAndSendDraft,
  onDeleteDraft,
  onConfirmSigning,
  onDismissSigning,
}: {
  interaction: Interaction
  threadMessages: Interaction[]
  draft: { id: string; draft_body: string; subject: string } | null
  signingPrompt: { notificationId: string | null; coupleName: string } | null
  threadLock: { locked: boolean; lockedBy: string; lockedAt: string } | null
  currentUserName: string
  onBack: () => void
  onReply: () => void
  onSaveDraft: (draftId: string, body: string) => Promise<void>
  onSaveAndSendDraft: (draftId: string, body: string) => Promise<void>
  onDeleteDraft: (draftId: string) => Promise<void>
  onConfirmSigning: () => Promise<void>
  onDismissSigning: () => Promise<void>
}) {
  return (
    <div className="flex flex-col h-full">
      {/* Thread lock warning banner */}
      {threadLock?.locked && (
        <div className="mx-4 mt-4 flex items-center gap-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg">
          <PenLine className="w-4 h-4 text-amber-600 shrink-0" />
          <span className="text-sm text-amber-800">
            <strong>{threadLock.lockedBy}</strong> is currently drafting a reply to this thread
          </span>
        </div>
      )}
      {/* Contract signing prompt banner */}
      {signingPrompt && (
        <ContractSigningPrompt
          coupleName={signingPrompt.coupleName}
          onConfirm={onConfirmSigning}
          onDismiss={onDismissSigning}
        />
      )}
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
              {stripHtml(msg.full_body) || stripHtml(msg.body_preview) || '(No content)'}
            </div>
          </div>
        ))}

        {/* Draft reply if exists — with approve/reject controls */}
        {draft && (
          <DraftApprovalCard
            draft={draft}
            onSave={onSaveDraft}
            onSaveAndSend={onSaveAndSendDraft}
            onDelete={onDeleteDraft}
          />
        )}
      </div>

      {/* Reply form */}
      <ReplyForm
        interactionId={interaction.id}
        venueId={interaction.venue_id}
        personEmail={interaction.person_email}
        onSent={onReply}
        threadLock={threadLock}
        currentUserName={userName}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline draft approval (rendered under matching email in the list)
// ---------------------------------------------------------------------------

function confidenceMeta(score: number | null) {
  if (score === null) return { bg: 'bg-sage-50', text: 'text-sage-600', label: '?' }
  if (score >= 90) return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: `${score}%` }
  if (score >= 75) return { bg: 'bg-amber-50', text: 'text-amber-700', label: `${score}%` }
  return { bg: 'bg-red-50', text: 'text-red-700', label: `${score}%` }
}

function brainMeta(brain: string | null) {
  switch (brain) {
    case 'inquiry_brain':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Inquiry Brain' }
    case 'client_brain':
      return { bg: 'bg-sage-50', text: 'text-sage-700', label: 'Client Brain' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: brain || 'Unknown' }
  }
}

function InlineDraftApproval({
  draft,
  isProcessing,
  onApprove,
  onApproveAndSend,
  onEdit,
  onReject,
}: {
  draft: PendingDraft
  isProcessing: boolean
  onApprove: () => void
  onApproveAndSend: () => void
  onEdit: () => void
  onReject: () => void
}) {
  const conf = confidenceMeta(draft.confidence_score)
  const brain = brainMeta(draft.brain_used)
  const [expanded, setExpanded] = useState(false)
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <div className="px-4 pb-4 pt-1 bg-amber-50/40 border-l-2 border-l-amber-400">
      <div className="rounded-lg border border-amber-200 bg-white p-3">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <Sparkles className="w-3.5 h-3.5 text-amber-600 shrink-0" />
          <span className="text-xs font-semibold text-amber-800">AI draft ready</span>
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${conf.bg} ${conf.text}`}
          >
            <Sparkles className="w-2.5 h-2.5" />
            {conf.label}
          </span>
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${brain.bg} ${brain.text}`}
          >
            <Brain className="w-2.5 h-2.5" />
            {brain.label}
          </span>
          {draft.auto_sent && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700">
              <Send className="w-2.5 h-2.5" />
              Auto-sent
            </span>
          )}
        </div>
        <p
          className={`text-xs text-sage-700 whitespace-pre-wrap leading-relaxed mb-2 ${
            expanded ? '' : 'line-clamp-4'
          }`}
        >
          {draft.draft_body}
        </p>
        {draft.draft_body && draft.draft_body.length > 200 && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(!expanded)
            }}
            className="text-[11px] font-medium text-sage-600 hover:text-sage-900 underline-offset-2 hover:underline mb-2 block"
          >
            {expanded ? 'Show less' : 'Show full draft'}
          </button>
        )}
        <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-amber-100">
          <button
            onClick={stop(onApprove)}
            disabled={isProcessing}
            title="Mark approved. Won't send until you click Send from the Approved tab."
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
            Approve
          </button>
          <button
            onClick={stop(onEdit)}
            disabled={isProcessing}
            title="Edit the draft, then mark approved (no send)."
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-sage-700 border border-sage-300 rounded-md hover:bg-sage-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Pencil className="w-3.5 h-3.5" />
            Edit & Approve
          </button>
          <button
            onClick={stop(onApproveAndSend)}
            disabled={isProcessing}
            title="Approve and send immediately."
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-emerald-500 hover:bg-emerald-600 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-3.5 h-3.5" />
            Approve & Send
          </button>
          <button
            onClick={stop(onReject)}
            disabled={isProcessing}
            title="Reject with feedback for AI learning."
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-md hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
          >
            <XCircle className="w-3.5 h-3.5" />
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}

function EditDraftModal({
  draft,
  onClose,
  onSave,
}: {
  draft: PendingDraft
  onClose: () => void
  onSave: (id: string, body: string) => Promise<void>
}) {
  const [body, setBody] = useState(draft.draft_body)
  const [saving, setSaving] = useState(false)
  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(draft.id, body)
      onClose()
    } catch {
      // error handled in parent
    } finally {
      setSaving(false)
    }
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-surface rounded-2xl shadow-2xl w-full max-w-2xl border border-border">
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div className="flex items-center gap-2">
            <Pencil className="w-5 h-5 text-sage-600" />
            <h2 className="font-heading text-lg font-semibold text-sage-900">Edit Draft</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 pb-6 space-y-4">
          <div className="text-sm text-sage-600">
            <span className="font-medium text-sage-800">To:</span>{' '}
            {draft.to_email || 'Unknown'}
            {draft.subject && (
              <>
                <br />
                <span className="font-medium text-sage-800">Subject:</span> {draft.subject}
              </>
            )}
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className="w-full px-3 py-2.5 border border-sage-200 rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none bg-warm-white leading-relaxed"
          />
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-700 border border-sage-300 rounded-lg hover:bg-sage-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!body.trim() || saving}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save & Approve'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RejectDraftModal({
  onClose,
  onReject,
}: {
  onClose: () => void
  onReject: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const handleReject = async () => {
    setRejecting(true)
    try {
      await onReject(reason.trim())
      onClose()
    } catch {
      // error handled in parent
    } finally {
      setRejecting(false)
    }
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-border">
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div className="flex items-center gap-2">
            <XCircle className="w-5 h-5 text-red-500" />
            <h2 className="font-heading text-lg font-semibold text-sage-900">Reject Draft</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 pb-6 space-y-4">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why are you rejecting this draft? (optional but helps AI learn)"
            rows={3}
            className="w-full px-3 py-2.5 border border-sage-200 rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none bg-warm-white"
          />
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-700 border border-sage-300 rounded-lg hover:bg-sage-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleReject}
              disabled={rejecting}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <XCircle className="w-4 h-4" />
              {rejecting ? 'Rejecting...' : 'Reject'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function InboxPage() {
  const scope = useScope()
  const showVenueChip = scope.level !== 'venue'
  // For compose modal and mutations that need a concrete venue
  const composeVenueId = scope.venueId ?? ''
  const [interactions, setInteractions] = useState<Interaction[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
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
  const [signingPrompt, setSigningPrompt] = useState<{
    notificationId: string | null
    coupleName: string
    weddingId: string
  } | null>(null)
  const [threadLock, setThreadLock] = useState<{
    locked: boolean
    lockedBy: string
    lockedAt: string
  } | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [showCompose, setShowCompose] = useState(false)
  const [pendingDraftCount, setPendingDraftCount] = useState(0)
  const [editingDraft, setEditingDraft] = useState<{ draft: PendingDraft; venueId: string } | null>(null)
  const [rejectingDraft, setRejectingDraft] = useState<{ draftId: string; venueId: string } | null>(null)
  const [processingDraftId, setProcessingDraftId] = useState<string | null>(null)
  // Current user name for thread locking — in real mode this would come from auth
  const currentUserName = 'You'

  const supabase = createClient()

  // ---- Resolve venue IDs from scope ----
  const resolveVenueIds = useCallback(async (): Promise<string[] | null> => {
    if (scope.level === 'venue' && scope.venueId) {
      return [scope.venueId]
    }
    if (scope.level === 'group' && scope.groupId) {
      const { data: members } = await supabase
        .from('venue_group_members')
        .select('venue_id')
        .eq('group_id', scope.groupId)
      return (members ?? []).map((r) => r.venue_id as string)
    }
    if (scope.orgId) {
      // company scope — filter to user's org's venues only (prevents cross-org leak)
      const { data: orgVenues } = await supabase
        .from('venues')
        .select('id')
        .eq('org_id', scope.orgId)
      return (orgVenues ?? []).map((v) => v.id as string)
    }
    return null
  }, [scope.level, scope.venueId, scope.groupId, scope.orgId, supabase])

  // ---- Fetch pending draft count ----
  useEffect(() => {
    if (scope.loading) return
    ;(async () => {
      const venueIds = await resolveVenueIds()
      let q = supabase
        .from('drafts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
      if (venueIds && venueIds.length > 0) {
        q = q.in('venue_id', venueIds)
      }
      const { count } = await q
      setPendingDraftCount(count ?? 0)
    })()
  }, [threadDraft, scope.loading, scope.level, scope.venueId, scope.groupId, resolveVenueIds, supabase])

  // ---- Fetch interactions ----
  const fetchInteractions = useCallback(async () => {
    if (scope.loading) return
    try {
      const venueIds = await resolveVenueIds()
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
          from_email,
          from_name,
          to_email,
          gmail_thread_id,
          timestamp,
          venues:venue_id ( name ),
          people!interactions_person_id_fkey ( first_name, last_name, email ),
          weddings!interactions_wedding_id_fkey (
            status,
            people ( first_name, last_name, email, role ),
            client_codes ( code )
          )
        `)
        .eq('type', 'email')
      if (venueIds && venueIds.length > 0) {
        query = query.in('venue_id', venueIds)
      }
      const { data: interactionsData, error: fetchError } = await query
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
        // Prefer the joined people row, then the couple on the wedding,
        // then the raw from_email/from_name captured by the pipeline on
        // inbound (or to_email on outbound). The raw fields are the
        // last-line-of-defence when person_id never resolved.
        const joinedPersonName = person
          ? [person.first_name, person.last_name].filter(Boolean).join(' ')
          : null
        const rawFromName = typeof row.from_name === 'string' ? row.from_name.trim() : ''
        const personName =
          joinedPersonName ||
          coupleDisplay ||
          (rawFromName || null)
        const personEmail =
          person?.email ||
          partner1?.email ||
          (row.direction === 'outbound' ? row.to_email : row.from_email) ||
          null
        const weddingStatus = wedding?.status ?? null
        const weddingCodes: Array<{ code?: string }> = Array.isArray(wedding?.client_codes)
          ? wedding.client_codes
          : []
        const clientCode = weddingCodes.length > 0 ? weddingCodes[0]?.code ?? null : null
        const venueRel = row.venues as { name?: string } | { name?: string }[] | null | undefined
        const venueName = Array.isArray(venueRel) ? venueRel[0]?.name ?? null : venueRel?.name ?? null

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
          venue_name: venueName,
        }
      })

      // Pull pending drafts that are linked to any of these interactions
      // and merge them in. This is what powers the inline approval card
      // under each email row in the list.
      const interactionIdList = mapped.map((m) => m.id)
      let draftRows: any[] = []
      if (interactionIdList.length > 0) {
        let dq = supabase
          .from('drafts')
          .select(
            'id, interaction_id, draft_body, subject, to_email, brain_used, confidence_score, auto_sent, created_at'
          )
          .eq('status', 'pending')
          .in('interaction_id', interactionIdList)
        if (venueIds && venueIds.length > 0) {
          dq = dq.in('venue_id', venueIds)
        }
        const { data: dData } = await dq
        draftRows = dData ?? []
      }
      const draftByInteraction = new Map<string, PendingDraft>()
      for (const d of draftRows) {
        if (d.interaction_id) {
          draftByInteraction.set(d.interaction_id, {
            id: d.id,
            draft_body: d.draft_body,
            subject: d.subject,
            to_email: d.to_email,
            brain_used: d.brain_used,
            confidence_score: d.confidence_score,
            auto_sent: d.auto_sent ?? false,
            created_at: d.created_at,
          })
        }
      }
      const merged = mapped.map((m) => ({
        ...m,
        pending_draft: draftByInteraction.get(m.id) ?? null,
      }))

      setInteractions(merged)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch interactions:', err)
      setError('Failed to load emails')
    } finally {
      setLoading(false)
    }
  }, [scope.loading, resolveVenueIds, supabase])

  // ---- Inline draft approval handlers ----
  const clearDraftFromList = useCallback((draftId: string) => {
    setInteractions((prev) =>
      prev.map((i) => (i.pending_draft?.id === draftId ? { ...i, pending_draft: null } : i))
    )
    setPendingDraftCount((c) => Math.max(0, c - 1))
  }, [])

  const handleInlineApprove = async (draftId: string, venueId: string) => {
    setProcessingDraftId(draftId)
    try {
      await supabase
        .from('drafts')
        .update({ status: 'approved', approved_at: new Date().toISOString() })
        .eq('id', draftId)
      await supabase.from('draft_feedback').insert({
        venue_id: venueId,
        draft_id: draftId,
        action: 'approved',
      })
      clearDraftFromList(draftId)
    } catch (err) {
      console.error('Failed to approve draft:', err)
    } finally {
      setProcessingDraftId(null)
    }
  }

  const handleInlineApproveAndSend = async (draftId: string, venueId: string) => {
    setProcessingDraftId(draftId)
    try {
      await supabase
        .from('drafts')
        .update({ status: 'approved', approved_at: new Date().toISOString() })
        .eq('id', draftId)
      await supabase.from('draft_feedback').insert({
        venue_id: venueId,
        draft_id: draftId,
        action: 'approved',
      })
      try {
        await fetch('/api/agent/drafts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftId }),
        })
      } catch {
        // email send is best-effort
      }
      clearDraftFromList(draftId)
    } catch (err) {
      console.error('Failed to approve & send draft:', err)
    } finally {
      setProcessingDraftId(null)
    }
  }

  const handleInlineEditApprove = async (draftId: string, body: string) => {
    setProcessingDraftId(draftId)
    try {
      const target = interactions.find((i) => i.pending_draft?.id === draftId)
      const venueId = target?.venue_id
      const original = target?.pending_draft?.draft_body
      await supabase
        .from('drafts')
        .update({
          draft_body: body,
          status: 'approved',
          approved_at: new Date().toISOString(),
        })
        .eq('id', draftId)
      await supabase.from('draft_feedback').insert({
        venue_id: venueId,
        draft_id: draftId,
        action: 'edited',
        original_body: original,
        edited_body: body,
      })
      clearDraftFromList(draftId)
    } catch (err) {
      console.error('Failed to edit/approve draft:', err)
      throw err
    } finally {
      setProcessingDraftId(null)
    }
  }

  const handleInlineReject = async (draftId: string, venueId: string, reason: string) => {
    setProcessingDraftId(draftId)
    try {
      await supabase
        .from('drafts')
        .update({ status: 'rejected', feedback_notes: reason || null })
        .eq('id', draftId)
      await supabase.from('draft_feedback').insert({
        venue_id: venueId,
        draft_id: draftId,
        action: 'rejected',
        rejection_reason: reason || null,
      })
      clearDraftFromList(draftId)
    } catch (err) {
      console.error('Failed to reject draft:', err)
      throw err
    } finally {
      setProcessingDraftId(null)
    }
  }

  useEffect(() => {
    fetchInteractions()
  }, [fetchInteractions])

  // ---- Load thread when selecting an email ----
  const loadThread = useCallback(
    async (interaction: Interaction) => {
      setSelectedId(interaction.id)
      setThreadLoading(true)
      setThreadDraft(null)
      setSigningPrompt(null)
      setThreadLock(null)

      try {
        const venueIds = await resolveVenueIds()
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
            from_email,
            from_name,
            to_email,
            gmail_thread_id,
            timestamp,
            people!interactions_person_id_fkey ( first_name, last_name, email ),
            weddings!interactions_wedding_id_fkey (
              people ( first_name, last_name, email, role )
            )
          `)
          .order('timestamp', { ascending: true })
        if (venueIds && venueIds.length > 0) {
          query = query.in('venue_id', venueIds)
        }

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
          const joinedPersonName = person
            ? [person.first_name, person.last_name].filter(Boolean).join(' ')
            : null
          const rawFromName = typeof row.from_name === 'string' ? row.from_name.trim() : ''
          const personName =
            joinedPersonName ||
            coupleDisplay ||
            (rawFromName || null)
          const personEmail =
            person?.email ||
            partner1?.email ||
            (row.direction === 'outbound' ? row.to_email : row.from_email) ||
            null
          return {
            ...row,
            person_name: personName || undefined,
            person_email: personEmail || undefined,
          }
        })

        setThreadMessages(mapped.length > 0 ? mapped : [interaction])

        // Check for a pending draft
        let draftQuery = supabase
          .from('drafts')
          .select('id, draft_body, subject')
          .eq('interaction_id', interaction.id)
          .eq('status', 'pending')
        if (venueIds && venueIds.length > 0) {
          draftQuery = draftQuery.in('venue_id', venueIds)
        }
        const { data: draftData } = await draftQuery
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (draftData) {
          setThreadDraft(draftData)
        }

        // Check for contract signing detection on any interaction in this thread
        if (interaction.wedding_id) {
          const threadInteractionIds = (mapped.length > 0 ? mapped : [interaction]).map(
            (m) => m.id
          )

          let extractionQuery = supabase
            .from('intelligence_extractions')
            .select('id, interaction_id')
            .eq('extraction_type', 'contract_signing_detected')
            .in('interaction_id', threadInteractionIds)
          if (venueIds && venueIds.length > 0) {
            extractionQuery = extractionQuery.in('venue_id', venueIds)
          }
          const { data: extractionRows } = await extractionQuery.limit(1)

          if (extractionRows && extractionRows.length > 0) {
            // Confirm the wedding is still in a pre-contract stage
            const { data: weddingRow } = await supabase
              .from('weddings')
              .select('status')
              .eq('id', interaction.wedding_id)
              .single()

            const preContractStatuses = [
              'inquiry',
              'tour_scheduled',
              'tour_completed',
              'proposal_sent',
            ]

            if (weddingRow && preContractStatuses.includes(weddingRow.status as string)) {
              // Find any unresolved notification for this wedding
              let notifQuery = supabase
                .from('admin_notifications')
                .select('id')
                .eq('wedding_id', interaction.wedding_id)
                .eq('type', 'contract_signing_detected')
                .eq('read', false)
              if (venueIds && venueIds.length > 0) {
                notifQuery = notifQuery.in('venue_id', venueIds)
              }
              const { data: notifRows } = await notifQuery
                .order('created_at', { ascending: false })
                .limit(1)

              setSigningPrompt({
                notificationId: notifRows && notifRows.length > 0 ? notifRows[0].id : null,
                coupleName: interaction.person_name || interaction.person_email || 'this couple',
                weddingId: interaction.wedding_id,
              })
            }
          }
        }

        // Check for thread locks from other coordinators
        try {
          const lockParams = new URLSearchParams({
            venueId: interaction.venue_id,
            interactionId: interaction.id,
            currentUser: currentUserName,
          })
          const lockRes = await fetch(`/api/agent/thread-lock?${lockParams.toString()}`)
          if (lockRes.ok) {
            const lockData = await lockRes.json()
            if (lockData.locked) {
              setThreadLock({
                locked: true,
                lockedBy: lockData.lockedBy,
                lockedAt: lockData.lockedAt,
              })
            }
          }
        } catch {
          // Thread lock check is best-effort
        }
      } catch (err) {
        console.error('Failed to load thread:', err)
      } finally {
        setThreadLoading(false)
      }
    },
    [resolveVenueIds, supabase]
  )

  // ---- Sync emails ----
  // Single button. If the venue has never synced (no interactions yet),
  // we do a 90-day backfill so the kanban fills up on first click;
  // otherwise we pull deltas since the last history_id. Either way the
  // server returns `done=false` when more chunks are queued, and we loop
  // here until it's true so a multi-week backfill never hits a 504.
  // All the historical "repair" buttons (dedupe, reprocess-orphans,
  // cleanup-ghosts, repair-wedding-people, backfill-senders, etc.) are
  // legacy reconciliation tools. They shouldn't live in the operator UI.
  // The underlying endpoints stay on disk for manual curl use, but the
  // correct answer for new venues is a clean sync with the current
  // pipeline — not a chain of patch buttons.
  const handleSync = async () => {
    setSyncing(true)
    const firstSync = interactions.length === 0
    const daysParam = firstSync ? 'days=90&' : ''
    setSyncStatus(firstSync ? 'First sync — pulling last 90 days…' : 'Syncing…')
    try {
      let totalFetched = 0
      let totalProcessed = 0
      let totalInquiries = 0
      // Hard stop at 50 chunks so a runaway loop can't spin forever.
      for (let i = 0; i < 50; i++) {
        const res = await fetch(`/api/agent/sync?${daysParam}chunk=50`, { method: 'POST' })
        if (!res.ok) throw new Error(`Sync failed (${res.status})`)
        const data = (await res.json()) as {
          fetched: number
          processed: number
          inquiries: number
          done: boolean
        }
        totalFetched += data.fetched
        totalProcessed += data.processed
        totalInquiries += data.inquiries
        setSyncStatus(
          `Processed ${totalProcessed} emails (${totalInquiries} inquiries)${data.done ? '' : '…'}`
        )
        if (data.done) break
        // Brief yield so React can paint the status update.
        await new Promise((r) => setTimeout(r, 50))
      }
      await fetchInteractions()
      setSyncStatus(
        totalFetched === 0
          ? 'No new emails.'
          : `Done — ${totalProcessed} processed, ${totalInquiries} inquiries.`
      )
      setTimeout(() => setSyncStatus(null), 6000)
    } catch (err) {
      console.error('Failed to sync emails:', err)
      setError('Email sync failed. Check Gmail connection.')
      setSyncStatus(null)
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
            title="Pull new emails from Gmail. First sync backfills the last 90 days automatically."
            className="flex items-center gap-2 px-4 py-2.5 text-sage-700 border border-sage-300 text-sm font-medium rounded-lg hover:bg-sage-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
        </div>
      </div>
      {syncStatus && (
        <div className="bg-sage-50 border border-sage-200 rounded-lg px-4 py-2 text-sm text-sage-700">
          {syncStatus}
        </div>
      )}

      {/* ---- Inline insight banner ---- */}
      <InlineInsightBanner category="lead_conversion,response_time" />

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
                <div key={interaction.id}>
                  <EmailListItem
                    interaction={interaction}
                    isSelected={interaction.id === selectedId}
                    onClick={() => loadThread(interaction)}
                    showVenueChip={showVenueChip}
                  />
                  {interaction.pending_draft && (
                    <InlineDraftApproval
                      draft={interaction.pending_draft}
                      isProcessing={processingDraftId === interaction.pending_draft.id}
                      onApprove={() =>
                        handleInlineApprove(
                          interaction.pending_draft!.id,
                          interaction.venue_id
                        )
                      }
                      onApproveAndSend={() =>
                        handleInlineApproveAndSend(
                          interaction.pending_draft!.id,
                          interaction.venue_id
                        )
                      }
                      onEdit={() =>
                        setEditingDraft({
                          draft: interaction.pending_draft!,
                          venueId: interaction.venue_id,
                        })
                      }
                      onReject={() =>
                        setRejectingDraft({
                          draftId: interaction.pending_draft!.id,
                          venueId: interaction.venue_id,
                        })
                      }
                    />
                  )}
                </div>
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
                    signingPrompt={
                      signingPrompt
                        ? {
                            notificationId: signingPrompt.notificationId,
                            coupleName: signingPrompt.coupleName,
                          }
                        : null
                    }
                    threadLock={threadLock}
                    currentUserName={currentUserName}
                    onBack={() => setSelectedId(null)}
                    onReply={() => {
                      if (selectedInteraction) loadThread(selectedInteraction)
                    }}
                    onConfirmSigning={async () => {
                      if (!signingPrompt) return
                      // Move the wedding to Contracted (id is PK; scope filter unnecessary)
                      await supabase
                        .from('weddings')
                        .update({
                          status: 'contracted',
                          contracted_at: new Date().toISOString(),
                          updated_at: new Date().toISOString(),
                        })
                        .eq('id', signingPrompt.weddingId)

                      // Mark the notification as resolved (read)
                      if (signingPrompt.notificationId) {
                        await supabase
                          .from('admin_notifications')
                          .update({
                            read: true,
                            read_at: new Date().toISOString(),
                          })
                          .eq('id', signingPrompt.notificationId)
                      }

                      setSigningPrompt(null)
                      // Refetch the thread & list so the status updates
                      await fetchInteractions()
                      if (selectedInteraction) await loadThread(selectedInteraction)
                    }}
                    onDismissSigning={async () => {
                      if (signingPrompt?.notificationId) {
                        await supabase
                          .from('admin_notifications')
                          .update({
                            read: true,
                            read_at: new Date().toISOString(),
                          })
                          .eq('id', signingPrompt.notificationId)
                      }
                      setSigningPrompt(null)
                    }}
                    onSaveDraft={async (draftId: string, body: string) => {
                      // Save edits only. Keep status='pending' so the card
                      // stays in place and the coordinator can return to it.
                      await supabase
                        .from('drafts')
                        .update({ draft_body: body, status: 'pending' })
                        .eq('id', draftId)
                      await supabase.from('draft_feedback').insert({
                        venue_id: selectedInteraction?.venue_id,
                        draft_id: draftId,
                        action: 'edited',
                      })
                      setThreadDraft((prev) =>
                        prev && prev.id === draftId ? { ...prev, draft_body: body } : prev
                      )
                    }}
                    onSaveAndSendDraft={async (draftId: string, body: string) => {
                      // Persist current edits, mark approved, fire send.
                      await supabase
                        .from('drafts')
                        .update({
                          draft_body: body,
                          status: 'approved',
                          approved_at: new Date().toISOString(),
                        })
                        .eq('id', draftId)
                      await supabase.from('draft_feedback').insert({
                        venue_id: selectedInteraction?.venue_id,
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
                    onDeleteDraft={async (draftId: string) => {
                      // Hard delete. Log the feedback event first so
                      // training data survives.
                      await supabase.from('draft_feedback').insert({
                        venue_id: selectedInteraction?.venue_id,
                        draft_id: draftId,
                        action: 'deleted',
                      })
                      await supabase.from('drafts').delete().eq('id', draftId)
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
          venueId={composeVenueId}
          onClose={() => setShowCompose(false)}
          onSent={fetchInteractions}
        />
      )}

      {/* Edit draft modal (from inline approval card in list) */}
      {editingDraft && (
        <EditDraftModal
          draft={editingDraft.draft}
          onClose={() => setEditingDraft(null)}
          onSave={async (id, body) => {
            await handleInlineEditApprove(id, body)
          }}
        />
      )}

      {/* Reject draft modal (from inline approval card in list) */}
      {rejectingDraft && (
        <RejectDraftModal
          onClose={() => setRejectingDraft(null)}
          onReject={async (reason) => {
            await handleInlineReject(rejectingDraft.draftId, rejectingDraft.venueId, reason)
          }}
        />
      )}
    </div>
  )
}
