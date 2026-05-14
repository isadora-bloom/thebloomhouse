import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import {
  inferRecommendationDestination,
  type RecommendationDestination,
} from '@/lib/utils/recommendation-routing'
import { cn } from '@/lib/utils'

/**
 * Renders an LLM-authored recommendation string and (when one can be
 * inferred) a one-click jump to the surface where the operator can act.
 *
 * Pass `destination` directly to override the heuristic — useful when
 * the backend knows the right target (e.g. attribution recommendation
 * that already names a channel slug).
 *
 * No-match is fine: the text renders alone. Never invent destinations.
 */
interface RecommendationProps {
  text: string
  destination?: RecommendationDestination | null
  className?: string
  iconSlot?: React.ReactNode
}

export function Recommendation({
  text,
  destination,
  className,
  iconSlot,
}: RecommendationProps) {
  const dest = destination ?? inferRecommendationDestination(text)
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      {iconSlot ? <div className="flex-shrink-0 mt-0.5">{iconSlot}</div> : null}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-sage-700 leading-relaxed">{text}</p>
        {dest ? (
          <Link
            href={dest.href}
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-sage-700 hover:text-sage-900"
          >
            {dest.label}
            <ArrowRight className="h-3 w-3" />
          </Link>
        ) : null}
      </div>
    </div>
  )
}
