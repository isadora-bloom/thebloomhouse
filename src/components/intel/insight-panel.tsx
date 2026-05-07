'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Lightbulb,
  ArrowRight,
  Sparkles,
} from 'lucide-react'
import { InsightAcknowledge } from './insight-acknowledge'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InsightIcon = 'trend_up' | 'trend_down' | 'warning' | 'tip' | 'action'
export type InsightPriority = 'high' | 'medium' | 'low'

export interface InsightItem {
  icon: InsightIcon
  text: string
  priority?: InsightPriority
  /**
   * Tier-B #64A/#65 — when set together with `key`, this insight becomes
   * "ackable": a small dismiss button appears next to it, and the insight
   * is filtered from render if the venue has an active acknowledgment in
   * intel_acknowledgments. `kind` is the surface scope ("market_pulse"),
   * `key` is the insight instance ("cpi_spike_2026-Q3").
   */
  kind?: string
  key?: string
  /** Default 7 days. Pass higher for monthly-cadence insights. */
  suppressDays?: number
}

interface InsightPanelProps {
  title?: string
  insights: InsightItem[]
  className?: string
  /**
   * When provided, the panel fetches active acknowledgments for this kind
   * once on mount and filters out matching keys before rendering. Pass
   * the surface name (e.g. "market_pulse") to enable per-insight dismiss.
   */
  ackKind?: string
}

// ---------------------------------------------------------------------------
// Icon + color mapping
// ---------------------------------------------------------------------------

const ICON_MAP: Record<InsightIcon, { component: typeof TrendingUp; color: string }> = {
  trend_up:   { component: TrendingUp,     color: 'text-emerald-500' },
  trend_down: { component: TrendingDown,    color: 'text-red-500' },
  warning:    { component: AlertTriangle,   color: 'text-amber-500' },
  tip:        { component: Lightbulb,       color: 'text-blue-500' },
  action:     { component: ArrowRight,      color: 'text-sage-600' },
}

const PRIORITY_BADGE: Record<InsightPriority, string> = {
  high:   'bg-red-50 text-red-600 border-red-200',
  medium: 'bg-amber-50 text-amber-600 border-amber-200',
  low:    'bg-sage-50 text-sage-600 border-sage-200',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InsightPanel({ title, insights, className = '', ackKind }: InsightPanelProps) {
  // Acknowledged keys for this surface. Empty until first fetch resolves.
  // Local state so a fresh dismiss removes the row immediately without a
  // network round-trip.
  const [ackedKeys, setAckedKeys] = useState<Set<string>>(new Set())
  const [acksLoaded, setAcksLoaded] = useState(false)

  useEffect(() => {
    if (!ackKind) {
      setAcksLoaded(true)
      return
    }
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/intel/acknowledge?kind=${encodeURIComponent(ackKind!)}`)
        if (!res.ok) return
        const body = await res.json()
        const keys = new Set<string>(
          (body?.acknowledgments ?? []).map((a: { insight_key: string }) => a.insight_key),
        )
        if (!cancelled) setAckedKeys(keys)
      } catch {
        // Fail-soft. If the fetch fails, all items show. Coordinator can
        // re-dismiss; not load-bearing.
      } finally {
        if (!cancelled) setAcksLoaded(true)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [ackKind])

  // Filter to renderable insights. Items without a key always render.
  const visible = insights.filter((i) => !i.key || !ackedKeys.has(i.key))
  if (!acksLoaded && ackKind) return null
  if (visible.length === 0) return null

  return (
    <div
      className={`relative rounded-xl border border-sage-200 bg-gradient-to-br from-sage-50/80 via-surface to-teal-50/40 shadow-sm overflow-hidden ${className}`}
    >
      {/* Gradient accent bar */}
      <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-sage-400 via-teal-400 to-sage-300" />

      <div className="p-5 pt-6">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-lg" aria-hidden>💡</span>
          <h3 className="font-heading text-sm font-semibold text-sage-800 uppercase tracking-wider">
            {title ?? 'Insights'}
          </h3>
        </div>

        {/* Insight rows */}
        <div className="space-y-3">
          {visible.map((item, idx) => {
            const iconDef = ICON_MAP[item.icon]
            const IconComp = iconDef.component
            const ackable = Boolean(item.kind && item.key)

            return (
              <div key={item.key ?? idx} className="flex items-start gap-3">
                <IconComp className={`w-4 h-4 mt-0.5 shrink-0 ${iconDef.color}`} />
                <p className="text-sm text-sage-700 leading-relaxed flex-1">{item.text}</p>
                {item.priority && (
                  <span
                    className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${PRIORITY_BADGE[item.priority]}`}
                  >
                    {item.priority}
                  </span>
                )}
                {ackable && (
                  <>
                    {/* Tier-B #64C: "Ask Sage" hand-off — opens NLQ page
                        with the insight text pre-filled in the input.
                        Coordinator can refine before sending. */}
                    <Link
                      href={{
                        pathname: '/intel/nlq',
                        query: { prompt: `Tell me more about this: ${item.text}` },
                      }}
                      title="Ask Sage about this"
                      className="p-1.5 rounded-md text-sage-400 hover:text-sage-700 hover:bg-sage-50 shrink-0"
                    >
                      <Sparkles className="w-4 h-4" />
                    </Link>
                    <InsightAcknowledge
                      kind={item.kind!}
                      insightKey={item.key!}
                      suppressDays={item.suppressDays}
                      variant="icon"
                      onAcknowledged={() => {
                        setAckedKeys((prev) => {
                          const next = new Set(prev)
                          next.add(item.key!)
                          return next
                        })
                      }}
                    />
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
