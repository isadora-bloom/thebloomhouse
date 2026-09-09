import Link from 'next/link'
import { ArrowRight, Bell } from 'lucide-react'
import type { TodayPulseRow } from '@/app/(platform)/today/view-model'

/**
 * The top three things the system flagged, in the words a coordinator
 * uses. Everything else stays on /pulse; this is the doorway, not the
 * whole list. Server component, no client JS.
 *
 * Titles and bodies come from the pulse aggregator, which is written by
 * other parts of the app. Anything it hands us is printed as-is — this
 * component does not try to rewrite copy it did not author.
 */

const URGENCY_STYLE: Record<string, string> = {
  'Needs a look now': 'bg-amber-100 text-amber-800',
  'Worth a look': 'bg-sage-100 text-sage-800',
  'For information': 'bg-sage-50 text-sage-600',
}

export function TodayPulse({ rows }: { rows: TodayPulseRow[] }) {
  return (
    <section
      aria-labelledby="today-pulse"
      className="bg-surface border border-border rounded-xl overflow-hidden"
    >
      <header className="p-4 sm:p-5 border-b border-border flex items-start gap-3">
        <span className="shrink-0 rounded-lg bg-sage-50 p-2 text-sage-600">
          <Bell className="w-4 h-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="today-pulse" className="font-heading text-lg font-semibold text-sage-900">
            Anything wrong
          </h2>
          <p className="mt-1 text-xs text-sage-600 leading-relaxed">
            The three most pressing things the system has flagged. Everything else is on the
            alerts page.
          </p>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="p-4 sm:p-5 text-sm text-sage-600">
          Nothing is flagged. Emails are coming in and going out as they should.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="p-4 sm:p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        URGENCY_STYLE[row.urgency] ?? URGENCY_STYLE['For information']
                      }`}
                    >
                      {row.urgency}
                    </span>
                    {row.when && <span className="text-xs text-sage-500">{row.when}</span>}
                  </div>
                  <p className="mt-1 text-sm font-medium text-sage-900 break-words">{row.title}</p>
                  {row.body && (
                    <p className="mt-0.5 text-sm text-sage-600 leading-relaxed break-words">
                      {row.body}
                    </p>
                  )}
                </div>
                {row.href && (
                  <Link
                    href={row.href}
                    className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-sage-200 bg-warm-white px-3 py-2 text-sm font-medium text-sage-800 hover:border-sage-300 hover:bg-sage-50 transition-colors"
                  >
                    Take a look
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden />
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="px-4 sm:px-5 py-3 border-t border-border">
        <Link href="/pulse" className="text-xs font-medium text-sage-700 hover:text-sage-900">
          See everything that has been flagged
        </Link>
      </p>
    </section>
  )
}
