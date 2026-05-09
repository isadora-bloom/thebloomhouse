'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Activity, AlertTriangle, Bot, Hand, Webhook, Clock, Loader2 } from 'lucide-react'

// ---------------------------------------------------------------------------
// Lifecycle History feed.
// ---------------------------------------------------------------------------
//
// Renders the wedding_lifecycle_events rows (migration 246) for one
// wedding, newest-first. Each row shows: signal -> status_from ->
// status_to with reason and a detected_by chip. Coordinator can read
// the chain end-to-end ("AI saw a decline on May 3 -> wedding moved to
// lost -> coordinator didn't override"), which closes the feedback loop
// the engine + detector + writer chain implements.
//
// Read-only on purpose: there is no override action here (yet). A
// coordinator who disagrees with a transition opens the lead and uses
// the existing mark-as-* actions; this surface is forensic, not
// editorial.

interface EventRow {
  id: string
  signal: string
  status_from: string | null
  status_to: string | null
  reason: string | null
  detected_by: string
  source_interaction_id: string | null
  confidence: number | null
  created_at: string
}

interface Props {
  weddingId: string
  venueId: string
}

function fmt(dt: string) {
  return new Date(dt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function detectorIcon(detectedBy: string) {
  if (detectedBy === 'ai') return Bot
  if (detectedBy === 'coordinator') return Hand
  if (detectedBy === 'webhook') return Webhook
  if (detectedBy === 'cron') return Clock
  return Activity
}

function detectorLabel(detectedBy: string): string {
  switch (detectedBy) {
    case 'ai':
      return 'AI'
    case 'pipeline':
      return 'Pipeline'
    case 'coordinator':
      return 'Coordinator'
    case 'webhook':
      return 'Webhook'
    case 'cron':
      return 'Cron'
    case 'backfill':
      return 'Backfill'
    default:
      return detectedBy
  }
}

function isViolation(signal: string): boolean {
  return signal.startsWith('violation:')
}

function prettySignal(signal: string): string {
  const v = isViolation(signal) ? signal.slice('violation:'.length) : signal
  return v.replace(/_/g, ' ')
}

function prettyStatus(s: string | null): string {
  if (!s) return ''
  return s.replace(/_/g, ' ')
}

export function LifecycleHistory({ weddingId, venueId }: Props) {
  const [rows, setRows] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data } = await supabase
      .from('wedding_lifecycle_events')
      .select('id, signal, status_from, status_to, reason, detected_by, source_interaction_id, confidence, created_at')
      .eq('wedding_id', weddingId)
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false })
      .limit(100)
    setRows((data ?? []) as EventRow[])
    setLoading(false)
  }, [weddingId, venueId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-sage-500 py-6">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading lifecycle history...
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-sage-200 bg-warm-white p-6 text-sm text-sage-600">
        No lifecycle events recorded yet. Transitions appear here as Sage detects
        decline / booking / tour signals on this thread, or when a coordinator marks
        the wedding as booked / lost manually.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-sage-600">
        Newest first. Each row is one detected lifecycle signal. Violations (AI fired
        a transition the engine refused, e.g. contract_signed on a lost wedding) are
        shown amber so coordinators can reconcile drift.
      </p>
      <ul className="space-y-2">
        {rows.map((r) => {
          const violation = isViolation(r.signal)
          const Icon = violation ? AlertTriangle : detectorIcon(r.detected_by)
          return (
            <li
              key={r.id}
              className={
                'rounded-lg border p-3 text-sm ' +
                (violation
                  ? 'border-amber-300 bg-amber-50'
                  : 'border-sage-200 bg-warm-white')
              }
            >
              <div className="flex items-start gap-3">
                <div
                  className={
                    'mt-0.5 inline-flex w-7 h-7 items-center justify-center rounded-full ' +
                    (violation
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-sage-100 text-sage-700')
                  }
                >
                  <Icon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sage-900">
                      {prettySignal(r.signal)}
                    </span>
                    {r.status_from || r.status_to ? (
                      <span className="text-sage-500">
                        {prettyStatus(r.status_from)}
                        {' -> '}
                        {r.status_to ? prettyStatus(r.status_to) : 'no transition'}
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs text-sage-500">
                      {fmt(r.created_at)}
                    </span>
                  </div>
                  {r.reason ? (
                    <p className="mt-1 text-sage-700">{r.reason}</p>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-sage-500">
                    <span className="inline-flex items-center gap-1 rounded-full bg-sage-100 px-2 py-0.5 text-sage-700">
                      {detectorLabel(r.detected_by)}
                    </span>
                    {r.confidence != null ? (
                      <span className="rounded-full bg-sage-50 px-2 py-0.5">
                        {Math.round(r.confidence)}% conf
                      </span>
                    ) : null}
                    {violation ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">
                        engine refused
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
