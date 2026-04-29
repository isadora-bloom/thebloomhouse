'use client'

/**
 * Candidate signal evidence widget for the lead detail page (Phase B / PB.10).
 *
 * Surfaces every platform-signal candidate that's been resolved to
 * this wedding, with each candidate's funnel + signal timeline +
 * attribution decision. The widget is the data-reuse principle made
 * visible: signal data captured by Phase A clusterer/resolver shows
 * up here as the "why does this lead have Knot as first-touch"
 * answer.
 *
 * Sections:
 *   - First-touch banner — which platform + which signal won, with
 *     conflict flag if weddings.source disagrees.
 *   - Per-platform candidate cards — funnel depth, action_counts,
 *     timeline of signals, AI reasoning if Tier 2, change button.
 *
 * Empty state: shows nothing when no candidates resolve here. The
 * widget self-hides so the page doesn't get an empty box.
 */

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { Activity, Eye, Bookmark, MessageSquare, MousePointerClick, Star, Phone, Sparkles, AlertTriangle, RotateCcw } from 'lucide-react'

interface AttributionEvent {
  id: string
  candidate_identity_id: string
  signal_id: string | null
  source_platform: string
  confidence: number
  tier: string
  decided_by: string
  decided_at: string
  reasoning: string | null
  is_first_touch: boolean
  bucket: string
  conflict_with_legacy_source: string | null
  reverted_at: string | null
}

interface CandidateIdentity {
  id: string
  source_platform: string
  first_name: string | null
  last_initial: string | null
  state: string | null
  signal_count: number
  funnel_depth: number
  action_counts: Record<string, number> | null
  first_seen: string | null
  last_seen: string | null
  resolved_confidence: number | null
  resolved_by: string | null
}

interface Signal {
  id: string
  signal_date: string | null
  action_class: string | null
  source_context: string | null
}

interface Props {
  weddingId: string
  legacySource: string | null
  onChangeAttribution?: (eventId: string) => void
}

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

function platformLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function actionIcon(action: string) {
  if (action === 'view') return <Eye className="w-3 h-3" />
  if (action === 'save') return <Bookmark className="w-3 h-3" />
  if (action === 'message') return <MessageSquare className="w-3 h-3" />
  if (action === 'click') return <MousePointerClick className="w-3 h-3" />
  if (action === 'review') return <Star className="w-3 h-3" />
  if (action === 'call') return <Phone className="w-3 h-3" />
  return <Activity className="w-3 h-3" />
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  // Format in UTC so all coordinators see the same calendar day for a
  // signal regardless of local timezone. Vendor signal_date is
  // day-precision originally; rendering it in the viewer's local
  // timezone would shift it across the day boundary for users east
  // of the venue.
  const date = new Date(d)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function CandidateSignalEvidence({ weddingId, legacySource, onChangeAttribution }: Props) {
  const [candidates, setCandidates] = useState<CandidateIdentity[]>([])
  const [events, setEvents] = useState<AttributionEvent[]>([])
  const [signalsByCandidate, setSignalsByCandidate] = useState<Record<string, Signal[]>>({})
  const [loading, setLoading] = useState(true)
  const [revertingId, setRevertingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const sb = getSupabase()
    ;(async () => {
      const { data: cands } = await sb
        .from('candidate_identities')
        .select('id, source_platform, first_name, last_initial, state, signal_count, funnel_depth, action_counts, first_seen, last_seen, resolved_confidence, resolved_by')
        .eq('resolved_wedding_id', weddingId)
        .is('deleted_at', null)
      const { data: evts } = await sb
        .from('attribution_events')
        .select('id, candidate_identity_id, signal_id, source_platform, confidence, tier, decided_by, decided_at, reasoning, is_first_touch, bucket, conflict_with_legacy_source, reverted_at')
        .eq('wedding_id', weddingId)
        .is('reverted_at', null)
        .order('decided_at', { ascending: false })

      const candList = (cands ?? []) as CandidateIdentity[]
      const evtList = (evts ?? []) as AttributionEvent[]
      if (cancelled) return
      setCandidates(candList)
      setEvents(evtList)

      const candIds = candList.map((c) => c.id)
      if (candIds.length > 0) {
        const { data: sigs } = await sb
          .from('tangential_signals')
          .select('id, signal_date, action_class, source_context, candidate_identity_id')
          .in('candidate_identity_id', candIds)
          .order('signal_date', { ascending: true })
        if (cancelled) return
        const grouped: Record<string, Signal[]> = {}
        for (const s of (sigs ?? []) as Array<Signal & { candidate_identity_id: string }>) {
          const key = s.candidate_identity_id
          ;(grouped[key] ??= []).push({ id: s.id, signal_date: s.signal_date, action_class: s.action_class, source_context: s.source_context })
        }
        setSignalsByCandidate(grouped)
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [weddingId])

  if (loading) return null
  if (candidates.length === 0 && events.length === 0) return null

  const firstTouchEvent = events.find((e) => e.is_first_touch && e.bucket === 'attribution')
  const conflict = events.find((e) => e.conflict_with_legacy_source && !e.reverted_at)

  async function handleRevert(eventId: string) {
    if (!confirm('Revert this attribution? It stays in the audit trail; first-touch will be recomputed across remaining signals.')) return
    setRevertingId(eventId)
    const res = await fetch('/api/intel/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'revert', attribution_event_id: eventId }),
    })
    if (res.ok) {
      setEvents((prev) => prev.filter((e) => e.id !== eventId))
      onChangeAttribution?.(eventId)
    } else {
      alert('Revert failed.')
    }
    setRevertingId(null)
  }

  async function handleAcceptComputed(eventId: string) {
    if (!confirm('Overwrite leads.source with the computed first-touch platform? Resolves the conflict.')) return
    setRevertingId(eventId)
    const res = await fetch('/api/intel/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept_computed', attribution_event_id: eventId }),
    })
    if (res.ok) {
      setEvents((prev) => prev.map((e) => (e.id === eventId ? { ...e, conflict_with_legacy_source: null } : e)))
      onChangeAttribution?.(eventId)
    } else {
      alert('Update failed.')
    }
    setRevertingId(null)
  }

  async function handleAcceptLegacy(eventId: string) {
    if (!confirm('Keep leads.source as-is and clear this conflict? The attribution row is reverted; first-touch is recomputed.')) return
    setRevertingId(eventId)
    const res = await fetch('/api/intel/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept_legacy', attribution_event_id: eventId }),
    })
    if (res.ok) {
      setEvents((prev) => prev.filter((e) => e.id !== eventId))
      onChangeAttribution?.(eventId)
    } else {
      alert('Update failed.')
    }
    setRevertingId(null)
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h3 className="text-sm font-semibold text-sage-900">Platform signals</h3>
        </div>
        <span className="text-xs text-sage-500">
          {candidates.length} candidate{candidates.length === 1 ? '' : 's'} · {events.length} signal{events.length === 1 ? '' : 's'}
        </span>
      </div>

      {firstTouchEvent && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs">
          <p className="font-medium text-emerald-900">
            First touch: {platformLabel(firstTouchEvent.source_platform)}
          </p>
          <p className="text-emerald-700 mt-0.5">
            {firstTouchEvent.tier.replace(/_/g, ' ')} · confidence {firstTouchEvent.confidence}% · decided by {firstTouchEvent.decided_by}
          </p>
          {firstTouchEvent.reasoning && (
            <p className="text-emerald-700 mt-1 italic">"{firstTouchEvent.reasoning}"</p>
          )}
        </div>
      )}

      {conflict && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-amber-900">Source conflict</p>
            <p className="text-amber-700 mt-0.5">
              Computed: <strong>{conflict.source_platform.replace(/_/g, ' ')}</strong> ·
              Legacy <code className="text-[10px]">leads.source</code>: <strong>{legacySource ?? 'unset'}</strong>.
            </p>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => handleAcceptComputed(conflict.id)}
                disabled={revertingId === conflict.id}
                className="text-xs px-2 py-1 bg-sage-600 text-white rounded hover:bg-sage-700 disabled:opacity-50"
              >
                Use computed
              </button>
              <button
                onClick={() => handleAcceptLegacy(conflict.id)}
                disabled={revertingId === conflict.id}
                className="text-xs px-2 py-1 border border-sage-200 rounded hover:bg-sage-50 text-sage-700 disabled:opacity-50"
              >
                Keep legacy
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {candidates.map((c) => {
          const sigs = signalsByCandidate[c.id] ?? []
          const event = events.find((e) => e.candidate_identity_id === c.id)
          return (
            <div key={c.id} className="border border-sage-100 rounded-lg p-3 bg-white">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-sage-900">
                    {platformLabel(c.source_platform)}
                    {c.state && <span className="text-xs font-normal text-sage-500 ml-2">({c.state.toUpperCase()})</span>}
                  </p>
                  <p className="text-xs text-sage-500 mt-0.5">
                    {c.signal_count} signal{c.signal_count === 1 ? '' : 's'} · funnel depth {c.funnel_depth} ·
                    {' '}{fmtDate(c.first_seen)} → {fmtDate(c.last_seen)}
                  </p>
                </div>
                {event && (
                  <button
                    onClick={() => handleRevert(event.id)}
                    disabled={revertingId === event.id}
                    className="text-xs text-sage-500 hover:text-sage-700 flex items-center gap-1 shrink-0"
                    title="Revert this attribution (stays in audit, recomputes first-touch)"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Change
                  </button>
                )}
              </div>

              {sigs.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {sigs.map((s) => (
                    <span
                      key={s.id}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-sage-50 text-sage-700 border border-sage-100"
                      title={s.source_context ?? ''}
                    >
                      {actionIcon(s.action_class ?? '')}
                      {s.action_class} · {fmtDate(s.signal_date)}
                    </span>
                  ))}
                </div>
              )}

              {c.action_counts && Object.keys(c.action_counts).length > 0 && (
                <div className="mt-2 text-[11px] text-sage-500 flex gap-2 flex-wrap">
                  {Object.entries(c.action_counts).map(([k, v]) => (
                    <span key={k}>
                      <strong>{v}</strong> {k}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
