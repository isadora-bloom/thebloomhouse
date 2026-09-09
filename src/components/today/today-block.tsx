import Link from 'next/link'
import { ArrowRight, CalendarDays, Clock, MessageSquare, Star } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { TodayBlock, TodayBlockKey } from '@/app/(platform)/today/view-model'

/**
 * One block of the /today page. Server component, no client JS.
 *
 * Layout rules, in order of importance:
 *   - At 390px each row stacks: name, then the reason, then the action.
 *     Nothing sits in a fixed-width cell and nothing scrolls sideways.
 *   - The count never appears without the sentence that says what it
 *     counts. `blurb` is that sentence and it is always rendered.
 *   - An empty block still says something useful. It never renders a 0.
 */

const ICONS: Record<TodayBlockKey, LucideIcon> = {
  'needs-reply': MessageSquare,
  'going-quiet': Clock,
  tours: CalendarDays,
  'ready-to-book': Star,
}

/** Accent per block. Sage for the two that are about conversation, gold
 *  for the one that is about money, teal for the diary. */
const ACCENT: Record<TodayBlockKey, { chip: string; icon: string }> = {
  'needs-reply': { chip: 'bg-sage-100 text-sage-800', icon: 'bg-sage-50 text-sage-600' },
  'going-quiet': { chip: 'bg-amber-100 text-amber-800', icon: 'bg-amber-50 text-amber-700' },
  tours: { chip: 'bg-teal-100 text-teal-800', icon: 'bg-teal-50 text-teal-600' },
  'ready-to-book': { chip: 'bg-gold-100 text-gold-800', icon: 'bg-gold-50 text-gold-700' },
}

export function TodayBlockCard({ block }: { block: TodayBlock }) {
  const Icon = ICONS[block.key]
  const accent = ACCENT[block.key]

  return (
    <section
      aria-labelledby={`today-${block.key}`}
      className="bg-surface border border-border rounded-xl overflow-hidden"
    >
      <header className="p-4 sm:p-5 border-b border-border">
        <div className="flex items-start gap-3">
          <span className={`shrink-0 rounded-lg p-2 ${accent.icon}`}>
            <Icon className="w-4 h-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h2
                id={`today-${block.key}`}
                className="font-heading text-lg font-semibold text-sage-900"
              >
                {block.title}
              </h2>
              {block.count > 0 && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${accent.chip}`}
                >
                  {block.count}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-sage-600 leading-relaxed">{block.blurb}</p>
          </div>
        </div>
      </header>

      {block.rows.length === 0 ? (
        <p className="p-4 sm:p-5 text-sm text-sage-600">{block.empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {block.rows.map((row) => (
            <li key={row.key} className="p-4 sm:p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-sage-900 break-words">{row.name}</p>
                  <p className="mt-0.5 text-sm text-sage-600 leading-relaxed break-words">
                    {row.why}
                  </p>
                </div>
                <Link
                  href={row.action.href}
                  className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-sage-200 bg-warm-white px-3 py-2 text-sm font-medium text-sage-800 hover:border-sage-300 hover:bg-sage-50 transition-colors sm:self-auto"
                >
                  {row.action.label}
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden />
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      {block.hidden > 0 && (
        <p className="px-4 sm:px-5 py-3 border-t border-border text-xs text-sage-600">
          {block.hidden} more not shown here, so the list stays short enough to work through.
        </p>
      )}
    </section>
  )
}
