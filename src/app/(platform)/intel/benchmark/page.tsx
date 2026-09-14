/**
 * /intel/benchmark: how this venue compares with others.
 *
 * The one question Bloom could never answer. It could always say what a
 * venue's own reply time was; it could never say whether that was quick.
 * This page holds six of a venue's own figures against the middle of the
 * other venues on the platform.
 *
 * Server component and a dumb renderer, per INTEL-CANONICAL-API.md §1.
 * Every string comes from `src/lib/intel/adapters/benchmark-view.ts`.
 * Nothing is computed here, and nothing here reads the database directly:
 * the peer query is service-role and server-only, and the guard
 * `scripts/check-no-browser-benchmark-import.mjs` keeps it that way.
 *
 * The page turns itself on. Below three other venues it prints one
 * paragraph saying so, with the count, and nothing else. There is no
 * flag to flip: the day a third venue finishes setting up, this fills in
 * by itself. A sample account is compared against the other sample
 * venues instead, clearly labelled, so the demo shows a working page.
 *
 * No venue is named on this page. Peers reach it as a count, a middle
 * figure and a middle-half range, never as rows.
 *
 * Comparing your OWN venues side by side is a different question and
 * lives on /intel/portfolio.
 */

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowRight, BarChart3, Info, Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { resolvePlatformScope } from '@/lib/api/resolve-platform-scope'
import { UpgradeGate } from '@/components/ui/upgrade-gate'
import { getBenchmarkView, type BenchmarkRowView } from '@/lib/intel/adapters/benchmark-view'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Benchmark' }

const TONE_CLASS: Record<BenchmarkRowView['standingTone'], string> = {
  ahead: 'text-emerald-700',
  behind: 'text-amber-700',
  level: 'text-sage-700',
  unknown: 'text-sage-500',
}

const TONE_ICON = {
  ahead: TrendingUp,
  behind: TrendingDown,
  level: Minus,
  unknown: Minus,
} as const

function MetricCard({ row }: { row: BenchmarkRowView }) {
  const Icon = TONE_ICON[row.standingTone]

  return (
    <section
      aria-labelledby={`benchmark-${row.key}`}
      className="bg-surface border border-border rounded-xl overflow-hidden"
    >
      <header className="p-4 sm:p-5 border-b border-border">
        <h2 id={`benchmark-${row.key}`} className="font-heading text-lg font-semibold text-sage-900">
          {row.label}
        </h2>
        <p className="mt-1 text-sm text-sage-600 leading-relaxed">{row.question}</p>
      </header>

      <div className="p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-sage-500">You</p>
          <p
            className={`mt-1 text-2xl font-semibold tabular-nums ${
              row.yourDim ? 'text-sage-400' : 'text-sage-900'
            }`}
          >
            {row.yourValue}
          </p>
          <p className="mt-0.5 text-xs text-sage-500">
            {row.yourN} couple{row.yourN === 1 ? '' : 's'}
          </p>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-sage-500">
            Middle of the group
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-sage-700">{row.peerMedian}</p>
          <p className="mt-0.5 text-xs text-sage-500">
            {row.peerCount} venue{row.peerCount === 1 ? '' : 's'}
          </p>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-sage-500">Middle half</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-sage-700">{row.peerRange}</p>
          {row.percentileLabel && (
            <p className="mt-0.5 text-xs text-sage-500">You sit {row.percentileLabel}</p>
          )}
        </div>
      </div>

      <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-2">
        <p className={`text-sm font-medium flex items-start gap-2 ${TONE_CLASS[row.standingTone]}`}>
          <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <span>{row.standing}</span>
        </p>
        {row.yourNote && <p className="text-xs text-sage-500 leading-relaxed">{row.yourNote}</p>}
        <p className="text-xs text-sage-500 leading-relaxed">{row.method}</p>
      </div>
    </section>
  )
}

async function BenchmarkBody() {
  const scope = await resolvePlatformScope()
  if (!scope) redirect('/setup')

  const view = await getBenchmarkView(scope.venueId)

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-heading text-3xl font-bold text-sage-900 flex items-center gap-3">
          <BarChart3 className="w-7 h-7 text-sage-500" aria-hidden />
          Benchmark
        </h1>
        <p className="mt-2 text-base text-sage-700 leading-relaxed max-w-2xl">
          Your own figures, held against the middle of the other venues. No venue is named here,
          and none of their individual numbers are shown.
        </p>
        {scope.venueName && <p className="mt-1 text-xs text-sage-500">{scope.venueName}</p>}
      </header>

      {view.demoLabel && (
        <p className="rounded-xl border border-gold-200 bg-gold-50 p-4 text-sm text-gold-800">
          {view.demoLabel}
        </p>
      )}

      {!view.enoughPeers ? (
        <div className="bg-surface border border-border rounded-xl p-6 sm:p-8">
          <h2 className="font-heading text-xl font-semibold text-sage-900">
            Benchmarks need more venues
          </h2>
          <p className="mt-3 text-sm text-sage-700 leading-relaxed max-w-2xl">{view.gateMessage}</p>
          <p className="mt-4 text-sm text-sage-600 leading-relaxed max-w-2xl">
            Your own figures are all still on the pages they come from in the meantime.
          </p>
          <p className="mt-4">
            <Link
              href="/intel/cohort"
              className="inline-flex items-center gap-2 text-sm font-medium text-sage-700 hover:text-sage-900"
            >
              See your own funnel and timing
              <ArrowRight className="w-3.5 h-3.5" aria-hidden />
            </Link>
          </p>
        </div>
      ) : (
        <>
          <p className="rounded-xl border border-sage-200 bg-warm-white p-4 text-sm text-sage-800 leading-relaxed">
            {view.headline}
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
            {view.rows.map((row) => (
              <MetricCard key={row.key} row={row} />
            ))}
          </div>
        </>
      )}

      <section
        aria-labelledby="benchmark-method"
        className="bg-surface border border-border rounded-xl p-4 sm:p-5"
      >
        <h2
          id="benchmark-method"
          className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2"
        >
          <Info className="w-4 h-4 text-sage-500" aria-hidden />
          How this is worked out
        </h2>
        <p className="mt-2 text-sm text-sage-600 leading-relaxed">{view.methodNote}</p>
      </section>

      <p>
        <Link
          href="/intel/portfolio"
          className="inline-flex items-center gap-2 text-sm text-sage-600 hover:text-sage-900"
        >
          Comparing your own venues with each other lives here instead
          <ArrowRight className="w-3.5 h-3.5" aria-hidden />
        </Link>
      </p>
    </div>
  )
}

export default function BenchmarkPage() {
  return (
    <UpgradeGate requiredTier="pre_opening" featureName="Benchmark">
      {/* Server-rendered inside a client gate: the gate decides what the
          reader sees, the reading itself never leaves the server. */}
      <BenchmarkBody />
    </UpgradeGate>
  )
}
