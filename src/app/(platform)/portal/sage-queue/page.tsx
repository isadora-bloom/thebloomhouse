'use client'

import { useState, useEffect, useCallback } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createBrowserClient } from '@supabase/ssr'
import { VenueChip } from '@/components/intel/venue-chip'
import {
  MessageSquareWarning,
  Send,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  Clock,
  AlertTriangle,
  BookOpen,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SageQueueItem {
  id: string
  venue_id: string
  wedding_id: string | null
  conversation_id: string | null
  question: string
  sage_answer: string | null
  confidence_score: number
  coordinator_response: string | null
  resolved_by: string | null
  resolved_at: string | null
  added_to_kb: boolean
  created_at: string
  // Joined data
  wedding?: {
    id: string
    people: { first_name: string; last_name: string; role: string }[]
  } | null
  venue_name?: string | null
}

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

function getCoupleLabel(wedding: SageQueueItem['wedding']): string {
  if (!wedding?.people?.length) return 'Unknown Couple'
  const principals = wedding.people.filter(
    (p) => p.role === 'bride' || p.role === 'groom' || p.role === 'partner'
  )
  const names = principals.length > 0 ? principals : wedding.people.slice(0, 2)
  return names.map((p) => p.first_name).join(' & ')
}

function confidenceConfig(score: number): {
  label: string
  className: string
} {
  // Scores are stored as integers 0-100
  if (score >= 50) {
    return {
      label: `${score}% — needs confirmation`,
      className: 'bg-amber-50 text-amber-700 border border-amber-200',
    }
  }
  return {
    label: `${score}% — low confidence`,
    className: 'bg-red-50 text-red-700 border border-red-200',
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function QueueCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-5 w-24 bg-sage-100 rounded-full" />
          <div className="h-5 w-32 bg-sage-100 rounded" />
        </div>
        <div className="h-12 bg-sage-50 rounded-lg" />
        <div className="h-16 bg-sage-50 rounded-lg" />
        <div className="h-10 w-48 bg-sage-100 rounded-lg" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Queue Card
// ---------------------------------------------------------------------------

function QueueCard({
  item,
  onRespond,
  showVenueChip,
}: {
  item: SageQueueItem
  onRespond: (id: string, answer: string, addToKB: boolean) => Promise<void>
  showVenueChip: boolean
}) {
  const [answer, setAnswer] = useState('')
  const [addToKB, setAddToKB] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const confidence = confidenceConfig(item.confidence_score)
  const coupleLabel = getCoupleLabel(item.wedding)

  const handleSubmit = async () => {
    if (!answer.trim()) return
    setSubmitting(true)
    try {
      await onRespond(item.id, answer.trim(), addToKB)
      setAnswer('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm border-l-4 border-l-amber-400">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${confidence.className}`}>
            <Sparkles className="w-3 h-3 mr-1" />
            {confidence.label}
          </span>
          <span className="text-sm font-medium text-sage-700">
            {coupleLabel}
          </span>
          {showVenueChip && <VenueChip venueName={item.venue_name} />}
        </div>
        <span className="text-xs text-sage-400 shrink-0">
          {timeAgo(item.created_at)}
        </span>
      </div>

      {/* Question */}
      <div className="mb-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">
          Couple&apos;s Question
        </h4>
        <p className="text-sage-900 text-sm leading-relaxed bg-warm-white border border-sage-100 rounded-lg p-3">
          {item.question}
        </p>
      </div>

      {/* Sage's uncertain answer */}
      {item.sage_answer && (
        <div className="mb-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-amber-500" />
            Sage&apos;s Uncertain Answer
          </h4>
          <p className="text-sage-700 text-sm leading-relaxed bg-amber-50/50 border border-amber-100 rounded-lg p-3 italic">
            {item.sage_answer}
          </p>
        </div>
      )}

      {/* Coordinator response area */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">
          Your Definitive Answer
        </h4>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Type the correct answer for this couple..."
          rows={3}
          className="w-full px-3 py-2.5 border border-sage-200 rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none bg-warm-white mb-3"
        />

        <div className="flex items-center justify-between gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={addToKB}
              onChange={(e) => setAddToKB(e.target.checked)}
              className="w-4 h-4 rounded border-sage-300 text-sage-600 focus:ring-sage-500"
            />
            <span className="text-xs text-sage-600 flex items-center gap-1">
              <BookOpen className="w-3 h-3" />
              Add to Knowledge Base
            </span>
          </label>

          <button
            onClick={handleSubmit}
            disabled={!answer.trim() || submitting}
            className="inline-flex items-center gap-2 px-4 py-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-3.5 h-3.5" />
            {submitting ? 'Sending...' : 'Respond & Add to KB'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Resolved Item
// ---------------------------------------------------------------------------

function ResolvedItem({ item, showVenueChip }: { item: SageQueueItem; showVenueChip: boolean }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm text-sage-700 line-clamp-1">
            {item.question}
          </p>
          {showVenueChip && <VenueChip venueName={item.venue_name} />}
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-sage-400">
          <span>{getCoupleLabel(item.wedding)}</span>
          {item.resolved_at && <span>Resolved {timeAgo(item.resolved_at)}</span>}
          {item.added_to_kb && (
            <span className="flex items-center gap-0.5 text-teal-500">
              <BookOpen className="w-3 h-3" />
              Added to KB
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function SageQueuePage() {
  const scope = useScope()
  const showVenueChip = scope.level !== 'venue'
  const [pendingItems, setPendingItems] = useState<SageQueueItem[]>([])
  const [resolvedItems, setResolvedItems] = useState<SageQueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)

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
        const { data: orgVenues } = await supabase
          .from('venues')
          .select('id')
          .eq('org_id', scope.orgId)
        venueIds = (orgVenues ?? []).map((v) => v.id as string)
      }

      let pendingQuery = supabase
        .from('sage_uncertain_queue')
        .select(`
          *,
          venues:venue_id ( name ),
          wedding:weddings (
            id,
            people (first_name, last_name, role)
          )
        `)
        .is('resolved_at', null)
        .order('created_at', { ascending: false })
      let resolvedQuery = supabase
        .from('sage_uncertain_queue')
        .select(`
          *,
          venues:venue_id ( name ),
          wedding:weddings (
            id,
            people (first_name, last_name, role)
          )
        `)
        .not('resolved_at', 'is', null)
        .order('resolved_at', { ascending: false })
        .limit(20)

      if (venueIds && venueIds.length > 0) {
        pendingQuery = pendingQuery.in('venue_id', venueIds)
        resolvedQuery = resolvedQuery.in('venue_id', venueIds)
      }

      const [pendingRes, resolvedRes] = await Promise.all([pendingQuery, resolvedQuery])

      if (pendingRes.error) throw pendingRes.error
      if (resolvedRes.error) throw resolvedRes.error

      const mapRow = (row: any): SageQueueItem => {
        const venueRel = row.venues as { name?: string } | { name?: string }[] | null | undefined
        const venueName = Array.isArray(venueRel) ? venueRel[0]?.name ?? null : venueRel?.name ?? null
        return { ...row, venue_name: venueName }
      }

      setPendingItems((pendingRes.data ?? []).map(mapRow))
      setResolvedItems((resolvedRes.data ?? []).map(mapRow))
      setError(null)
    } catch (err) {
      console.error('Failed to fetch sage queue:', err)
      setError('Failed to load sage queue')
    } finally {
      setLoading(false)
    }
  }, [scope.level, scope.venueId, scope.groupId, scope.loading])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Respond to question ----
  const handleRespond = async (id: string, answer: string, addToKB: boolean) => {
    const supabase = getSupabase()

    const { error: updateErr } = await supabase
      .from('sage_uncertain_queue')
      .update({
        coordinator_response: answer,
        resolved_at: new Date().toISOString(),
        added_to_kb: addToKB,
      })
      .eq('id', id)

    if (updateErr) {
      console.error('Failed to respond:', updateErr)
      return
    }

    // If adding to KB, also insert into knowledge_base (using the item's own venue_id)
    if (addToKB) {
      const item = pendingItems.find((i) => i.id === id)
      if (item) {
        await supabase.from('knowledge_base').insert({
          venue_id: item.venue_id,
          category: 'sage_learned',
          question: item.question,
          answer: answer,
          keywords: [],
          priority: 1,
          is_active: true,
        })
      }
    }

    // Move item from pending to resolved locally
    const movedItem = pendingItems.find((i) => i.id === id)
    if (movedItem) {
      const resolved = {
        ...movedItem,
        coordinator_response: answer,
        resolved_at: new Date().toISOString(),
        added_to_kb: addToKB,
      }
      setPendingItems((prev) => prev.filter((i) => i.id !== id))
      setResolvedItems((prev) => [resolved, ...prev])
    }
  }

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Sage Queue
          {!loading && pendingItems.length > 0 && (
            <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-medium bg-amber-100 text-amber-700">
              {pendingItems.length} pending
            </span>
          )}
        </h1>
        <p className="text-sage-600">
          Questions Sage wasn&apos;t confident enough to answer on her own. Review each one, provide the correct answer, and optionally add it to the Knowledge Base so she learns for next time.
        </p>
      </div>

      {/* ---- Error state ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <MessageSquareWarning className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchData() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Pending Queue ---- */}
      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <QueueCardSkeleton key={i} />
          ))}
        </div>
      ) : pendingItems.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            Queue is clear
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            No uncertain questions right now. When Sage encounters a question it
            can&apos;t answer confidently, it will appear here for your review.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pendingItems.map((item) => (
            <QueueCard key={item.id} item={item} onRespond={handleRespond} showVenueChip={showVenueChip} />
          ))}
        </div>
      )}

      {/* ---- Resolved Section ---- */}
      {resolvedItems.length > 0 && (
        <section>
          <button
            onClick={() => setShowResolved(!showResolved)}
            className="flex items-center gap-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
          >
            <Clock className="w-4 h-4" />
            Recently Resolved ({resolvedItems.length})
            {showResolved ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>

          {showResolved && (
            <div className="mt-3 bg-surface border border-border rounded-xl shadow-sm divide-y divide-border">
              {resolvedItems.map((item) => (
                <ResolvedItem key={item.id} item={item} showVenueChip={showVenueChip} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
