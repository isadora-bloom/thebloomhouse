'use client'

/**
 * Heat history panel for the lead detail page (Connective II / fix #8).
 *
 * heat-mapping snapshots every recalc to lead_score_history. Until
 * now, the data sat unread. This panel makes it legible: shows the
 * score over time + the engagement events that landed between
 * snapshots, so coordinators can see "why did this lead get hot"
 * answered concretely instead of guessing.
 *
 * Self-hides when there are fewer than 2 snapshots (no delta to show).
 */

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { TrendingUp, TrendingDown, Flame, ChevronRight } from 'lucide-react'

interface SnapshotRow {
  score: number
  temperature_tier: string | null
  calculated_at: string
}

interface EventRow {
  event_type: string
  points: number
  occurred_at: string | null
  created_at: string
  metadata: Record<string, unknown> | null
}

interface Props {
  weddingId: string
}



function fmtDateTime(d: string): string {
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function eventLabel(eventType: string): string {
  return eventType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function HeatHistoryPanel({ weddingId }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const sb = createClient()
    ;(async () => {
      setLoading(true)
      const [snapsRes, eventsRes] = await Promise.all([
        sb
          .from('lead_score_history')
          .select('score, temperature_tier, calculated_at')
          .eq('wedding_id', weddingId)
          .order('calculated_at', { ascending: false })
          .limit(20),
        sb
          .from('engagement_events')
          .select('event_type, points, occurred_at, created_at, metadata')
          .eq('wedding_id', weddingId)
          .gt('points', 0)
          .order('occurred_at', { ascending: false, nullsFirst: false })
          .limit(15),
      ])
      if (cancelled) return
      setSnapshots((snapsRes.data ?? []) as SnapshotRow[])
      setEvents((eventsRes.data ?? []) as EventRow[])
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [weddingId])

  if (loading) return null
  if (snapshots.length < 2) return null

  const latest = snapshots[0]
  const previous = snapshots[1]
  const delta = latest.score - previous.score
  // T5-Rixey-III bug 9: always render the delta as `+N`, `-N`, or `±0`
  // (never the descriptive fallback "flat"). The "since last snapshot"
  // window matches the Recent Snapshots list below — both diff against
  // the immediately prior lead_score_history row, NOT a fixed 7d/30d
  // window. The score-over-time table in the expanded view uses the
  // same comparison so the chip number lines up with the first delta
  // in that list.
  const deltaSign = delta > 0 ? '+' : delta < 0 ? '' : '±'
  const deltaLabel = `${deltaSign}${delta} since last snapshot`
  const deltaColor =
    delta > 0 ? 'text-emerald-700' : delta < 0 ? 'text-rose-700' : 'text-sage-500'
  const TrendIcon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : null
  const trendIconColor =
    delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-rose-600' : ''

  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Flame className="w-4 h-4 text-sage-500 shrink-0" />
          <h3 className="text-sm font-semibold text-sage-900">Heat history</h3>
          <span
            className="text-xs text-sage-500 ml-2 inline-flex items-center gap-1"
            title="Change in lead score from the previous lead_score_history snapshot. Snapshots are written each recalc, not on a fixed cadence — so 'since last snapshot' can be hours or days depending on activity."
          >
            {TrendIcon && <TrendIcon className={`w-3 h-3 ${trendIconColor}`} />}
            <span className={deltaColor}>{deltaLabel}</span>
          </span>
        </div>
        <ChevronRight className={`w-4 h-4 text-sage-500 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {expanded && (
        <div className="mt-4 space-y-3">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-sage-500 mb-2">Recent snapshots</p>
            <div className="space-y-1">
              {snapshots.slice(0, 6).map((snap, i) => {
                const prev = snapshots[i + 1]
                const change = prev ? snap.score - prev.score : null
                return (
                  <div key={snap.calculated_at} className="flex items-center justify-between text-xs px-2 py-1 hover:bg-sage-50/50 rounded">
                    <span className="text-sage-500">{fmtDateTime(snap.calculated_at)}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-sage-900 tabular-nums">{snap.score}</span>
                      {change !== null && (
                        <span className={`text-[10px] tabular-nums ${change > 0 ? 'text-emerald-600' : change < 0 ? 'text-rose-600' : 'text-sage-400'}`}>
                          {change > 0 ? '+' : ''}{change}
                        </span>
                      )}
                      {snap.temperature_tier && (
                        <span className="text-[10px] text-sage-400 capitalize">{snap.temperature_tier}</span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {events.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-sage-500 mb-2">Top point-bearing events</p>
              <div className="space-y-1">
                {events.slice(0, 8).map((e, i) => (
                  <div key={i} className="flex items-center justify-between text-xs px-2 py-1 hover:bg-sage-50/50 rounded">
                    <span className="text-sage-700 truncate">{eventLabel(e.event_type)}</span>
                    <span className="flex items-center gap-3 shrink-0">
                      <span className="text-emerald-700 tabular-nums">+{e.points}</span>
                      <span className="text-[10px] text-sage-400">{fmtDateTime(e.occurred_at ?? e.created_at)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
