'use client'

import { useEffect, useState } from 'react'
import {
  TrendingUp, AlertTriangle, Target, Lightbulb, BarChart3,
  Activity, ShieldAlert, Sparkles,
  X, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { InsightRow } from './insight-card'
import { usePlanTier } from '@/lib/hooks/use-plan-tier'
import {
  filterAndRankForSurface,
  type InsightSurface,
} from '@/lib/utils/insight-routing'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface InlineInsightBannerProps {
  /**
   * Coordinator surface this banner lives on. Drives the audience
   * predicate per Stream HHH Bug 10:
   *   - 'pulse' / 'dashboard'  → high-severity risk + critical/high
   *   - 'sources'              → channel-specific only
   *   - 'lead_detail'          → that lead's insights
   * Pass the surface that matches the page wrapping the banner.
   */
  surface: InsightSurface
  /** Optional category filter (back-compat). When set, narrows the API
   *  fetch to one category (or comma-separated list). The audience
   *  predicate still applies on top. */
  category?: string
  /** Additional class */
  className?: string
}

// ---------------------------------------------------------------------------
// Type icons
// ---------------------------------------------------------------------------

const TYPE_ICON: Record<string, typeof TrendingUp> = {
  correlation: TrendingUp,
  anomaly: AlertTriangle,
  prediction: Target,
  recommendation: Lightbulb,
  benchmark: BarChart3,
  trend: Activity,
  risk: ShieldAlert,
  opportunity: Sparkles,
}

const PRIORITY_ACCENT: Record<string, { border: string; bg: string; dot: string }> = {
  critical: { border: 'border-red-200', bg: 'bg-red-50/50', dot: 'bg-red-500' },
  high: { border: 'border-amber-200', bg: 'bg-amber-50/50', dot: 'bg-amber-500' },
  medium: { border: 'border-sage-200', bg: 'bg-sage-50/50', dot: 'bg-sage-500' },
  low: { border: 'border-gray-200', bg: 'bg-gray-50/50', dot: 'bg-gray-400' },
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InlineInsightBanner({ surface, category, className }: InlineInsightBannerProps) {
  const [insight, setInsight] = useState<InsightRow | null>(null)
  const [dismissed, setDismissed] = useState(false)
  // Insights live behind a paid tier server-side (requirePlan in
  // /api/intel/insights). Gate the banner by the same check client-side so
  // pre-opening venues don't repeatedly hit a 403 — visible as scary-looking
  // network errors on pages like the Agent Inbox where the banner is
  // embedded by default. When plan_tier is still loading, hold off.
  // Pricing v2 (2026-05-06): every paid tier ('solo' and up) gets all
  // intelligence features. 'pre_opening' is the only tier blocked.
  const { meetsMinimum, loading: planLoading } = usePlanTier()
  const hasIntel = meetsMinimum('solo')

  useEffect(() => {
    if (planLoading) return
    if (!hasIntel) return

    async function fetchInsight() {
      try {
        // Stream HHH Bug 10: fetch a wider candidate set, then filter +
        // rank client-side via the shared audience predicate. This is
        // what keeps the 34%-tour-cancellation banner OFF surfaces it
        // doesn't belong on (every coordinator page) and ON the ones it
        // does (/pulse + /intel/dashboard).
        const candidates: InsightRow[] = []
        if (category) {
          // Back-compat path: caller asked for specific categories.
          const categories = category.split(',').map((c) => c.trim())
          for (const cat of categories) {
            const res = await fetch(`/api/intel/insights?category=${cat}&limit=10`)
            if (!res.ok) continue
            const data = await res.json()
            const rows = (data.insights ?? []) as InsightRow[]
            candidates.push(...rows)
          }
        } else {
          // No category narrowing — pull the top 25 active insights and
          // let the surface predicate decide.
          const res = await fetch(`/api/intel/insights?limit=25`)
          if (!res.ok) return
          const data = await res.json()
          const rows = (data.insights ?? []) as InsightRow[]
          candidates.push(...rows)
        }

        const ranked = filterAndRankForSurface(candidates, surface)
        if (ranked.length > 0) {
          setInsight(ranked[0]!)
        }
      } catch (err) {
        console.error('Failed to fetch inline insight:', err)
      }
    }
    fetchInsight()
  }, [surface, category, hasIntel, planLoading])

  if (!hasIntel || !insight || dismissed) return null

  const accent = PRIORITY_ACCENT[insight.priority] ?? PRIORITY_ACCENT.medium
  const Icon = TYPE_ICON[insight.insight_type] ?? Lightbulb

  async function handleDismiss() {
    setDismissed(true)
    try {
      await fetch(`/api/intel/insights/${insight!.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'seen' }),
      })
    } catch { /* silent */ }
  }

  async function handleAct() {
    setDismissed(true)
    try {
      await fetch(`/api/intel/insights/${insight!.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'acted_on' }),
      })
    } catch { /* silent */ }
  }

  return (
    <div className={cn(
      'flex items-center gap-3 px-4 py-2.5 rounded-lg border transition-all',
      accent.border, accent.bg,
      className,
    )}>
      {/* Priority dot */}
      <div className={cn('w-2 h-2 rounded-full shrink-0', accent.dot)} />

      {/* Icon */}
      <Icon className="w-4 h-4 text-sage-500 shrink-0" />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-sage-800 line-clamp-1">
          <span className="font-medium">{insight.title}</span>
          {insight.action && (
            <span className="text-sage-600"> — {insight.action}</span>
          )}
        </p>
      </div>

      {/* Quick actions */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={handleAct}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-sage-700 bg-white border border-sage-200 rounded-md hover:bg-sage-50 transition-colors"
        >
          <Zap className="w-3 h-3" />
          Act
        </button>
        <button
          onClick={handleDismiss}
          className="p-1 text-sage-400 hover:text-sage-600 transition-colors"
          title="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
