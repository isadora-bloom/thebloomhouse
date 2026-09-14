/**
 * /intel/monthly-story — the screen the owner reads, not the coordinator.
 *
 * Four questions an owner asks about the month, answered on one page:
 * how fast do we answer, which tour days turn into bookings, what does
 * each channel return, and are the reviews moving. Every one of those was
 * already computed somewhere in Bloom and none of them was ever on the
 * same screen, so answering all four meant four pages and a good memory.
 *
 * Server component and a dumb renderer, per INTEL-CANONICAL-API.md §1.
 * All four numbers come through `src/lib/intel/adapters/monthly-story.ts`,
 * which reads them from the canonical layer, so they are the same numbers
 * /intel/cohort, /intel/sources, /intel/reviews and Ask your data give.
 * Nothing is computed in this file and nothing here reads a legacy table.
 */

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowRight, Clock, CalendarDays, TrendingUp, Star } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { resolvePlatformScope } from '@/lib/api/resolve-platform-scope'
import {
  buildMonthlyStoryView,
  getMonthlyStory,
  type MonthlyStoryPanel,
  type MonthlyStoryPanelKey,
} from '@/lib/intel/adapters/monthly-story'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Monthly story' }

const ICONS: Record<MonthlyStoryPanelKey, LucideIcon> = {
  'response-time': Clock,
  'tour-weekday': CalendarDays,
  'channel-roi': TrendingUp,
  reviews: Star,
}

/** Accent per panel. Sage for the two about how the venue behaves, gold
 *  for the one about money, teal for the one about what couples say. */
const ACCENT: Record<MonthlyStoryPanelKey, string> = {
  'response-time': 'bg-sage-50 text-sage-600',
  'tour-weekday': 'bg-teal-50 text-teal-600',
  'channel-roi': 'bg-gold-50 text-gold-700',
  reviews: 'bg-amber-50 text-amber-700',
}

function StoryPanel({ panel }: { panel: MonthlyStoryPanel }) {
  const Icon = ICONS[panel.key]

  return (
    <section
      aria-labelledby={`story-${panel.key}`}
      className="bg-surface border border-border rounded-xl overflow-hidden"
    >
      <header className="p-4 sm:p-5 border-b border-border">
        <div className="flex items-start gap-3">
          <span className={`shrink-0 rounded-lg p-2 ${ACCENT[panel.key]}`}>
            <Icon className="w-4 h-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id={`story-${panel.key}`}
              className="font-heading text-lg font-semibold text-sage-900"
            >
              {panel.title}
            </h2>
            <p
              className={`mt-1 text-sm leading-relaxed ${
                panel.isFinding ? 'text-sage-800' : 'text-sage-600'
              }`}
            >
              {panel.headline}
            </p>
            <p className="mt-1 text-xs text-sage-600 leading-relaxed">{panel.blurb}</p>
          </div>
        </div>
      </header>

      {panel.rows.length === 0 ? (
        <p className="p-4 sm:p-5 text-sm text-sage-600">{panel.empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {panel.rows.map((row) => (
            <li key={row.key} className="p-4 sm:p-5">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p
                    className={`text-sm font-medium break-words ${
                      row.standout ? 'text-sage-900' : 'text-sage-800'
                    }`}
                  >
                    {row.label}
                  </p>
                  {row.note && (
                    <p className="mt-0.5 text-xs text-sage-600 leading-relaxed break-words">
                      {row.note}
                    </p>
                  )}
                </div>
                <p
                  className={`shrink-0 text-lg font-semibold tabular-nums ${
                    row.dim ? 'text-sage-400' : row.standout ? 'text-sage-900' : 'text-sage-700'
                  }`}
                >
                  {row.value}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="px-4 sm:px-5 py-3 border-t border-border flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-sage-500 leading-relaxed min-w-0 break-words">{panel.provenance}</p>
        <Link
          href={panel.href}
          className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-sage-700 hover:text-sage-900"
        >
          {panel.hrefLabel}
          <ArrowRight className="w-3.5 h-3.5" aria-hidden />
        </Link>
      </div>
    </section>
  )
}

export default async function MonthlyStoryPage() {
  const scope = await resolvePlatformScope()
  if (!scope) redirect('/setup')

  const facts = await getMonthlyStory(scope.venueId)
  const view = buildMonthlyStoryView(facts)

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-heading text-3xl font-bold text-sage-900">Monthly story</h1>
        <p className="mt-2 text-base text-sage-700 leading-relaxed max-w-2xl">
          Four things worth knowing about the month, on one screen. Each one is the same number the
          page it links to gives, because they all come from the same reader.
        </p>
        {scope.venueName && <p className="mt-1 text-xs text-sage-500">{scope.venueName}</p>}
      </header>

      {view.allEmpty && (
        <p className="rounded-xl border border-sage-200 bg-warm-white p-4 text-sm text-sage-700">
          There is not enough on file yet to tell a month&apos;s story. Each panel below says what it
          is waiting for, and fills in on its own once that arrives.
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        {view.panels.map((panel) => (
          <StoryPanel key={panel.key} panel={panel} />
        ))}
      </div>

      <p className="pt-2">
        <Link
          href="/intel/nlq?prompt=How%20did%20this%20month%20compare%20with%20last%20month%3F"
          className="inline-flex items-center gap-2 text-sm text-sage-600 hover:text-sage-900"
        >
          Ask your data a follow-up about the month
          <ArrowRight className="w-3.5 h-3.5" aria-hidden />
        </Link>
      </p>
    </div>
  )
}
