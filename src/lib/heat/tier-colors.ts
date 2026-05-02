/**
 * Single source of truth for heat tier → color mapping.
 *
 * Pre-fix three surfaces (/agent/leads, /agent/pipeline,
 * /intel/clients/[id]) each redeclared their own switch / const.
 * Drift happened: pipeline used bg-blue-500 / cold=bg-blue-800,
 * leads used color: '#3B82F6' / cold: '#1E40AF', intel used
 * text-blue-500 / text-blue-800. Same 'cold' tier rendered three
 * different shades depending on which page. ARCH-20.2.1.
 *
 * The HeatBadge component wraps this map in renderable variants.
 */

export type HeatTier = 'hot' | 'warm' | 'cool' | 'cold' | 'frozen'

export interface TierStyle {
  /** Display label (capitalised). */
  label: string
  /** Hex color for inline dot / sparkline / mini-chart. */
  color: string
  /** Tailwind background class for pill backgrounds. */
  bg: string
  /** Tailwind text color class. */
  text: string
  /** Tailwind background class for solid dot indicator. */
  dotBg: string
  /** Tailwind border-color class. */
  border: string
}

/** Authoritative tier styles. Any new heat surface uses this map. */
export const TIER_STYLES: Record<HeatTier, TierStyle> = {
  hot: {
    label: 'Hot',
    color: '#EF4444',
    bg: 'bg-red-50',
    text: 'text-red-700',
    dotBg: 'bg-red-500',
    border: 'border-red-200',
  },
  warm: {
    label: 'Warm',
    color: '#F59E0B',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    dotBg: 'bg-amber-500',
    border: 'border-amber-200',
  },
  cool: {
    label: 'Cool',
    color: '#3B82F6',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    dotBg: 'bg-blue-500',
    border: 'border-blue-200',
  },
  cold: {
    label: 'Cold',
    color: '#1E40AF',
    bg: 'bg-blue-100',
    text: 'text-blue-800',
    dotBg: 'bg-blue-800',
    border: 'border-blue-300',
  },
  frozen: {
    label: 'Frozen',
    color: '#6B7280',
    bg: 'bg-gray-50',
    text: 'text-gray-600',
    dotBg: 'bg-gray-400',
    border: 'border-gray-200',
  },
}

/** Fallback for unknown tiers (legacy data). */
export const UNKNOWN_TIER_STYLE: TierStyle = {
  label: 'Unknown',
  color: '#6B7280',
  bg: 'bg-sage-50',
  text: 'text-sage-600',
  dotBg: 'bg-sage-300',
  border: 'border-sage-200',
}

export function styleForTier(tier: string | null | undefined): TierStyle {
  if (!tier) return UNKNOWN_TIER_STYLE
  const t = tier.toLowerCase()
  if (t in TIER_STYLES) return TIER_STYLES[t as HeatTier]
  return UNKNOWN_TIER_STYLE
}
