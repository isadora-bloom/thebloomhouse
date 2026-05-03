/**
 * Shared insight ranking + audience-routing helpers (Stream HHH).
 *
 * Why this exists
 * ---------------
 * Stream YY shipped a coordinator-relevance ranking on
 * /intel/macro-correlations (down-rank macro × macro pairs that
 * coordinators don't act on, boost macro × venue pairs that ARE
 * Bloom's USP signal). That logic lived only in
 * macro-correlations/page.tsx, so the same insight rows on
 * /intel/insights still sorted by raw |r| — pure FRED × FRED noise
 * dominated the top of the list (Stream HHH, Bug 17).
 *
 * The fix: extract the ranking + the audience-routing predicate into
 * one helper everyone calls. Two surfaces now in scope:
 *
 *   1. rankInsightForCoordinator(insight)
 *      Composite score = |r| × pair-class multiplier (when the row is
 *      a correlation/correlation_narration with classified pair) OR
 *      surface_priority (when set) OR confidence × priority weight
 *      (everything else). Higher = surface earlier.
 *
 *   2. isInsightAllowedForSurface(insight, surface)
 *      Audience predicate. Stream HHH Bug 10 — InlineInsightBanner
 *      was rendering top-priority risk insights on EVERY page
 *      (/agent/leads, /agent/inbox, /intel/sources, /intel/tours, …).
 *      Coordinator hit the same "34% of tours canceled" banner six
 *      times in a row and dismissed without reading. The fix is to
 *      route by class:
 *        - high-severity risk insights → /pulse + /intel/dashboard ONLY
 *        - source/channel-specific insights → /intel/sources
 *        - lead-specific insights → /intel/clients/[id] (future)
 *        - everything else respects the surface_layer column from
 *          migration 144 (inline / pulse / digest / on_demand)
 *
 * The component / page passes its `surface` identifier and we filter.
 */

import type { PairClass } from './format-series-label'
import { rankMultiplierForPair, classifyPair } from './format-series-label'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape every caller passes. Matches both
 *  intelligence_insights row + the InsightRow client type. */
export interface RankableInsight {
  insight_type: string
  category: string | null
  priority: 'critical' | 'high' | 'medium' | 'low' | string
  confidence: number | null | undefined
  surface_layer?: string | null
  surface_priority?: number | null
  /** data_points carries pair info for correlation rows
   *  (channelA / channelB / r) AND optional pair_class. */
  data_points?: Record<string, unknown> | null
}

/** Surfaces that render insights. Each has its own audience policy. */
export type InsightSurface =
  | 'pulse'              // /pulse — high-severity risk + critical/high priority
  | 'dashboard'          // /intel/dashboard — same as pulse, daily command center
  | 'sources'            // /intel/sources — channel/source-specific only
  | 'lead_detail'        // /intel/clients/[id] — that lead's insights only
  | 'all_insights'       // /intel/insights — everything, ranked

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
}

/**
 * Composite priority for sorting on coordinator surfaces.
 *
 * Order of precedence:
 *   1. correlation/correlation_narration rows: |r| × pair-class
 *      multiplier × 100. This is the Stream YY rule — kept in one
 *      place so /intel/insights and /intel/macro-correlations agree.
 *   2. surface_priority column (migration 144) when present.
 *   3. priority bucket weight × confidence (fallback for legacy rows).
 *
 * Returns a non-negative number; larger = surface earlier.
 */
export function rankInsightForCoordinator(insight: RankableInsight): number {
  const dp = insight.data_points ?? {}

  // 1. Correlation rows — apply Stream YY pair-class multiplier so
  //    macro × macro sinks below venue-relevant pairs.
  const isCorrelation =
    insight.insight_type === 'correlation' ||
    insight.insight_type === 'correlation_narration'
  if (isCorrelation) {
    const r = Number(dp.r ?? dp.R ?? 0)
    if (Number.isFinite(r) && Math.abs(r) > 0) {
      // Prefer the persisted pair_class on the row (writer guarantees
      // it for new rows). Fall back to classifying the pair from
      // channelA + channelB on legacy rows.
      let pairClass: PairClass | null = null
      const persistedClass = dp.signalClass ?? dp.pair_class ?? dp.pairClass
      if (typeof persistedClass === 'string') {
        pairClass = persistedClass as PairClass
      } else {
        const channelA =
          (dp.channelA as string | undefined) ??
          (dp.channel_a as string | undefined) ??
          null
        const channelB =
          (dp.channelB as string | undefined) ??
          (dp.channel_b as string | undefined) ??
          null
        if (channelA && channelB) {
          pairClass = classifyPair(channelA, channelB)
        }
      }
      const mult = pairClass ? rankMultiplierForPair(pairClass) : 1.0
      return Math.abs(r) * 100 * mult
    }
  }

  // 2. surface_priority (migration 144) — writer of new T3 insights
  //    sets this directly. Trust it when present.
  if (typeof insight.surface_priority === 'number' && Number.isFinite(insight.surface_priority)) {
    return Math.max(0, insight.surface_priority)
  }

  // 3. Legacy fallback — priority bucket × confidence.
  const pw = PRIORITY_WEIGHT[insight.priority ?? 'medium'] ?? 50
  const conf =
    typeof insight.confidence === 'number' && Number.isFinite(insight.confidence)
      ? Math.max(0, Math.min(1, insight.confidence))
      : 0.5
  return pw * conf
}

// ---------------------------------------------------------------------------
// Audience routing
// ---------------------------------------------------------------------------

const HIGH_SEVERITY_TYPES = new Set([
  'risk',
  'risk_flag',
  'anomaly',
  'data_anomaly',
])

const CHANNEL_SOURCE_CATEGORIES = new Set([
  'source_attribution',
  'competitive',
])

const CHANNEL_SOURCE_TYPES = new Set([
  'source_mix_counterfactual',
  'trend',         // platform trend rows (Knot/WW/etc.) live here
  'opportunity',   // CPI growth, channel-mix opportunities
])

/**
 * Decide whether an insight is appropriate for the given coordinator
 * surface.
 *
 * Per Stream HHH Bug 10:
 *   - /pulse + /intel/dashboard: high-severity risks + critical/high
 *     priority insights. The coordinator's "what needs attention"
 *     surfaces.
 *   - /intel/sources: channel/source-specific only (source_attribution
 *     category, or trend/opportunity rows tagged to a source).
 *   - /intel/clients/[id]: the lead's own insights (context_id matches
 *     the wedding id). Currently keyed off category='couple_behavior'
 *     OR the explicit context_id check happens at the page level.
 *   - /intel/insights: catch-all; everything passes.
 */
export function isInsightAllowedForSurface(
  insight: RankableInsight,
  surface: InsightSurface,
): boolean {
  switch (surface) {
    case 'all_insights':
      return true

    case 'pulse':
    case 'dashboard': {
      // High-severity risks always allowed.
      if (HIGH_SEVERITY_TYPES.has(insight.insight_type)) {
        return insight.priority === 'critical' || insight.priority === 'high'
      }
      // Other types only when explicitly routed there via surface_layer
      // OR when priority is critical (anything critical lands on pulse).
      if (insight.priority === 'critical') return true
      const layer = insight.surface_layer
      return layer === 'pulse' || layer === 'inline'
    }

    case 'sources': {
      const cat = insight.category ?? ''
      if (CHANNEL_SOURCE_CATEGORIES.has(cat)) return true
      if (CHANNEL_SOURCE_TYPES.has(insight.insight_type)) {
        // Only when a channel/source is referenced in data_points.
        const dp = insight.data_points ?? {}
        const hasChannel =
          typeof dp.source === 'string' ||
          typeof dp.channel === 'string' ||
          typeof dp.platform === 'string' ||
          typeof dp.channelA === 'string' ||
          typeof dp.channel_a === 'string'
        return hasChannel
      }
      return false
    }

    case 'lead_detail': {
      // Lead-specific insights are filtered on the page itself by
      // context_id. As a coarse predicate, allow couple_behavior +
      // anything routed inline.
      if (insight.category === 'couple_behavior') return true
      return insight.surface_layer === 'inline'
    }

    default:
      return true
  }
}

/**
 * Convenience: filter + sort an insight list for a given coordinator
 * surface in one call. Used by the inline-insight-banner and by
 * /intel/insights.
 */
export function filterAndRankForSurface<T extends RankableInsight>(
  insights: T[],
  surface: InsightSurface,
): T[] {
  return insights
    .filter((it) => isInsightAllowedForSurface(it, surface))
    .sort((a, b) => rankInsightForCoordinator(b) - rankInsightForCoordinator(a))
}
