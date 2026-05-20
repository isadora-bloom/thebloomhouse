'use client'

/**
 * /intel/heat — D1 heat-distribution surface (Tier 8 T8.2).
 *
 * Reads /api/admin/intel/heat-report and renders four sections:
 *  - Meta strip: total couples, with-heat, mean, median, active-without-heat
 *  - Heat-band histogram across the venue
 *  - By-lifecycle-state crosstab (booked / resolved / ghost / channel-scoped)
 *  - Hottest 20 + coldest 20 active couples, side-by-side
 *
 * Honesty (§C.6 Tier 4): counts are raw counts (no enoughData gate);
 * the active-without-heat number is surfaced so the operator can see
 * how much of the active cohort the heat engine has actually scored.
 */

import { useEffect, useState, useCallback } from 'react'
import { Flame, Layers, ArrowUp, ArrowDown, Loader2, AlertCircle } from 'lucide-react'
import type {
  HeatReport,
  HeatTopRow,
  HeatBandCell,
  HeatByLifecycleRow,
} from '@/lib/services/cohort/heat'

interface ApiResponse {
  ok: boolean
  venueName?: string
  report?: HeatReport
  error?: string
}

function fmtNum(n: number | null): string {
  if (n === null) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

function fmtScore(n: number | null): string {
  if (n === null) return '—'
  return Math.round(n).toString()
}

function bandColour(label: HeatBandCell['label']): string {
  switch (label) {
    case 'Cold': return 'bg-stone-300'
    case 'Cool': return 'bg-sky-300'
    case 'Warm': return 'bg-amber-300'
    case 'Hot': return 'bg-orange-400'
    case 'On fire': return 'bg-rose-500'
  }
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-6 py-4 border-b border-border flex items-center gap-2">
        <span className="text-sage-500">{icon}</span>
        <h2 className="font-heading text-base font-semibold text-sage-900">
          {title}
        </h2>
        {hint && <span className="text-xs text-sage-500 ml-auto">{hint}</span>}
      </div>
      <div className="px-6 py-4">{children}</div>
    </section>
  )
}

function MetaCard({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="bg-surface border border-border rounded-lg px-4 py-3">
      <div className="text-xs text-sage-500 uppercase tracking-wide">{label}</div>
      <div className="text-xl font-heading text-sage-900 mt-1">{value}</div>
      {hint && <div className="text-[11px] text-sage-500 mt-0.5">{hint}</div>}
    </div>
  )
}

export default function HeatPage() {
  const [data, setData] = useState<HeatReport | null>(null)
  const [venueName, setVenueName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/intel/heat-report', {
        cache: 'no-store',
      })
      const body: ApiResponse = await res.json()
      if (!body.ok || !body.report) {
        setError(body.error ?? 'Failed to load heat report')
      } else {
        setData(body.report)
        setVenueName(body.venueName ?? null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-sage-900">
          Heat distribution
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Where engagement intensity sits across the cohort, and which couples
          are at the extremes today.
          {venueName ? ` · ${venueName}` : ''}
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sage-600 px-2 py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading heat report…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-900 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Could not load heat report</div>
            <div className="text-rose-700 mt-0.5">{error}</div>
          </div>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetaCard label="Couples" value={fmtNum(data.totalCouples)} />
            <MetaCard
              label="With heat score"
              value={fmtNum(data.totalWithHeat)}
              hint={`${Math.round((data.totalWithHeat / Math.max(data.totalCouples, 1)) * 100)}% of cohort`}
            />
            <MetaCard label="Mean" value={fmtScore(data.meanHeat)} />
            <MetaCard label="Median" value={fmtScore(data.medianHeat)} />
          </div>

          {data.activeWithNoHeat > 0 && (
            <div className="px-4 py-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm">
              <div className="font-medium mb-0.5">
                {fmtNum(data.activeWithNoHeat)} active couples have no heat score yet
              </div>
              <div className="text-amber-800">
                These are engaged-state couples (resolved / booked / ghost) the
                heat engine has not scored. They contribute to the cohort
                totals above but do not appear in the hottest/coldest lists.
              </div>
            </div>
          )}

          <Section
            icon={<Flame className="w-4 h-4" />}
            title="Distribution"
            hint="Couples per heat band"
          >
            <BandBars bands={data.bands} total={data.totalWithHeat} />
          </Section>

          <Section
            icon={<Layers className="w-4 h-4" />}
            title="Heat by lifecycle state"
            hint="How heat differs by where the couple is in the funnel"
          >
            <div className="overflow-x-auto -mx-6 px-6">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-sage-500 uppercase tracking-wide">
                  <tr>
                    <th className="py-2">Lifecycle</th>
                    <th className="py-2 text-right">Count</th>
                    <th className="py-2 text-right">Mean</th>
                    <th className="py-2 text-right">Median</th>
                    <th className="py-2">Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byLifecycle.map((row) => (
                    <LifecycleRow key={row.lifecycleState} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            icon={<ArrowUp className="w-4 h-4" />}
            title="Extremes (active couples only)"
            hint="20 hottest + 20 coldest"
          >
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <TopList
                title="Hottest 20"
                icon={<ArrowUp className="w-3.5 h-3.5 text-rose-500" />}
                rows={data.hottestActive}
                emptyMessage="No active couples with a heat score yet."
              />
              <TopList
                title="Coldest 20"
                icon={<ArrowDown className="w-3.5 h-3.5 text-sky-500" />}
                rows={data.coldestActive}
                emptyMessage="No active couples with a heat score yet."
              />
            </div>
            <p className="text-xs text-sage-500 mt-3">
              The coldest-20 list filters to active couples (resolved /
              booked / ghost) whose heat is greater than zero. Couples with
              a zero/null heat appear in the active-without-heat count above
              and are excluded here so the list is meaningful.
            </p>
          </Section>
        </>
      )}
    </div>
  )
}

function BandBars({ bands, total }: { bands: HeatBandCell[]; total: number }) {
  if (total === 0) {
    return <p className="text-sm text-sage-500">No heat-scored couples yet.</p>
  }
  return (
    <div className="space-y-2">
      {bands.map((b) => {
        const pct = total > 0 ? Math.round((b.count / total) * 100) : 0
        return (
          <div key={b.label}>
            <div className="flex items-center justify-between text-xs text-sage-700 mb-1">
              <span className="font-medium">
                {b.label}{' '}
                <span className="text-sage-500">
                  ({b.min}–{b.max === null ? '∞' : b.max})
                </span>
              </span>
              <span>
                {b.count.toLocaleString()} ({pct}%)
              </span>
            </div>
            <div className="h-2 rounded bg-sage-100 overflow-hidden">
              <div
                className={`h-full ${bandColour(b.label)}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LifecycleRow({ row }: { row: HeatByLifecycleRow }) {
  const total = row.bands.reduce((s, b) => s + b.count, 0)
  return (
    <tr className="border-t border-border first:border-t-0">
      <td className="py-2 font-medium text-sage-900">{row.lifecycleState}</td>
      <td className="py-2 text-right">{fmtNum(row.count)}</td>
      <td className="py-2 text-right">{fmtScore(row.mean)}</td>
      <td className="py-2 text-right">{fmtScore(row.median)}</td>
      <td className="py-2">
        <div className="flex h-2 rounded overflow-hidden bg-sage-100 min-w-32">
          {row.bands.map((b) => {
            if (b.count === 0) return null
            const pct = total > 0 ? (b.count / total) * 100 : 0
            return (
              <div
                key={b.label}
                title={`${b.label}: ${b.count}`}
                className={bandColour(b.label)}
                style={{ width: `${pct}%` }}
              />
            )
          })}
        </div>
      </td>
    </tr>
  )
}

function TopList({
  title,
  icon,
  rows,
  emptyMessage,
}: {
  title: string
  icon: React.ReactNode
  rows: HeatTopRow[]
  emptyMessage: string
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-sage-500 mb-2 flex items-center gap-1.5">
        {icon}
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-sage-500 italic">{emptyMessage}</p>
      ) : (
        <ol className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.coupleId}
              className="text-sm border border-border rounded-md px-3 py-2 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="font-medium text-sage-900 truncate">
                  {r.primaryName ?? '(no name)'}
                </div>
                <div className="text-xs text-sage-500">
                  {r.lifecycleState}
                  {r.weddingDate ? ` · ${r.weddingDate}` : ''}
                  {r.touchpointCount > 0 ? ` · ${r.touchpointCount} touchpoints` : ''}
                </div>
              </div>
              <div className="text-lg font-heading text-sage-900 shrink-0">
                {r.heatScore}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
