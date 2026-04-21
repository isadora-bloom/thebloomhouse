'use client'

import { useState, useEffect, useCallback } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import { VenueChip } from '@/components/intel/venue-chip'
import {
  FileCheck,
  CheckCircle,
  XCircle,
  Pencil,
  Brain,
  Sparkles,
  Send,
  X,
  AlertTriangle,
  Clock,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Draft {
  id: string
  venue_id: string
  wedding_id: string | null
  interaction_id: string | null
  to_email: string | null
  subject: string | null
  draft_body: string
  status: 'pending' | 'approved' | 'rejected' | 'sent'
  context_type: string | null
  brain_used: string | null
  confidence_score: number | null
  auto_sent: boolean
  feedback_notes: string | null
  created_at: string
  approved_at: string | null
  // Joined
  interaction_preview?: string | null
  interaction_subject?: string | null
  venue_name?: string | null
}

type FilterTab = 'pending' | 'approved' | 'rejected' | 'sent'

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
  return `${days}d ago`
}

function confidenceColor(score: number | null): {
  bg: string
  text: string
  label: string
} {
  if (score === null) return { bg: 'bg-sage-50', text: 'text-sage-600', label: '?' }
  if (score >= 90) return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: `${score}%` }
  if (score >= 75) return { bg: 'bg-amber-50', text: 'text-amber-700', label: `${score}%` }
  return { bg: 'bg-red-50', text: 'text-red-700', label: `${score}%` }
}

function brainBadge(brain: string | null): { bg: string; text: string; label: string } {
  switch (brain) {
    case 'inquiry_brain':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Inquiry Brain' }
    case 'client_brain':
      return { bg: 'bg-sage-50', text: 'text-sage-700', label: 'Client Brain' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: brain || 'Unknown' }
  }
}

function statusBadge(status: string) {
  switch (status) {
    case 'pending':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Pending' }
    case 'approved':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Approved' }
    case 'rejected':
      return { bg: 'bg-red-50', text: 'text-red-700', label: 'Rejected' }
    case 'sent':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Sent' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: status }
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function DraftCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-5 w-32 bg-sage-100 rounded" />
          <div className="h-5 w-16 bg-sage-100 rounded-full" />
          <div className="h-5 w-20 bg-sage-100 rounded-full" />
        </div>
        <div className="h-4 w-2/3 bg-sage-100 rounded" />
        <div className="space-y-2">
          <div className="h-3 w-full bg-sage-50 rounded" />
          <div className="h-3 w-full bg-sage-50 rounded" />
          <div className="h-3 w-4/5 bg-sage-50 rounded" />
        </div>
        <div className="flex gap-2 pt-2">
          <div className="h-9 w-24 bg-sage-100 rounded-lg" />
          <div className="h-9 w-32 bg-sage-100 rounded-lg" />
          <div className="h-9 w-20 bg-sage-100 rounded-lg" />
        </div>
      </div>
    </div>
  )
}

function StatCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-2">
        <div className="h-3 w-20 bg-sage-100 rounded" />
        <div className="h-7 w-10 bg-sage-100 rounded" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit Modal
// ---------------------------------------------------------------------------

function EditModal({
  draft,
  onClose,
  onSave,
}: {
  draft: Draft
  onClose: () => void
  onSave: (id: string, editedBody: string) => Promise<void>
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
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div className="flex items-center gap-2">
            <Pencil className="w-5 h-5 text-sage-600" />
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Edit Draft
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pb-6 space-y-4">
          {/* To / Subject */}
          <div className="text-sm text-sage-600">
            <span className="font-medium text-sage-800">To:</span>{' '}
            {draft.to_email || 'Unknown'}
            {draft.subject && (
              <>
                <br />
                <span className="font-medium text-sage-800">Subject:</span>{' '}
                {draft.subject}
              </>
            )}
          </div>

          {/* Body */}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className="w-full px-3 py-2.5 border border-sage-200 rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none bg-warm-white leading-relaxed"
          />

          {/* Actions */}
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

// ---------------------------------------------------------------------------
// Reject Reason Modal
// ---------------------------------------------------------------------------

function RejectModal({
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
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Reject Draft
            </h2>
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
// Draft Card
// ---------------------------------------------------------------------------

function DraftCard({
  draft,
  onApprove,
  onApproveAndSend,
  onEdit,
  onReject,
  isProcessing,
  showVenueChip,
}: {
  draft: Draft
  onApprove: (id: string) => void
  onApproveAndSend: (id: string) => void
  onEdit: (draft: Draft) => void
  onReject: (draft: Draft) => void
  isProcessing: boolean
  showVenueChip: boolean
}) {
  const conf = confidenceColor(draft.confidence_score)
  const brain = brainBadge(draft.brain_used)
  const status = statusBadge(draft.status)
  const isPending = draft.status === 'pending'
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-medium text-sage-900 truncate">
              {draft.to_email || 'Unknown recipient'}
            </span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${status.bg} ${status.text}`}
            >
              {status.label}
            </span>
            {showVenueChip && <VenueChip venueName={draft.venue_name} />}
          </div>
          <p className="text-sm text-sage-600 truncate">
            {draft.subject || '(No subject)'}
          </p>
        </div>
        <span className="text-xs text-sage-400 shrink-0">
          {timeAgo(draft.created_at)}
        </span>
      </div>

      {/* Draft body */}
      <div className="bg-warm-white border border-border rounded-lg p-4 mb-4">
        <p className={`text-sm text-sage-700 whitespace-pre-wrap leading-relaxed ${expanded ? '' : 'line-clamp-6'}`}>
          {draft.draft_body}
        </p>
        {draft.draft_body && draft.draft_body.length > 300 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-2 text-xs font-medium text-sage-600 hover:text-sage-900 underline-offset-2 hover:underline"
          >
            {expanded ? 'Show less' : 'Show full email'}
          </button>
        )}
      </div>

      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        {/* Confidence */}
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${conf.bg} ${conf.text}`}
        >
          <Sparkles className="w-3 h-3" />
          {conf.label} confidence
        </span>
        {/* Brain */}
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${brain.bg} ${brain.text}`}
        >
          <Brain className="w-3 h-3" />
          {brain.label}
        </span>
        {/* Auto-sent */}
        {draft.auto_sent && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
            <Send className="w-3 h-3" />
            Auto-sent
          </span>
        )}
      </div>

      {/* Original inquiry context */}
      {draft.interaction_preview && (
        <div className="mb-4">
          <p className="text-xs font-medium text-sage-500 mb-1">Original email:</p>
          <p className="text-xs text-sage-400 italic line-clamp-2">
            {draft.interaction_subject && (
              <span className="font-medium not-italic">{draft.interaction_subject}: </span>
            )}
            {draft.interaction_preview}
          </p>
        </div>
      )}

      {/* Feedback notes (for rejected/approved) */}
      {draft.feedback_notes && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <p className="text-xs text-amber-700">
            <span className="font-medium">Feedback:</span> {draft.feedback_notes}
          </p>
        </div>
      )}

      {/* Action buttons */}
      {isPending && (
        <div className="flex items-center gap-2 pt-2 border-t border-border flex-wrap">
          <button
            onClick={() => onApprove(draft.id)}
            disabled={isProcessing}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Mark approved. Won't send until you click Send from the Approved tab."
          >
            <CheckCircle className="w-4 h-4" />
            Approve
          </button>
          <button
            onClick={() => onEdit(draft)}
            disabled={isProcessing}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-sage-700 border border-sage-300 rounded-lg hover:bg-sage-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Edit the draft, then mark approved (no send)."
          >
            <Pencil className="w-4 h-4" />
            Edit & Approve
          </button>
          <button
            onClick={() => onApproveAndSend(draft.id)}
            disabled={isProcessing}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Approve and send immediately."
          >
            <Send className="w-4 h-4" />
            Approve & Send
          </button>
          <button
            onClick={() => onReject(draft)}
            disabled={isProcessing}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <XCircle className="w-4 h-4" />
            Reject
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ApprovalQueuePage() {
  const scope = useScope()
  const showVenueChip = scope.level !== 'venue'
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<FilterTab>('pending')
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<Draft | null>(null)
  const [rejectingDraft, setRejectingDraft] = useState<Draft | null>(null)

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

  // ---- Fetch drafts ----
  const fetchDrafts = useCallback(
    async (status?: string) => {
      if (scope.loading) return
      try {
        const venueIds = await resolveVenueIds()
        let query = supabase
          .from('drafts')
          .select(`
            id,
            venue_id,
            wedding_id,
            interaction_id,
            to_email,
            subject,
            draft_body,
            status,
            context_type,
            brain_used,
            confidence_score,
            auto_sent,
            feedback_notes,
            created_at,
            approved_at,
            venues:venue_id ( name ),
            interactions!drafts_interaction_id_fkey ( subject, body_preview )
          `)
          .order('created_at', { ascending: false })
          .limit(100)

        if (venueIds && venueIds.length > 0) {
          query = query.in('venue_id', venueIds)
        }

        if (status) {
          query = query.eq('status', status)
        }

        const { data, error: fetchError } = await query

        if (fetchError) throw fetchError

        const mapped: Draft[] = (data ?? []).map((row: any) => {
          const venueRel = row.venues as { name?: string } | { name?: string }[] | null | undefined
          const venueName = Array.isArray(venueRel) ? venueRel[0]?.name ?? null : venueRel?.name ?? null
          return {
            ...row,
            interaction_preview: row.interactions?.body_preview ?? null,
            interaction_subject: row.interactions?.subject ?? null,
            venue_name: venueName,
            interactions: undefined,
            venues: undefined,
          }
        })

        setDrafts(mapped)
        setError(null)
      } catch (err) {
        console.error('Failed to fetch drafts:', err)
        setError('Failed to load drafts')
      } finally {
        setLoading(false)
      }
    },
    [scope.loading, supabase, resolveVenueIds]
  )

  useEffect(() => {
    setLoading(true)
    fetchDrafts(activeTab)
  }, [fetchDrafts, activeTab])

  // ---- Approve only (queue, do not send) ----
  const handleApprove = async (id: string) => {
    setProcessingId(id)
    try {
      const draftRow = drafts.find((d) => d.id === id)
      const { error: updateError } = await supabase
        .from('drafts')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
        })
        .eq('id', id)

      if (updateError) throw updateError

      await supabase.from('draft_feedback').insert({
        venue_id: draftRow?.venue_id,
        draft_id: id,
        action: 'approved',
      })

      // No send — draft sits in the Approved tab until someone sends it.
      setDrafts((prev) => prev.filter((d) => d.id !== id))
    } catch (err) {
      console.error('Failed to approve draft:', err)
      setError('Failed to approve draft')
    } finally {
      setProcessingId(null)
    }
  }

  // ---- Approve + send immediately ----
  const handleApproveAndSend = async (id: string) => {
    setProcessingId(id)
    try {
      const draftRow = drafts.find((d) => d.id === id)
      const { error: updateError } = await supabase
        .from('drafts')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
        })
        .eq('id', id)

      if (updateError) throw updateError

      await supabase.from('draft_feedback').insert({
        venue_id: draftRow?.venue_id,
        draft_id: id,
        action: 'approved',
      })

      // Send the email via the API (triggers gmail.sendEmail)
      try {
        await fetch('/api/agent/drafts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftId: id }),
        })
      } catch (sendErr) {
        // Email send failure shouldn't block UI — draft is approved regardless
        console.warn('Email send attempted but may have failed:', sendErr)
      }

      setDrafts((prev) => prev.filter((d) => d.id !== id))
    } catch (err) {
      console.error('Failed to approve & send draft:', err)
      setError('Failed to approve & send draft')
    } finally {
      setProcessingId(null)
    }
  }

  // ---- Edit & Approve ----
  const handleEditApprove = async (id: string, editedBody: string) => {
    setProcessingId(id)
    try {
      const original = drafts.find((d) => d.id === id)

      const { error: updateError } = await supabase
        .from('drafts')
        .update({
          draft_body: editedBody,
          status: 'approved',
          approved_at: new Date().toISOString(),
        })
        .eq('id', id)

      if (updateError) throw updateError

      // Log feedback with edits
      await supabase.from('draft_feedback').insert({
        venue_id: original?.venue_id,
        draft_id: id,
        action: 'edited',
        original_body: original?.draft_body,
        edited_body: editedBody,
      })

      // No send — user can Approve & Send from the Approved tab if they
      // want to dispatch the edited version.
      setDrafts((prev) => prev.filter((d) => d.id !== id))
    } catch (err) {
      console.error('Failed to edit/approve draft:', err)
      setError('Failed to save draft')
      throw err
    } finally {
      setProcessingId(null)
    }
  }

  // ---- Reject draft ----
  const handleReject = async (id: string, reason: string) => {
    setProcessingId(id)
    try {
      const draftRow = drafts.find((d) => d.id === id)
      const { error: updateError } = await supabase
        .from('drafts')
        .update({
          status: 'rejected',
          feedback_notes: reason || null,
        })
        .eq('id', id)

      if (updateError) throw updateError

      // Log feedback
      await supabase.from('draft_feedback').insert({
        venue_id: draftRow?.venue_id,
        draft_id: id,
        action: 'rejected',
        rejection_reason: reason || null,
      })

      setDrafts((prev) => prev.filter((d) => d.id !== id))
    } catch (err) {
      console.error('Failed to reject draft:', err)
      setError('Failed to reject draft')
      throw err
    } finally {
      setProcessingId(null)
    }
  }

  // ---- Stats: fetch all drafts to compute today's counts ----
  const [stats, setStats] = useState({
    approvedToday: 0,
    rejectedToday: 0,
    autoSentToday: 0,
  })

  useEffect(() => {
    const fetchStats = async () => {
      if (scope.loading) return
      const venueIds = await resolveVenueIds()
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const hasVenueFilter = !!(venueIds && venueIds.length > 0)
      const vIds = venueIds ?? []

      let approvedQuery = supabase
        .from('drafts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'approved')
        .gte('approved_at', todayStart.toISOString())
      if (hasVenueFilter) approvedQuery = approvedQuery.in('venue_id', vIds)

      let rejectedQuery = supabase
        .from('drafts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'rejected')
        .gte('created_at', todayStart.toISOString())
      if (hasVenueFilter) rejectedQuery = rejectedQuery.in('venue_id', vIds)

      let autoSentQuery = supabase
        .from('drafts')
        .select('id', { count: 'exact', head: true })
        .eq('auto_sent', true)
        .gte('created_at', todayStart.toISOString())
      if (hasVenueFilter) autoSentQuery = autoSentQuery.in('venue_id', vIds)

      const [approved, rejected, autoSent] = await Promise.all([
        approvedQuery,
        rejectedQuery,
        autoSentQuery,
      ])

      setStats({
        approvedToday: approved.count ?? 0,
        rejectedToday: rejected.count ?? 0,
        autoSentToday: autoSent.count ?? 0,
      })
    }
    fetchStats()
  }, [drafts, scope.loading, scope.level, scope.venueId, scope.groupId, resolveVenueIds, supabase])

  // ---- Tab counts ----
  const pendingCount = activeTab === 'pending' ? drafts.length : null

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'sent', label: 'Sent' },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Approval Queue
          </h1>
          <p className="text-sage-600">
            Review AI-drafted emails before they go out. Approve to send immediately, edit to refine the message, or reject with feedback so the AI learns your preferences.
          </p>
        </div>
      </div>

      {/* ---- Stats row ---- */}
      <div className="grid grid-cols-3 gap-4">
        {loading ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : (
          <>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle className="w-4 h-4 text-emerald-500" />
                <span className="text-xs font-medium text-sage-500">Approved Today</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{stats.approvedToday}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="w-4 h-4 text-red-500" />
                <span className="text-xs font-medium text-sage-500">Rejected Today</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{stats.rejectedToday}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <Send className="w-4 h-4 text-blue-500" />
                <span className="text-xs font-medium text-sage-500">Auto-sent Today</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{stats.autoSentToday}</p>
            </div>
          </>
        )}
      </div>

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => {
              setError(null)
              setLoading(true)
              fetchDrafts(activeTab)
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Filter tabs ---- */}
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
            {tab.key === 'pending' && pendingCount !== null && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full ${
                  activeTab === tab.key
                    ? 'bg-sage-100 text-sage-700'
                    : 'bg-sage-100/50 text-sage-500'
                }`}
              >
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ---- Drafts list ---- */}
      {loading ? (
        <div className="space-y-4">
          <DraftCardSkeleton />
          <DraftCardSkeleton />
          <DraftCardSkeleton />
        </div>
      ) : drafts.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <FileCheck className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {activeTab === 'pending'
              ? 'No drafts waiting for approval'
              : `No ${activeTab} drafts`}
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {activeTab === 'pending'
              ? 'When the Agent generates email responses, they will appear here for your review before sending.'
              : `Drafts you have ${activeTab} will show up here.`}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {drafts.map((draft) => (
            <DraftCard
              key={draft.id}
              draft={draft}
              onApprove={handleApprove}
              onApproveAndSend={handleApproveAndSend}
              onEdit={setEditingDraft}
              onReject={setRejectingDraft}
              isProcessing={processingId === draft.id}
              showVenueChip={showVenueChip}
            />
          ))}
        </div>
      )}

      {/* ---- Edit Modal ---- */}
      {editingDraft && (
        <EditModal
          draft={editingDraft}
          onClose={() => setEditingDraft(null)}
          onSave={handleEditApprove}
        />
      )}

      {/* ---- Reject Modal ---- */}
      {rejectingDraft && (
        <RejectModal
          onClose={() => setRejectingDraft(null)}
          onReject={async (reason) => {
            await handleReject(rejectingDraft.id, reason)
          }}
        />
      )}
    </div>
  )
}
