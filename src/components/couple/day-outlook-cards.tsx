'use client'

/**
 * The wedding-day weather card and the one planning nudge, on the couple
 * portal home. W52 of NOVEMBER-PLAN.md wave 7.
 *
 * Dumb renderers. Every word comes from
 * `@/lib/services/couple-portal/day-outlook` and
 * `@/lib/intel/adapters/couple-nudge`, which are pure and unit-tested;
 * this file decides nothing and formats nothing. A null card renders as
 * nothing at all rather than as an empty box, because a couple's home
 * page is not a dashboard and an empty box on it reads as a fault.
 *
 * Both cards follow the /whats-next visual pattern (rounded-2xl, ring,
 * icon left, one line of body) and the two-line body cap in
 * docs/couple-portal-design-principles.md.
 */

import Link from 'next/link'
import { ArrowRight, CloudSun, Users } from 'lucide-react'
import type { DayOutlookCard } from '@/lib/services/couple-portal/day-outlook'
import type { CoupleNudge } from '@/lib/intel/adapters/couple-nudge'

export function WeddingDayWeatherCard({ card }: { card: DayOutlookCard | null }) {
  if (!card) return null

  return (
    <div className="flex items-start gap-4 p-5 rounded-2xl ring-1 ring-sage-200 bg-white">
      <CloudSun className="w-6 h-6 text-sage-500 flex-shrink-0 mt-1" aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="text-xs uppercase tracking-wider text-sage-500 mb-1">{card.label}</p>
        <p
          className="text-2xl font-semibold tabular-nums"
          style={{ color: 'var(--couple-primary)' }}
        >
          {card.headline}
        </p>
        <p className="text-sm text-sage-700 mt-1">{card.body}</p>
        <p className="text-xs text-sage-500 mt-1">{card.basis}</p>
      </div>
    </div>
  )
}

const NUDGE_STYLE: Record<CoupleNudge['tone'], { ring: string; bg: string; icon: string }> = {
  gentle: { ring: 'ring-sage-200', bg: 'bg-white', icon: 'text-sage-500' },
  firm: { ring: 'ring-gold-200', bg: 'bg-gold-50', icon: 'text-gold-700' },
}

export function CouplePortalNudgeCard({
  nudge,
  base = '',
}: {
  nudge: CoupleNudge | null
  /** Path prefix for the path-based portal (`/couple/<slug>`). Empty on
   *  the subdomain-served portal, which is already at the root. */
  base?: string
}) {
  if (!nudge) return null
  const style = NUDGE_STYLE[nudge.tone]

  return (
    <Link
      href={`${base}${nudge.href}`}
      className={`flex items-start gap-4 p-5 rounded-2xl ring-1 ${style.ring} ${style.bg} hover:shadow-sm transition-shadow`}
    >
      <Users className={`w-6 h-6 ${style.icon} flex-shrink-0 mt-1`} aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="text-xs uppercase tracking-wider text-sage-500 mb-1">{nudge.label}</p>
        <p className="text-base font-medium text-sage-900">{nudge.body}</p>
        <p className="text-sm text-sage-600 mt-1">{nudge.cta}</p>
      </div>
      <ArrowRight className="w-5 h-5 text-sage-400 flex-shrink-0 mt-2" aria-hidden />
    </Link>
  )
}
