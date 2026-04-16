'use client'

import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutcomeVerdict = 'improved' | 'unchanged' | 'declined' | 'pending'

interface InsightOutcomeBadgeProps {
  verdict: OutcomeVerdict
  improvementPct?: number | null
  className?: string
}

// ---------------------------------------------------------------------------
// Verdict styles
// ---------------------------------------------------------------------------

const VERDICT_CONFIG: Record<
  OutcomeVerdict,
  {
    icon: typeof TrendingUp
    bg: string
    text: string
    label: string
  }
> = {
  improved: {
    icon: TrendingUp,
    bg: 'bg-emerald-50 border-emerald-200',
    text: 'text-emerald-700',
    label: 'Improved',
  },
  unchanged: {
    icon: Minus,
    bg: 'bg-gray-50 border-gray-200',
    text: 'text-gray-600',
    label: 'No change',
  },
  declined: {
    icon: TrendingDown,
    bg: 'bg-red-50 border-red-200',
    text: 'text-red-700',
    label: 'Declined',
  },
  pending: {
    icon: Minus,
    bg: 'bg-amber-50 border-amber-200',
    text: 'text-amber-600',
    label: 'Tracking',
  },
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * InsightOutcomeBadge — displays on insight cards when an outcome
 * has been measured after the coordinator acted on the insight.
 *
 * Usage:
 *   <InsightOutcomeBadge verdict="improved" improvementPct={32.5} />
 *   <InsightOutcomeBadge verdict="declined" improvementPct={-15.2} />
 *   <InsightOutcomeBadge verdict="unchanged" />
 *   <InsightOutcomeBadge verdict="pending" />
 *
 * TODO: Import this component into the InsightCard component (being built
 * by another agent). Show it when an insight has an associated outcome
 * with a non-null verdict.
 */
export function InsightOutcomeBadge({
  verdict,
  improvementPct,
  className = '',
}: InsightOutcomeBadgeProps) {
  const config = VERDICT_CONFIG[verdict]
  if (!config) return null

  const Icon = config.icon
  const pctText =
    improvementPct != null
      ? ` ${improvementPct > 0 ? '+' : ''}${Math.round(improvementPct)}%`
      : ''

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${config.bg} ${config.text} ${className}`}
    >
      <Icon className="w-3 h-3" />
      {config.label}
      {pctText}
    </span>
  )
}
