'use client'

/**
 * The fourth walkthrough section: things they told you that are not on
 * the running order yet.
 *
 * W43 put the couple story, the contracts and the running order on the
 * coordinator's wedding page, because a final walkthrough kept bouncing
 * to a second screen. This is the gap that survived that fix. The three
 * sections show what has been written down. None of them shows what the
 * couple said in an email and nobody wrote down.
 *
 * So: a couple mentions a groom's cake in a reply about seating. The
 * nightly reconciler in services/commitments/reconcile.ts checks every
 * captured sentence against their running order, and whatever has no
 * event lands here, in the couple's own words, on the page the
 * coordinator already has open in the meeting.
 *
 * Two actions, both decisions a coordinator is entitled to make:
 *
 *   Add to the running order  writes a custom event through the same
 *                             `timeline.config_json` upsert the shared
 *                             TimelineBuilder uses, with the same
 *                             editedBy stamp, so the two writers cannot
 *                             drift apart.
 *
 *   No event needed           records the decision. The row is marked
 *                             dismissed, never deleted, because the
 *                             nightly sweep skips dismissed rows and
 *                             would otherwise put it straight back.
 *
 * Headings come from lib/copy/client-terms, the same way
 * WALKTHROUGH_HEADINGS does. Nothing on this screen says "commitment".
 */

import { useCallback, useEffect, useState } from 'react'
import { Check, ClipboardList, Loader2, MessageSquare, Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { COMMITMENTS_COPY } from '@/lib/copy/client-terms'
import { EmptyState } from '@/components/ui/empty-state'
import { stampEditedBy } from '@/components/couple/surface-role'
import { cn } from '@/lib/utils'

export const COMMITMENTS_ICON = ClipboardList

interface CommitmentRow {
  id: string
  quote: string
  kind: string
  status: string
  judge_reason: string | null
  source_interaction_id: string | null
  first_seen_at: string | null
}

export interface CommitmentsQueueProps {
  weddingId: string
  venueId: string
  /** Switches the host page to its communications tab. */
  onOpenCommunications?: () => void
  /** Fired after a successful timeline write, so the host can refetch. */
  onSaved?: () => void
}

/** A custom event, in exactly the shape TimelineBuilder writes. */
interface TimelineCustomEvent {
  id: string
  name: string
  time: string
  duration: number
  notes: string
  phase: string
  icon: string
}

export function CommitmentsQueue({
  weddingId,
  venueId,
  onOpenCommunications,
  onSaved,
}: CommitmentsQueueProps) {
  const [rows, setRows] = useState<CommitmentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [readFailed, setReadFailed] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<'add' | 'dismiss' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const fetchRows = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    // Venue-scoped as well as wedding-scoped. The foreign key makes the
    // wedding id sufficient, but every read of this table carries the
    // venue so a mistake upstream cannot become a cross-tenant read.
    const { data, error } = await supabase
      .from('commitment_reconciliation')
      .select('id, quote, kind, status, judge_reason, source_interaction_id, first_seen_at')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .in('status', ['unmatched', 'added', 'dismissed'])
      .order('first_seen_at', { ascending: false })

    if (error) {
      setReadFailed(true)
      setRows([])
    } else {
      setReadFailed(false)
      setRows((data ?? []) as CommitmentRow[])
    }
    setLoading(false)
  }, [venueId, weddingId])

  useEffect(() => {
    void fetchRows()
  }, [fetchRows])

  const outstanding = rows.filter((r) => r.status === 'unmatched')
  const settled = rows.filter((r) => r.status !== 'unmatched')

  async function dismiss(row: CommitmentRow) {
    setBusyId(row.id)
    setBusyAction('dismiss')
    setNotice(null)
    const supabase = createClient()
    const { error } = await supabase
      .from('commitment_reconciliation')
      .update({ status: 'dismissed', resolved_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('venue_id', venueId)

    if (error) {
      setNotice('That did not save. Nothing was changed.')
    } else {
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: 'dismissed' } : r)))
    }
    setBusyId(null)
    setBusyAction(null)
  }

  async function addToTimeline(row: CommitmentRow) {
    setBusyId(row.id)
    setBusyAction('add')
    setNotice(null)
    const supabase = createClient()

    // Read the whole row first. The blob has to go back intact — a
    // partial upsert would drop the ceremony time and every event the
    // couple had already arranged.
    const { data: existing, error: readError } = await supabase
      .from('timeline')
      .select('*')
      .eq('wedding_id', weddingId)
      .maybeSingle()

    if (readError) {
      setNotice('Could not read the running order. Nothing was changed.')
      setBusyId(null)
      setBusyAction(null)
      return
    }

    const blob = (existing?.config_json ?? {}) as {
      config?: unknown
      events?: unknown
      customEvents?: TimelineCustomEvent[]
    }

    const newEvent: TimelineCustomEvent = {
      // Same id shape and same default phase as the builder's own
      // "add custom event" path, so the event is indistinguishable from
      // one added in the builder itself. Keyed by the reconciliation row
      // rather than the clock: stable across renders (the React Compiler
      // rule) and it makes a second click on the same row a no-op id-wise.
      id: `custom_${row.id}`,
      name: row.quote.length > 80 ? `${row.quote.slice(0, 77)}...` : row.quote,
      time: '',
      duration: 15,
      notes: `They mentioned this: "${row.quote}"`,
      phase: 'reception_intro',
      icon: '🎯',
    }

    const payload = {
      venue_id: venueId,
      wedding_id: weddingId,
      config_json: {
        ...blob,
        customEvents: [...(blob.customEvents ?? []), newEvent],
        editedBy: stampEditedBy('coordinator'),
      },
    }

    const { error: writeError } = await supabase
      .from('timeline')
      // onConflict-skip-check: timeline is dual-mode (config-blob writer here and in
      // components/couple/timeline-builder.tsx, per-event row reader elsewhere on this page).
      // Migration 188 explicitly DEFERRED uq_timeline_wedding_id to avoid breaking the
      // per-event mode. Same call shape and same caveat as the builder, which this mirrors
      // rather than forks; resolving the schema fork is a separate stream's job.
      .upsert(payload, { onConflict: 'wedding_id' })

    if (writeError) {
      setNotice('That did not save. Nothing was added to the running order.')
      setBusyId(null)
      setBusyAction(null)
      return
    }

    const { error: markError } = await supabase
      .from('commitment_reconciliation')
      .update({ status: 'added', resolved_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('venue_id', venueId)

    if (markError) {
      // The event IS on the running order. Say that, rather than
      // reporting a failure the coordinator would answer by adding it
      // a second time.
      setNotice('Added to the running order. This row did not update; it will settle overnight.')
    }

    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: 'added' } : r)))
    onSaved?.()
    setBusyId(null)
    setBusyAction(null)
  }

  if (loading) {
    return <div className="h-24 rounded-lg bg-sage-50 animate-pulse" />
  }

  if (readFailed) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="Could not read this just now"
        subtitle="The check runs overnight and its results are stored; the read of them did not answer. Nothing is lost. Try again in a moment."
        variant="dashed"
      />
    )
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title={COMMITMENTS_COPY.emptyTitle}
        subtitle={COMMITMENTS_COPY.neverRunBody}
        variant="dashed"
      />
    )
  }

  return (
    <div className="space-y-3">
      {notice && (
        <p className="text-xs text-sage-600" role="status">
          {notice}
        </p>
      )}

      {outstanding.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title={COMMITMENTS_COPY.emptyTitle}
          subtitle={COMMITMENTS_COPY.emptyBody}
          variant="dashed"
        />
      )}

      {outstanding.map((row) => {
        const busy = busyId === row.id
        return (
          <div key={row.id} className="border border-border rounded-lg p-4 space-y-2 bg-sage-50/40">
            <p className="text-sm text-sage-900">&ldquo;{row.quote}&rdquo;</p>

            {row.judge_reason && (
              <p className="text-xs text-sage-500">
                <span className="font-medium">{COMMITMENTS_COPY.judgeReasonLabel}: </span>
                {row.judge_reason}
              </p>
            )}

            <div className="flex items-center gap-2 flex-wrap pt-1">
              {row.source_interaction_id && onOpenCommunications && (
                <button
                  type="button"
                  onClick={onOpenCommunications}
                  className="inline-flex items-center gap-1 text-xs text-teal-700 hover:underline"
                >
                  <MessageSquare className="w-3 h-3" />
                  {COMMITMENTS_COPY.sourceLink}
                </button>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={() => void addToTimeline(row)}
                className={cn(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border',
                  'bg-sage-100 text-sage-800 border-sage-200 hover:bg-sage-200 transition-colors',
                  busy && 'opacity-60 cursor-not-allowed',
                )}
              >
                {busy && busyAction === 'add' ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Plus className="w-3 h-3" />
                )}
                {busy && busyAction === 'add'
                  ? COMMITMENTS_COPY.addPending
                  : COMMITMENTS_COPY.addAction}
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => void dismiss(row)}
                className={cn(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border',
                  'bg-surface text-sage-600 border-border hover:bg-sage-50 transition-colors',
                  busy && 'opacity-60 cursor-not-allowed',
                )}
              >
                {busy && busyAction === 'dismiss' ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Check className="w-3 h-3" />
                )}
                {busy && busyAction === 'dismiss'
                  ? COMMITMENTS_COPY.dismissPending
                  : COMMITMENTS_COPY.dismissAction}
              </button>
            </div>
          </div>
        )
      })}

      {settled.length > 0 && (
        <div className="pt-3 border-t border-border space-y-1.5">
          {settled.map((row) => (
            <div key={row.id} className="flex items-baseline gap-2 text-xs text-sage-500">
              <span className="truncate flex-1">&ldquo;{row.quote}&rdquo;</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-sage-400">
                {row.status === 'added'
                  ? COMMITMENTS_COPY.addedLabel
                  : COMMITMENTS_COPY.dismissedLabel}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
