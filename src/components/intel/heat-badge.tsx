/**
 * HeatBadge — single primitive for rendering a wedding's heat
 * tier + score across every surface (/agent/leads, /agent/pipeline,
 * /intel/clients/[id], /agent/inbox future).
 *
 * Pre-fix three surfaces each had their own switch / inline rendering.
 * Same 'cold' tier rendered three different blue shades depending on
 * which page. Now: TIER_STYLES is the source of truth, this component
 * is the renderer. ARCH-20.2.1.
 *
 * Variants:
 *   - 'pill'   (default): rounded pill with flame icon + score, used
 *               in lists where heat is the primary signal
 *   - 'dot'    : 2.5×2.5 colored dot, used in dense pipeline cards
 *               where space is tight
 *   - 'inline' : flame + score + tier label, used in detail headers
 *               where the tier name itself adds context
 *   - 'large'  : 4xl score for the top of detail pages
 */

import { Flame } from 'lucide-react'
import { styleForTier } from '@/lib/heat/tier-colors'

export interface HeatBadgeProps {
  tier: string | null | undefined
  score: number | null | undefined
  variant?: 'pill' | 'dot' | 'inline' | 'large'
  /** Optional extra classes appended to the rendered element. */
  className?: string
  /** Tooltip text (defaults to "<tier> (<score>)"). */
  title?: string
}

export function HeatBadge({ tier, score, variant = 'pill', className, title }: HeatBadgeProps) {
  const style = styleForTier(tier)
  const safeScore = typeof score === 'number' ? score : 0
  const ttl = title ?? `${style.label} (${safeScore})`

  if (variant === 'dot') {
    return (
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full ${style.dotBg} ${className ?? ''}`}
        title={ttl}
      />
    )
  }

  if (variant === 'inline') {
    return (
      <span
        className={`inline-flex items-center gap-1 text-sm font-bold ${style.text} ${className ?? ''}`}
        title={ttl}
      >
        <Flame className="w-4 h-4" />
        {safeScore} <span className="font-medium">{style.label}</span>
      </span>
    )
  }

  if (variant === 'large') {
    return (
      <div className={`flex items-baseline gap-2 ${className ?? ''}`} title={ttl}>
        <Flame className={`w-5 h-5 ${style.text}`} />
        <span className={`text-4xl font-bold ${style.text}`}>{safeScore}</span>
        <span className={`text-sm font-medium ${style.text}`}>{style.label}</span>
      </div>
    )
  }

  // 'pill'
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${style.bg} ${style.text} ${className ?? ''}`}
      title={ttl}
    >
      <Flame className="w-3 h-3" />
      {safeScore}
    </span>
  )
}
