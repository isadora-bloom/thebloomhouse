'use client'

import { useEffect, useState } from 'react'
import {
  History,
  Inbox,
  Send,
  Bot,
  Flame,
  GitMerge,
  Sparkles,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Calendar,
  FileSignature,
  Mail,
  Activity,
  Tag,
  Loader2,
} from 'lucide-react'

/**
 * Wedding journey timeline — renders a chronological feed of every
 * meaningful event for one couple. Drop-in component: pass a
 * weddingId, it fetches /api/agent/leads/[id]/journey and renders.
 *
 * Categories are color-coded so a coordinator can scan the spine of
 * the journey at a glance:
 *   - funnel_step (sage)        — Inquiry / Tour booked / Proposal / Booked
 *   - communication (blue)      — emails received and sent
 *   - ai_draft (purple)         — AI draft lifecycle
 *   - engagement_signal (gold)  — heat-internal signals (high specificity, etc.)
 *   - status_change (teal)      — explicit status transitions
 *   - identity_merge (rose)     — people-record dedup audit
 *   - tangential_signal (slate) — Instagram / review / referral matches
 *   - milestone (sage)          — first_response_at / lost_at
 */

type JourneyCategory =
  | 'funnel_step'
  | 'communication'
  | 'ai_draft'
  | 'engagement_signal'
  | 'status_change'
  | 'identity_merge'
  | 'tangential_signal'
  | 'milestone'

type JourneyActor = 'couple' | 'venue' | 'ai' | 'system' | 'coordinator' | 'unknown'

interface JourneyEvent {
  id: string
  timestamp: string
  category: JourneyCategory
  title: string
  description?: string
  source?: string | null
  actor: JourneyActor
  evidence?: Record<string, unknown>
}

interface CategoryStyle {
  bg: string
  text: string
  Icon: typeof History
  label: string
}

const CATEGORY_STYLE: Record<JourneyCategory, CategoryStyle> = {
  funnel_step:        { bg: 'bg-sage-100',    text: 'text-sage-700',    Icon: ArrowRight,     label: 'Funnel' },
  communication:      { bg: 'bg-blue-100',    text: 'text-blue-700',    Icon: Mail,           label: 'Email' },
  ai_draft:           { bg: 'bg-purple-100',  text: 'text-purple-700',  Icon: Bot,            label: 'AI' },
  engagement_signal:  { bg: 'bg-amber-100',   text: 'text-amber-700',   Icon: Flame,          label: 'Signal' },
  status_change:      { bg: 'bg-teal-100',    text: 'text-teal-700',    Icon: Activity,       label: 'Status' },
  identity_merge:     { bg: 'bg-rose-100',    text: 'text-rose-700',    Icon: GitMerge,       label: 'Merge' },
  tangential_signal:  { bg: 'bg-slate-100',   text: 'text-slate-700',   Icon: Sparkles,       label: 'Cross-source' },
  milestone:          { bg: 'bg-sage-50',     text: 'text-sage-600',    Icon: Tag,            label: 'Milestone' },
}

const ACTOR_LABEL: Record<JourneyActor, string> = {
  couple: 'Couple',
  venue: 'Venue',
  ai: 'AI',
  system: 'System',
  coordinator: 'Coordinator',
  unknown: '—',
}

const SOURCE_LABEL: Record<string, string> = {
  the_knot: 'The Knot',
  wedding_wire: 'Wedding Wire',
  here_comes_the_guide: 'Here Comes The Guide',
  zola: 'Zola',
  website: 'Website',
  venue_calculator: 'Venue Calculator',
  instagram: 'Instagram',
  facebook: 'Facebook',
  google: 'Google',
  referral: 'Word of Mouth',
  walk_in: 'Walk-in',
  direct: 'Direct',
  calendly: 'Calendly',
  acuity: 'Acuity',
  honeybook: 'HoneyBook',
  dubsado: 'Dubsado',
  other: 'Other',
}

function formatSource(s: string | null | undefined): string | null {
  if (!s) return null
  return SOURCE_LABEL[s] ?? s.replace(/_/g, ' ')
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

interface Props {
  weddingId: string
  /** Cap shown rows. Defaults to 200 — most weddings have <50 events. */
  initialLimit?: number
  /** Optional category filter. If omitted, all categories shown. */
  categories?: JourneyCategory[]
}

export function WeddingJourney({ weddingId, initialLimit = 200, categories }: Props) {
  const [events, setEvents] = useState<JourneyEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [activeCategories, setActiveCategories] = useState<Set<JourneyCategory>>(
    new Set<JourneyCategory>(categories ?? Object.keys(CATEGORY_STYLE) as JourneyCategory[])
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/agent/leads/${weddingId}/journey`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: { events: JourneyEvent[] }) => {
        if (cancelled) return
        setEvents(json.events ?? [])
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Failed to load journey', err)
        setError('Failed to load journey')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [weddingId])

  const filtered = events.filter((e) => activeCategories.has(e.category))
  const visible = showAll ? filtered : filtered.slice(0, initialLimit)

  const counts: Partial<Record<JourneyCategory, number>> = {}
  for (const e of events) counts[e.category] = (counts[e.category] ?? 0) + 1

  function toggleCategory(c: JourneyCategory) {
    setActiveCategories((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 flex items-center gap-2 text-sm text-sage-600">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading journey…
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
        {error}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center">
        <History className="w-8 h-8 text-sage-300 mx-auto mb-2" />
        <p className="text-sm text-sage-500">No journey events recorded yet.</p>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2">
          <History className="w-4 h-4 text-teal-500" />
          Lead Journey
          <span className="text-xs font-normal text-sage-500">
            · {events.length} events
          </span>
        </h2>
      </div>

      {/* Category chip filter — let the coordinator focus on one type */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-1.5 flex-wrap">
        {(Object.keys(CATEGORY_STYLE) as JourneyCategory[]).map((c) => {
          const style = CATEGORY_STYLE[c]
          const count = counts[c] ?? 0
          if (count === 0) return null
          const active = activeCategories.has(c)
          return (
            <button
              key={c}
              onClick={() => toggleCategory(c)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium transition-opacity ${
                active ? `${style.bg} ${style.text}` : 'bg-sage-50 text-sage-400 opacity-60'
              }`}
              title={active ? 'Click to hide' : 'Click to show'}
            >
              <style.Icon className="w-3 h-3" />
              {style.label}
              <span className="font-normal">· {count}</span>
            </button>
          )
        })}
      </div>

      {/* Timeline rows */}
      <div className="px-6 py-4 max-h-[700px] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="text-center text-sm text-sage-500 py-6">
            All categories filtered out — toggle a chip above to show events.
          </div>
        ) : (
          <div className="relative">
            <div className="absolute left-[15px] top-2 bottom-2 w-[2px] bg-sage-100" aria-hidden />
            <div className="space-y-3">
              {visible.map((e) => {
                const style = CATEGORY_STYLE[e.category]
                const sourceLabel = formatSource(e.source)
                return (
                  <div key={e.id} className="flex gap-3 relative">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 z-10 ${style.bg} ${style.text}`}
                      aria-hidden
                    >
                      <style.Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0 pb-1">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-sage-900 leading-snug">
                            {e.title}
                          </p>
                          {e.description && (
                            <p className="text-xs text-sage-600 mt-0.5 line-clamp-2">
                              {e.description}
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-1 text-[11px] text-sage-500">
                            <span>{ACTOR_LABEL[e.actor]}</span>
                            {sourceLabel && (
                              <>
                                <span aria-hidden>·</span>
                                <span className="font-medium">{sourceLabel}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <span className="text-[10px] text-sage-400 whitespace-nowrap shrink-0 mt-0.5 text-right">
                          {formatTimestamp(e.timestamp)}
                          <br />
                          {formatTime(e.timestamp)}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            {filtered.length > initialLimit && !showAll && (
              <button
                onClick={() => setShowAll(true)}
                className="mt-4 w-full text-center py-2 text-xs font-medium text-sage-600 hover:text-sage-900 hover:bg-sage-50 rounded transition-colors"
              >
                Show all {filtered.length} events
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Re-export pruned icon set so tree-shaking still works for callers
// that pull only the component.
export { Inbox, Send, CheckCircle2, XCircle, Calendar, FileSignature }
