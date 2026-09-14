/**
 * /today — the page a venue coordinator opens on a Monday morning.
 *
 * Answers five questions and nothing else: who needs a reply, who is
 * going quiet, who is touring this week, who looks ready to book, and is
 * anything wrong. One screen, plain English, one action per row.
 *
 * It is a server component and a dumb renderer, per
 * INTEL-CANONICAL-API.md §1. All derivation happens in the canonical
 * readers (`getDailyList` / `getVenueOverview`); all wording happens in
 * `./view-model` and `@/lib/copy/client-terms`. There is nothing to
 * compute in this file, and nothing here reads a legacy table.
 */

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, LayoutDashboard } from 'lucide-react'
import { resolvePlatformScope } from '@/lib/api/resolve-platform-scope'
import { createServiceClient } from '@/lib/supabase/service'
import { getDailyList, getVenueOverview } from '@/lib/intel/canonical'
import { aggregatePulse } from '@/lib/services/intel/pulse-aggregator'
import {
  buildSinceLastHereStrip,
  computeSinceLastHereWindow,
  getSinceLastHere,
} from '@/lib/intel/adapters/since-last-here'
import { DataMaturity } from '@/components/ui/data-maturity'
import { TodayBlockCard } from '@/components/today/today-block'
import { TodayPulse } from '@/components/today/today-pulse'
import { SinceLastHereStripCard } from '@/components/today/since-last-here-strip'
import { DEFAULT_TIME_ZONE } from '@/lib/copy/client-terms'
import { nowMs } from '@/lib/utils/clock'
import { buildTodayViewModel, PULSE_ROWS, type PulseLike } from './view-model'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Today' }

/** Long date in the coordinator's own phrasing: "Monday 8 September",
 *  in the VENUE's timezone rather than the server's. */
function todayLabel(now: Date, timeZone: string): string {
  try {
    return now.toLocaleDateString('en-GB', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    })
  } catch {
    return now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  }
}

/** The venue's `venue_config.timezone` (venues has no timezone column),
 *  defaulted the same way the cohort loader defaults it. A display
 *  setting, not a derived metric, so reading it here does not make the
 *  page a deriving surface. */
async function venueTimeZone(venueId: string): Promise<string> {
  try {
    const { data } = await createServiceClient()
      .from('venue_config')
      .select('timezone')
      .eq('venue_id', venueId)
      .maybeSingle<{ timezone: string | null }>()
    const tz = data?.timezone?.trim()
    return tz && tz.length > 0 ? tz : DEFAULT_TIME_ZONE
  } catch {
    return DEFAULT_TIME_ZONE
  }
}

export default async function TodayPage() {
  const scope = await resolvePlatformScope()
  if (!scope) redirect('/setup')

  // One timestamp per request (server component, so nothing re-renders
  // against it). Read through the helper for the same reason as the
  // client pages: the compiler's purity check flags a bare Date.now().
  const now = nowMs()

  // The timezone gates the "since you were last here" window (today's
  // weekday, venue-local, decides where the window starts), so it is
  // read before the parallel batch below rather than inside it.
  const timeZone = await venueTimeZone(scope.venueId)
  const sinceLastHereWindow = computeSinceLastHereWindow(now, timeZone)

  // Four reads, in parallel. The pulse and since-last-here reads are
  // best-effort: an outage in either must not take the landing page
  // down with it.
  const [dailyResult, overviewResult, pulseResult, sinceLastHereResult] = await Promise.all([
    getDailyList(scope.venueId).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    getVenueOverview(scope.venueId).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    aggregatePulse(createServiceClient(), scope.venueId, { limit: PULSE_ROWS, sinceDays: 14 }).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    getSinceLastHere(scope.venueId, sinceLastHereWindow).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
  ])

  if (!dailyResult.ok || !overviewResult.ok) {
    return (
      <div className="space-y-4 max-w-2xl">
        <h1 className="font-heading text-3xl font-bold text-sage-900">Today</h1>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-amber-900">
                Your couples would not load just now.
              </p>
              <p className="mt-1 text-sm text-amber-800">
                Nothing is lost. Refresh the page, and if it keeps happening the alerts page will
                say what broke.
              </p>
              <Link
                href="/pulse"
                className="mt-3 inline-block text-sm font-medium text-amber-900 underline"
              >
                Open the alerts page
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const vm = buildTodayViewModel({
    daily: dailyResult.v,
    overview: overviewResult.v,
    pulse: pulseResult.ok ? (pulseResult.v as PulseLike[]) : [],
    now,
    timeZone,
  })

  return (
    <div className="space-y-6">
      {/* Header + the one-sentence briefing. */}
      <header>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="font-heading text-3xl font-bold text-sage-900">Today</h1>
          <p className="text-sm text-sage-600">{todayLabel(new Date(now), timeZone)}</p>
        </div>
        <p className="mt-2 text-base text-sage-700 leading-relaxed max-w-2xl">{vm.briefing}</p>
        {scope.venueName && (
          <p className="mt-1 text-xs text-sage-500">
            {scope.venueName}
            {vm.asAt ? ` · as at ${vm.asAt}` : ''}
          </p>
        )}
      </header>

      {/* "Since you were last here" — the Monday-walkthrough audit's
          second finding: nothing said what happened over the weekend
          because the inbox/drafts stats reset at midnight. Best-effort:
          an outage here should not hide the four blocks below it. */}
      {sinceLastHereResult.ok && (
        <SinceLastHereStripCard strip={buildSinceLastHereStrip(sinceLastHereResult.v)} />
      )}

      {/* Data maturity — a count-up, not a telling-off. Shown only while
          the venue is still below the threshold. */}
      {vm.maturity && (
        <DataMaturity
          current={vm.maturity.current}
          threshold={vm.maturity.threshold}
          unit={vm.maturity.unit}
          unlocks={vm.maturity.unlocks}
          variant="card"
          className="max-w-xl"
        />
      )}

      {vm.allClear && !vm.briefingIsReason && (
        <p className="rounded-xl border border-sage-200 bg-warm-white p-4 text-sm text-sage-700">
          Nothing needs you this morning. That happens, and it is not a sign anything is broken.
        </p>
      )}

      {/* The four blocks. One column on a phone, two from lg up. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        {vm.blocks.map((block) => (
          <TodayBlockCard key={block.key} block={block} />
        ))}
      </div>

      <TodayPulse rows={vm.pulse} />

      <p className="pt-2">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 text-sm text-sage-600 hover:text-sage-900"
        >
          <LayoutDashboard className="w-4 h-4" aria-hidden />
          Open the full dashboard
        </Link>
      </p>
    </div>
  )
}
