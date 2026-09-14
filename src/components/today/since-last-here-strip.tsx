import Link from 'next/link'
import { Inbox, Send, Clock3, AlertOctagon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { SinceLastHereKey, SinceLastHereStrip } from '@/lib/intel/adapters/since-last-here'

/**
 * "Since you were last here" — /today, above the four triage blocks
 * (W42, Monday-walkthrough audit). Server component, no client JS.
 *
 * Four counts, each one a headline for a real list (`href`), each with
 * its rule available on hover (`title`) so the number is never just a
 * number. A quiet window still says something — see `strip.allZero`.
 */

const ICONS: Record<SinceLastHereKey, LucideIcon> = {
  arrived: Inbox,
  autoSent: Send,
  waiting: Clock3,
  failed: AlertOctagon,
}

const ACCENT: Record<SinceLastHereKey, { chip: string; icon: string }> = {
  arrived: { chip: 'bg-sage-100 text-sage-800', icon: 'bg-sage-50 text-sage-600' },
  autoSent: { chip: 'bg-teal-100 text-teal-800', icon: 'bg-teal-50 text-teal-600' },
  waiting: { chip: 'bg-amber-100 text-amber-800', icon: 'bg-amber-50 text-amber-700' },
  failed: { chip: 'bg-rose-100 text-rose-800', icon: 'bg-rose-50 text-rose-700' },
}

export function SinceLastHereStripCard({ strip }: { strip: SinceLastHereStrip }) {
  return (
    <section
      aria-labelledby="since-last-here-title"
      className="bg-surface border border-border rounded-xl p-4 sm:p-5"
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 id="since-last-here-title" className="font-heading text-lg font-semibold text-sage-900">
          Since you were last here
        </h2>
        <p className="text-xs text-sage-500">{strip.windowLabel}</p>
      </div>

      {strip.allZero ? (
        <p className="mt-2 text-sm text-sage-600">
          Nothing landed in that window. A quiet stretch, not a broken one.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {strip.items.map((item) => {
            const Icon = ICONS[item.key]
            const accent = ACCENT[item.key]
            return (
              <Link
                key={item.key}
                href={item.href}
                title={`${item.rule} (${item.source})`}
                className="rounded-lg border border-border bg-warm-white p-3 hover:border-sage-300 hover:bg-sage-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 rounded-md p-1.5 ${accent.icon}`}>
                    <Icon className="w-3.5 h-3.5" aria-hidden />
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-sm font-semibold tabular-nums ${accent.chip}`}
                  >
                    {item.count}
                  </span>
                </div>
                <p className="mt-1.5 text-xs font-medium text-sage-900">{item.label}</p>
              </Link>
            )
          })}
        </div>
      )}
    </section>
  )
}
