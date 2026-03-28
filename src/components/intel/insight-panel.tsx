'use client'

import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Lightbulb,
  ArrowRight,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InsightIcon = 'trend_up' | 'trend_down' | 'warning' | 'tip' | 'action'
export type InsightPriority = 'high' | 'medium' | 'low'

export interface InsightItem {
  icon: InsightIcon
  text: string
  priority?: InsightPriority
}

interface InsightPanelProps {
  title?: string
  insights: InsightItem[]
  className?: string
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

export function InsightPanel({ title, insights, className = '' }: InsightPanelProps) {
  if (insights.length === 0) return null

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
          {insights.map((item, idx) => {
            const iconDef = ICON_MAP[item.icon]
            const IconComp = iconDef.component

            return (
              <div key={idx} className="flex items-start gap-3">
                <IconComp className={`w-4 h-4 mt-0.5 shrink-0 ${iconDef.color}`} />
                <p className="text-sm text-sage-700 leading-relaxed flex-1">{item.text}</p>
                {item.priority && (
                  <span
                    className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${PRIORITY_BADGE[item.priority]}`}
                  >
                    {item.priority}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
