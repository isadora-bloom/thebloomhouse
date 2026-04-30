'use client'

/**
 * Commitment Signals panel for the lead detail page (Connective II / fix #5).
 *
 * The classifier + signal-inference fire engagement_events when a
 * lead exhibits qualitative commitment cues — tour request, high
 * specificity (mentions a date / guest count), family mentions,
 * sustained engagement (5+ inbound replies), high commitment
 * (coordinator has invested 3+ outbounds).
 *
 * Lead detail used to render these as flat rows in a chronological
 * feed. Coordinator couldn't see at-a-glance "this couple has 4 of
 * 5 commitment signals." This panel makes that legible: each
 * signal is a checklist item with the email phrase that fired it.
 *
 * Self-hides when no commitment signals have fired for this lead.
 */

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { Sparkles, Check, MessageCircle } from 'lucide-react'

interface SignalCatalogItem {
  eventType: string
  label: string
  hint: string
}

const COMMITMENT_SIGNALS: SignalCatalogItem[] = [
  { eventType: 'tour_requested', label: 'Tour requested', hint: 'Asked for a date / time / availability' },
  { eventType: 'high_commitment_signal', label: 'High commitment', hint: 'Sustained back-and-forth with the venue (3+ replies from us)' },
  { eventType: 'high_specificity', label: 'Date specificity', hint: 'Mentioned a specific wedding date or guest count' },
  { eventType: 'family_mentioned', label: 'Family mentioned', hint: 'Referenced parents / siblings / relationship context' },
  { eventType: 'sustained_engagement', label: 'Sustained engagement', hint: '5+ inbound emails on this thread' },
]

interface EngagementEvent {
  id: string
  event_type: string
  metadata: Record<string, unknown> | null
  occurred_at: string | null
  created_at: string
}

interface InteractionLite {
  id: string
  subject: string | null
  body_preview: string | null
  timestamp: string
}

interface Props {
  weddingId: string
}

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

function fmtDate(d: string | null): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function CommitmentSignalsPanel({ weddingId }: Props) {
  const [events, setEvents] = useState<EngagementEvent[]>([])
  const [interactions, setInteractions] = useState<Record<string, InteractionLite>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const sb = getSupabase()
    ;(async () => {
      setLoading(true)
      const eventTypes = COMMITMENT_SIGNALS.map((s) => s.eventType)
      const { data: eventRows } = await sb
        .from('engagement_events')
        .select('id, event_type, metadata, occurred_at, created_at')
        .eq('wedding_id', weddingId)
        .in('event_type', eventTypes)
        .order('occurred_at', { ascending: true, nullsFirst: false })
      if (cancelled) return
      const fired = (eventRows ?? []) as EngagementEvent[]
      setEvents(fired)

      // Pull the interaction (email) that fired each signal so we
      // can show the email subject / phrase as evidence.
      const interactionIds = Array.from(
        new Set(
          fired
            .map((e) => (e.metadata?.interaction_id as string | undefined))
            .filter((v): v is string => Boolean(v)),
        ),
      )
      if (interactionIds.length > 0) {
        const { data: ixRows } = await sb
          .from('interactions')
          .select('id, subject, body_preview, timestamp')
          .in('id', interactionIds)
        if (cancelled) return
        const map: Record<string, InteractionLite> = {}
        for (const ix of (ixRows ?? []) as InteractionLite[]) map[ix.id] = ix
        setInteractions(map)
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [weddingId])

  if (loading) return null
  if (events.length === 0) return null

  const firstFire = new Map<string, EngagementEvent>()
  for (const e of events) if (!firstFire.has(e.event_type)) firstFire.set(e.event_type, e)
  const firedCount = firstFire.size
  const totalCount = COMMITMENT_SIGNALS.length

  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h3 className="text-sm font-semibold text-sage-900">Commitment signals</h3>
        </div>
        <span className="text-xs text-sage-500 tabular-nums">
          {firedCount}/{totalCount}
        </span>
      </div>
      <div className="space-y-2">
        {COMMITMENT_SIGNALS.map((sig) => {
          const fired = firstFire.get(sig.eventType)
          const interactionId = fired?.metadata?.interaction_id as string | undefined
          const ix = interactionId ? interactions[interactionId] : undefined
          return (
            <div
              key={sig.eventType}
              className={`flex items-start gap-2.5 p-2 rounded-md border ${
                fired ? 'border-emerald-100 bg-emerald-50/30' : 'border-sage-100 bg-warm-white'
              }`}
            >
              <div className={`mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${
                fired ? 'bg-emerald-500 text-white' : 'border border-sage-200 bg-surface'
              }`}>
                {fired && <Check className="w-3 h-3" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-xs font-medium ${fired ? 'text-emerald-900' : 'text-sage-500'}`}>
                  {sig.label}
                  {fired && fired.occurred_at && (
                    <span className="ml-2 text-[10px] font-normal text-emerald-700">
                      {fmtDate(fired.occurred_at)}
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-sage-500 mt-0.5">{sig.hint}</p>
                {fired && ix && (
                  <p className="text-[11px] text-sage-700 mt-1 italic flex items-start gap-1">
                    <MessageCircle className="w-3 h-3 mt-0.5 shrink-0 text-sage-400" />
                    <span className="truncate">
                      "{ix.subject ?? ix.body_preview?.slice(0, 80) ?? 'this email'}"
                    </span>
                  </p>
                )}
                {fired && fired.event_type === 'sustained_engagement' && typeof fired.metadata?.inbound_count === 'number' && (
                  <p className="text-[11px] text-sage-700 mt-1">
                    {fired.metadata.inbound_count} inbound emails
                  </p>
                )}
                {fired && fired.event_type === 'high_commitment_signal' && typeof fired.metadata?.outbound_count === 'number' && (
                  <p className="text-[11px] text-sage-700 mt-1">
                    {fired.metadata.outbound_count} outbound replies from venue
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
