'use client'

/**
 * /admin/calibration — prediction calibration dashboard (moved from
 * /intel in Round 2 audit TIER 3, 2026-05-14; legacy route redirects
 * via next.config.ts).
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (the dashboard exists so the
 *     prediction model can't lie to itself unmeasured)
 *   - bloom-constitution.md (forensic identity reconstruction; the
 *     forensic record's job is to be MORE COMPLETE than the couple's
 *     own memory, including our own prediction history)
 *
 * What this shows
 * ---------------
 *   - Headline numbers: Brier score, accuracy, above-50 accuracy,
 *     below-50 accuracy, mean absolute error.
 *   - Reliability diagram (predicted decile vs actual booked rate).
 *   - Per-persona calibration breakdown (Brier + accuracy + avg
 *     predicted vs avg actual).
 *   - Drift chart across 30d / 90d / 365d.
 *   - "Narrator's read" — Sonnet plain-English summary.
 *
 * No couples are named on this page. Aggregate metrics only.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Activity,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react'
import {
  ReliabilityDiagram,
  DriftChart,
} from '@/components/intel/CalibrationChart'
import type { CalibrationReport } from '@/lib/services/calibration/analyze'

interface ReportResponse {
  ok: boolean
  report?: CalibrationReport
  narrative?: string | null
  narrativeError?: string
  narrativeCostCents?: number
  error?: string
}

interface MeasureResponse {
  ok: boolean
  measuredCount?: number
  skipped?: number
  jobsDrained?: number
  catchupMeasured?: number
  reason?: string
}

const WINDOW_OPTIONS: Array<{ label: string; days: number }> = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '365d', days: 365 },
]

function formatMetric(v: number | null | undefined, suffix = ''): string {
  if (v === null || v === undefined) return '—'
  return `${v}${suffix}`
}

function brierGrade(brier: number | null): {
  label: string
  className: string
} {
  if (brier === null) return { label: 'no data', className: 'text-stone-500' }
  if (brier <= 0.18) return { label: 'well calibrated', className: 'text-emerald-700' }
  if (brier <= 0.22) return { label: 'OK', className: 'text-amber-700' }
  return { label: 'miscalibrated', className: 'text-rose-700' }
}

export default function IntelCalibrationDashboard() {
  const [windowDays, setWindowDays] = useState(90)
  const [data, setData] = useState<ReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [measureMessage, setMeasureMessage] = useState<string | null>(null)
  const [narrating, setNarrating] = useState(false)

  const fetchReport = useCallback(
    async (narrate = false) => {
      try {
        const url = `/api/admin/intel/calibration/report?windowDays=${windowDays}${
          narrate ? '&narrate=1' : ''
        }`
        const res = await fetch(url, { cache: 'no-store' })
        const body = (await res.json()) as ReportResponse
        if (!res.ok || !body.ok) {
          setError(body.error || `HTTP ${res.status}`)
          setData(null)
          return
        }
        setData(body)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setData(null)
      }
    },
    [windowDays],
  )

  useEffect(() => {
    setLoading(true)
    fetchReport(false).finally(() => setLoading(false))
  }, [fetchReport])

  const onMeasure = async () => {
    setMeasuring(true)
    setMeasureMessage(null)
    try {
      const res = await fetch('/api/admin/intel/calibration/measure', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = (await res.json()) as MeasureResponse
      if (!res.ok || !body.ok) {
        setMeasureMessage(`Error: ${body.reason ?? `HTTP ${res.status}`}`)
      } else {
        setMeasureMessage(
          `Measured ${body.measuredCount ?? 0} outcome(s). ${
            body.skipped ?? 0
          } snapshots skipped (not yet terminal).`,
        )
        await fetchReport(false)
      }
    } catch (err) {
      setMeasureMessage(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setMeasuring(false)
    }
  }

  const onNarrate = async () => {
    setNarrating(true)
    await fetchReport(true)
    setNarrating(false)
  }

  const report = data?.report
  const grade = brierGrade(report?.brierScore ?? null)

  return (
    <div className="px-6 py-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-2xl font-serif text-stone-900 flex items-center gap-2">
            <Target className="w-6 h-6 text-sage-500" />
            Prediction calibration
          </h1>
          <p className="text-sm text-stone-500 mt-1">
            How well does our close-probability prediction match what
            actually happens? A model that predicts without measuring is
            unaudited.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-stone-200 overflow-hidden text-xs">
            {WINDOW_OPTIONS.map((w) => (
              <button
                key={w.days}
                type="button"
                onClick={() => setWindowDays(w.days)}
                className={`px-3 py-1.5 ${
                  windowDays === w.days
                    ? 'bg-sage-500 text-white'
                    : 'bg-white text-stone-700 hover:bg-stone-50'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onMeasure}
            disabled={measuring}
            className="inline-flex items-center gap-2 rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50"
          >
            {measuring ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Measure outcomes
          </button>
        </div>
      </div>

      {measureMessage && (
        <div className="text-sm text-stone-700 mb-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
          {measureMessage}
        </div>
      )}

      {loading && (
        <div className="text-sm text-stone-500 flex items-center gap-2 mt-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading calibration report…
        </div>
      )}

      {error && (
        <div className="text-sm text-rose-600 mt-4">Error loading: {error}</div>
      )}

      {!loading && report && (
        <>
          {/* Headline numbers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
            <MetricCard
              label="Brier score"
              value={formatMetric(report.brierScore)}
              subline={grade.label}
              sublineClass={grade.className}
              icon={Activity}
              hint="0 = perfect, 0.25 = coin flip"
            />
            <MetricCard
              label="Overall accuracy"
              value={formatMetric(report.accuracyPct, '%')}
              subline={`${report.n} measured`}
              icon={TrendingUp}
              hint="direction correct (>=50 booked, <50 lost)"
            />
            <MetricCard
              label="Above-50 accuracy"
              value={formatMetric(report.above50AccuracyPct, '%')}
              subline="of high-confidence predictions, % that booked"
              icon={Target}
            />
            <MetricCard
              label="Below-50 accuracy"
              value={formatMetric(report.below50AccuracyPct, '%')}
              subline="of low-confidence predictions, % that did NOT book"
              icon={Target}
            />
          </div>

          {!report.diagnostics.sufficientForAnalysis && (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                Only {report.n} measured outcome
                {report.n === 1 ? '' : 's'} in this window — Brier score is
                noisy below n=20. Treat numbers as indicative.
              </span>
            </div>
          )}

          {/* Reliability diagram */}
          <section className="mt-8">
            <header className="mb-3">
              <h2 className="text-lg font-serif text-stone-900">Reliability diagram</h2>
              <p className="text-xs text-stone-500">
                Each dot is one prediction decile. Distance from the dashed
                diagonal is the miscalibration in that decile. Green dots are
                within ±5pp.
              </p>
            </header>
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <ReliabilityDiagram bins={report.reliabilityBins} />
            </div>
          </section>

          {/* Drift */}
          <section className="mt-8">
            <header className="mb-3">
              <h2 className="text-lg font-serif text-stone-900">Drift</h2>
              <p className="text-xs text-stone-500">
                Brier score and accuracy across rolling windows. A noticeably
                worse 30d window relative to 365d is a regression signal.
              </p>
            </header>
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <DriftChart drift={report.drift} />
            </div>
          </section>

          {/* Per-persona */}
          <section className="mt-8">
            <header className="mb-3">
              <h2 className="text-lg font-serif text-stone-900">By persona</h2>
              <p className="text-xs text-stone-500">
                Personas with at least 5 measured outcomes. Look for personas
                where avg predicted differs noticeably from avg actual.
              </p>
            </header>
            {report.perPersona.length === 0 ? (
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-6 text-center text-sm text-stone-500">
                Not enough per-persona data yet. Need 5+ measured outcomes per
                persona label.
              </div>
            ) : (
              <div className="rounded-lg border border-stone-200 bg-white overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                    <tr>
                      <th className="text-left px-3 py-2">Persona</th>
                      <th className="text-right px-3 py-2">n</th>
                      <th className="text-right px-3 py-2">Brier</th>
                      <th className="text-right px-3 py-2">Accuracy</th>
                      <th className="text-right px-3 py-2">Avg predicted</th>
                      <th className="text-right px-3 py-2">Avg actual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.perPersona.map((p) => {
                      const gap =
                        p.avgPredictedPct !== null && p.avgActualPct !== null
                          ? p.avgPredictedPct - p.avgActualPct
                          : null
                      const gapClass =
                        gap === null
                          ? ''
                          : Math.abs(gap) > 15
                            ? 'text-rose-700'
                            : Math.abs(gap) > 7
                              ? 'text-amber-700'
                              : 'text-emerald-700'
                      return (
                        <tr key={p.persona} className="border-t border-stone-100">
                          <td className="px-3 py-2 font-medium text-stone-900">
                            {p.persona === '__untagged__' ? 'Untagged' : p.persona}
                          </td>
                          <td className="px-3 py-2 text-right text-stone-700">{p.n}</td>
                          <td className="px-3 py-2 text-right text-stone-700">
                            {p.brierScore !== null ? p.brierScore.toFixed(3) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right text-stone-700">
                            {p.accuracyPct !== null
                              ? `${p.accuracyPct.toFixed(1)}%`
                              : '—'}
                          </td>
                          <td className="px-3 py-2 text-right text-stone-700">
                            {p.avgPredictedPct !== null
                              ? `${p.avgPredictedPct.toFixed(1)}%`
                              : '—'}
                          </td>
                          <td
                            className={`px-3 py-2 text-right ${gapClass} font-medium`}
                          >
                            {p.avgActualPct !== null
                              ? `${p.avgActualPct.toFixed(1)}%`
                              : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Narrator's read */}
          <section className="mt-8">
            <header className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-serif text-stone-900 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-sage-500" />
                  Narrator&apos;s read
                </h2>
                <p className="text-xs text-stone-500">
                  Sonnet plain-English summary of the calibration. ~$0.02 per
                  run.
                </p>
              </div>
              <button
                type="button"
                onClick={onNarrate}
                disabled={narrating || !report.diagnostics.sufficientForAnalysis}
                className="inline-flex items-center gap-2 rounded-md bg-sage-500 text-white px-3 py-1.5 text-sm hover:bg-sage-600 disabled:opacity-50"
              >
                {narrating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                {data?.narrative ? 'Re-narrate' : 'Narrate'}
              </button>
            </header>
            {data?.narrative ? (
              <div className="rounded-lg border border-stone-200 bg-white p-5 text-sm leading-relaxed text-stone-700 whitespace-pre-wrap">
                {data.narrative}
              </div>
            ) : data?.narrativeError ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                Narrator failed: {data.narrativeError}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-6 text-center text-sm text-stone-500">
                Click <span className="font-medium">Narrate</span> to spend
                ~$0.02 on a plain-English read of this report.
              </div>
            )}
          </section>

          {/* Diagnostics */}
          <section className="mt-8 mb-12">
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600 flex items-center justify-between gap-4">
              <span>
                {report.diagnostics.snapshotsTotal} snapshot
                {report.diagnostics.snapshotsTotal === 1 ? '' : 's'} recorded,{' '}
                {report.diagnostics.outcomesTotal} measured,{' '}
                {report.diagnostics.pendingMeasurement} pending terminal state.
              </span>
              <span className="text-stone-400">
                Generated {new Date(report.generatedAt).toLocaleString()}
              </span>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface MetricCardProps {
  label: string
  value: string
  subline?: string | null
  sublineClass?: string
  icon: typeof Activity
  hint?: string
}

function MetricCard(props: MetricCardProps) {
  const Icon = props.icon
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-stone-500">
        <Icon className="w-3.5 h-3.5" />
        {props.label}
      </div>
      <div className="text-3xl font-serif text-stone-900 mt-2">{props.value}</div>
      {props.subline && (
        <div className={`text-xs mt-1 ${props.sublineClass ?? 'text-stone-500'}`}>
          {props.subline}
        </div>
      )}
      {props.hint && (
        <div className="text-[10px] text-stone-400 mt-1.5">{props.hint}</div>
      )}
    </div>
  )
}
