'use client'

/**
 * /intel/agencies/[id]/tbh-report — Wave 6E depth pass.
 *
 * The TBH Report surface. Print-styled so browser → "Print to PDF"
 * produces a shareable artifact. The page:
 *
 *   1. Loads the latest report for the chosen mode (internal/shareable).
 *   2. Lets the operator regenerate (LLM call + persistence).
 *   3. Renders the LLM narrative side-by-side with the structured
 *      snapshot it was derived from.
 *   4. Hides UI chrome under @media print so the printed page looks
 *      like a report, not a webpage.
 */

import { useCallback, useEffect, useState, use as usePromise } from 'react'
import Link from 'next/link'
import { PaperGrain } from '@/components/brand-icons/paper-grain'
import {
  ArrowLeft,
  Loader2,
  Printer,
  RefreshCw,
  AlertTriangle,
  FileText,
  Briefcase,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Minus,
  HelpCircle,
  CircleSlash,
} from 'lucide-react'

interface KpiPerfRow {
  metricDisplay: string
  targetValue: number
  targetUnit: string
  targetWindow: string
  actualValue: number | null
  gapPct: number | null
  status:
    | 'hit'
    | 'close'
    | 'miss'
    | 'too_early'
    | 'not_measurable'
    | 'no_data'
  statusLabel: string
  reasoning: string
}

interface PerChannelRow {
  channelKey: string
  spendCents: number
  firstTouchLeads: number
  firstTouchTours: number
  firstTouchBookings: number
  bookedRevenueCents: number
  costPerBookingCents: number | null
  costPerLeadCents: number | null
}

interface TrendRow {
  month: string
  totalCents: number
  firstTouchLeads: number
  firstTouchBookings: number
}

interface CoverageDisclosure {
  pixel: string
  googleAdsOAuth: string
  calendlyQa: string
  attributionStart: string | null
  notes: string[]
}

interface ActivityHighlight {
  occurredAt: string
  kind: string
  summary: string
  body: string | null
}

interface ReportSnapshot {
  agencyName: string
  periodStart: string
  periodEnd: string
  windowDays: number
  roi: {
    totalSpendCents: number
    spendCents: number
    retainerSpendCents: number
    firstTouchLeads: number
    firstTouchTours: number
    firstTouchBookings: number
    bookedRevenueCents: number
    costPerBookingCents: number | null
    costPerLeadCents: number | null
  }
  breakdown: {
    perChannel: PerChannelRow[]
    monthlyTrend: TrendRow[]
    personaCounts: Record<string, number>
  }
  kpiPerformance: KpiPerfRow[]
  coverage: CoverageDisclosure
  activityHighlights: ActivityHighlight[]
}

interface TbhReport {
  id: string
  agencyId: string
  agencyName: string
  shortCode: string
  periodStart: string
  periodEnd: string
  mode: 'internal' | 'shareable'
  executiveSummary: string | null
  conflictFindings: string | null
  recommendations: string | null
  notesForAgency: string | null
  snapshot: ReportSnapshot
  generatedAt: string
}

function formatDollars(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return '—'
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function StatusIcon({ status }: { status: KpiPerfRow['status'] }) {
  switch (status) {
    case 'hit':
      return <CheckCircle2 className="h-3 w-3 text-emerald-700" />
    case 'close':
      return <Minus className="h-3 w-3 text-amber-700" />
    case 'miss':
      return <XCircle className="h-3 w-3 text-rose-700" />
    case 'too_early':
    case 'no_data':
      return <HelpCircle className="h-3 w-3 text-sky-700" />
    case 'not_measurable':
      return <CircleSlash className="h-3 w-3 text-slate-500" />
  }
}

export default function TbhReportPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: agencyId } = usePromise(params)
  const [report, setReport] = useState<TbhReport | null>(null)
  const [mode, setMode] = useState<'internal' | 'shareable'>('internal')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadLatest = useCallback(
    async (m: 'internal' | 'shareable') => {
      setLoading(true)
      setError(null)
      try {
        const resp = await fetch(
          `/api/intel/agencies/${agencyId}/tbh-report?mode=${m}`,
        )
        if (!resp.ok) {
          setReport(null)
          return
        }
        const j = (await resp.json()) as { report: TbhReport | null }
        setReport(j.report)
      } finally {
        setLoading(false)
      }
    },
    [agencyId],
  )

  useEffect(() => {
    void loadLatest(mode)
  }, [mode, loadLatest])

  const regenerate = useCallback(async () => {
    setGenerating(true)
    setError(null)
    try {
      const resp = await fetch(`/api/intel/agencies/${agencyId}/tbh-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!resp.ok) {
        const j = (await resp.json().catch(() => null)) as
          | { error?: string }
          | null
        setError(j?.error ?? 'Generation failed.')
        return
      }
      const j = (await resp.json()) as { report: TbhReport }
      setReport(j.report)
    } finally {
      setGenerating(false)
    }
  }, [agencyId, mode])

  const handlePrint = useCallback(() => {
    window.print()
  }, [])

  return (
    <div className="bg-[var(--bh-warm-50)] min-h-screen">
      {/* Print CSS — hides chrome, sizes pages, preserves color. */}
      <style jsx global>{`
        @media print {
          @page {
            size: letter;
            margin: 0.5in;
          }
          body {
            background: white !important;
            color: black;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .tbh-no-print {
            display: none !important;
          }
          .tbh-page {
            background: white !important;
            box-shadow: none !important;
            margin: 0 !important;
            padding: 0 !important;
            max-width: none !important;
          }
          section.tbh-page-break {
            page-break-before: always;
          }
        }
      `}</style>

      {/* Chrome — hidden in print. */}
      <div className="tbh-no-print sticky top-0 z-10 border-b border-[var(--bh-line)] bg-white px-6 py-3 shadow-sm">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <Link
            href={`/intel/agencies/${agencyId}`}
            className="inline-flex items-center gap-1 text-sm text-[var(--bh-muted)] hover:text-[var(--bh-ink)]"
          >
            <ArrowLeft className="h-3 w-3" /> Back to agency
          </Link>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setMode('internal')}
                className={`rounded-full border px-3 py-1 ${
                  mode === 'internal'
                    ? 'border-[var(--bh-sage-700)] bg-[var(--bh-sage-700)] text-white'
                    : 'border-[var(--bh-line)] bg-white'
                }`}
              >
                Internal mode
              </button>
              <button
                type="button"
                onClick={() => setMode('shareable')}
                className={`rounded-full border px-3 py-1 ${
                  mode === 'shareable'
                    ? 'border-[var(--bh-sage-700)] bg-[var(--bh-sage-700)] text-white'
                    : 'border-[var(--bh-line)] bg-white'
                }`}
              >
                Shareable mode
              </button>
            </div>
            <button
              type="button"
              onClick={regenerate}
              disabled={generating}
              className="inline-flex items-center gap-2 rounded-md border border-[var(--bh-line)] bg-white px-3 py-1.5 text-xs hover:bg-[var(--bh-sage-50)] disabled:opacity-50"
            >
              {generating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {generating ? 'Generating…' : 'Regenerate'}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={!report}
              className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
            >
              <Printer className="h-3 w-3" /> Print / Save as PDF
            </button>
          </div>
        </div>
        {error ? (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
            <AlertTriangle className="h-3 w-3 mt-0.5" />
            {error}
          </div>
        ) : null}
      </div>

      {/* Report page */}
      <div className="tbh-page relative mx-auto my-6 max-w-4xl bg-white p-10 shadow-sm overflow-hidden">
        <PaperGrain opacity={0.05} />
        {loading ? (
          <div className="flex h-64 items-center justify-center text-sm text-[var(--bh-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !report ? (
          <EmptyReportState onGenerate={regenerate} generating={generating} />
        ) : (
          <ReportBody report={report} />
        )}
      </div>
    </div>
  )
}

function EmptyReportState({
  onGenerate,
  generating,
}: {
  onGenerate: () => Promise<void>
  generating: boolean
}) {
  return (
    <div className="py-12 text-center">
      <FileText className="mx-auto h-10 w-10 text-[var(--bh-muted)]" />
      <h2 className="mt-3 font-serif text-2xl">No TBH Report yet</h2>
      <p className="mt-2 mx-auto max-w-md text-sm text-[var(--bh-muted)]">
        Generate the first report to see the LLM-written narrative
        alongside the structured numbers it was derived from. Subsequent
        regenerations preserve history.
      </p>
      <button
        type="button"
        onClick={onGenerate}
        disabled={generating}
        className="mt-5 inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
      >
        {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Generate report
      </button>
    </div>
  )
}

function ReportBody({ report }: { report: TbhReport }) {
  const s = report.snapshot
  return (
    <article className="space-y-8 text-sm leading-relaxed text-[var(--bh-ink)]">
      {/* Header */}
      <header className="border-b border-[var(--bh-line)] pb-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--bh-muted)]">
              TBH Report · {report.shortCode}
            </div>
            <h1 className="mt-1 font-serif text-3xl">{s.agencyName}</h1>
            <div className="mt-1 text-xs text-[var(--bh-muted)]">
              {formatDate(s.periodStart)} → {formatDate(s.periodEnd)} ·{' '}
              {report.mode === 'internal'
                ? 'Internal view'
                : 'Shareable working-view'}
            </div>
          </div>
          <div className="text-right flex flex-col items-end">
            <img
              src="/brand/icon-bold-sage.png"
              alt=""
              className="h-10 w-auto mb-1"
            />
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--bh-muted)]">
              The Bloom House
            </div>
            <div className="font-serif text-lg italic">to be honest.</div>
            <div className="mt-1 text-[10px] text-[var(--bh-muted)]">
              Generated {formatDate(report.generatedAt)}
            </div>
          </div>
        </div>
      </header>

      {/* Executive summary */}
      {report.executiveSummary ? (
        <section>
          <h2 className="font-serif text-xl">Executive summary</h2>
          <p className="mt-3 whitespace-pre-wrap text-base leading-7">
            {report.executiveSummary}
          </p>
        </section>
      ) : null}

      {/* Headline numbers */}
      <section>
        <h2 className="font-serif text-xl">Headline numbers</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
          <HeadlineStat
            label="Total spend"
            value={formatDollars(s.roi.totalSpendCents)}
            sub={`Direct ${formatDollars(s.roi.spendCents)} · retainer ${formatDollars(s.roi.retainerSpendCents)}`}
          />
          <HeadlineStat
            label="First-touch leads"
            value={String(s.roi.firstTouchLeads)}
          />
          <HeadlineStat
            label="Tours"
            value={String(s.roi.firstTouchTours)}
          />
          <HeadlineStat
            label="Bookings"
            value={String(s.roi.firstTouchBookings)}
          />
          <HeadlineStat
            label="Booked revenue"
            value={formatDollars(s.roi.bookedRevenueCents)}
          />
          <HeadlineStat
            label="True CAC"
            value={formatDollars(s.roi.costPerBookingCents)}
            sub={
              s.roi.costPerLeadCents !== null
                ? `${formatDollars(s.roi.costPerLeadCents)} / lead`
                : undefined
            }
            highlight
          />
        </div>
      </section>

      {/* Conflict findings */}
      {report.conflictFindings ? (
        <section className="tbh-page-break">
          <h2 className="font-serif text-xl">
            {report.mode === 'internal'
              ? 'Conflict findings'
              : 'Divergence analysis'}
          </h2>
          <div className="mt-3 whitespace-pre-wrap rounded-lg border border-[var(--bh-line)] bg-[var(--bh-warm-50)]/40 p-4 text-sm leading-7">
            {report.conflictFindings}
          </div>
        </section>
      ) : null}

      {/* Per-channel breakdown */}
      {s.breakdown.perChannel.length > 0 ? (
        <section>
          <h2 className="font-serif text-xl">Per-channel breakdown</h2>
          <table className="mt-4 w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--bh-line)] text-left text-[10px] uppercase tracking-wide text-[var(--bh-muted)]">
                <th className="py-2 pr-2">Channel</th>
                <th className="py-2 pr-2 text-right">Spend</th>
                <th className="py-2 pr-2 text-right">Leads</th>
                <th className="py-2 pr-2 text-right">Tours</th>
                <th className="py-2 pr-2 text-right">Bookings</th>
                <th className="py-2 pr-2 text-right">$/lead</th>
                <th className="py-2 pr-2 text-right">$/booking</th>
                <th className="py-2 pr-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {s.breakdown.perChannel.map((c) => (
                <tr key={c.channelKey} className="border-b border-[var(--bh-line)]/60">
                  <td className="py-2 pr-2 font-medium">{c.channelKey}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatDollars(c.spendCents)}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {c.firstTouchLeads}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {c.firstTouchTours}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {c.firstTouchBookings}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatDollars(c.costPerLeadCents)}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatDollars(c.costPerBookingCents)}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatDollars(c.bookedRevenueCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {/* 12-month trend (print-friendly text version) */}
      {s.breakdown.monthlyTrend.length > 0 ? (
        <section>
          <h2 className="font-serif text-xl flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> 12-month trend
          </h2>
          <div className="mt-3 grid grid-cols-12 gap-1">
            {s.breakdown.monthlyTrend.slice(-12).map((m) => {
              const max = Math.max(
                ...s.breakdown.monthlyTrend.map((x) => x.totalCents),
                1,
              )
              const h = (m.totalCents / max) * 100
              return (
                <div key={m.month}>
                  <div className="h-24 flex flex-col-reverse bg-[var(--bh-warm-50)]/40 rounded">
                    <div
                      className="bg-[var(--bh-sage-500)] rounded-t"
                      style={{
                        height: `${h}%`,
                        minHeight: m.totalCents > 0 ? '2px' : 0,
                      }}
                    />
                  </div>
                  <div className="mt-1 text-center text-[9px] text-[var(--bh-muted)]">
                    {m.month.slice(5, 7)}/{m.month.slice(2, 4)}
                  </div>
                  <div className="text-center text-[10px] tabular-nums">
                    {m.firstTouchLeads || '–'}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-[10px] text-[var(--bh-muted)]">
            Bars: total monthly cost. Labels: first-touch leads.
          </p>
        </section>
      ) : null}

      {/* KPI truth-vs-claim */}
      {s.kpiPerformance.length > 0 ? (
        <section className="tbh-page-break">
          <h2 className="font-serif text-xl">KPI truth vs claim</h2>
          <p className="mt-1 text-xs text-[var(--bh-muted)]">
            Commitments compared against measured actuals over the period.
          </p>
          <div className="mt-4 space-y-2">
            {s.kpiPerformance.map((k, i) => (
              <div
                key={i}
                className="rounded-lg border border-[var(--bh-line)] p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <StatusIcon status={k.status} />
                    <span className="font-medium">{k.metricDisplay}</span>
                    <span className="text-xs text-[var(--bh-muted)]">
                      ({k.targetWindow})
                    </span>
                  </div>
                  <span className="text-xs">{k.statusLabel}</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-[10px] uppercase text-[var(--bh-muted)]">
                      Promised
                    </span>
                    <div className="font-serif text-base tabular-nums">
                      {k.targetValue} {k.targetUnit}
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase text-[var(--bh-muted)]">
                      Measured
                    </span>
                    <div className="font-serif text-base tabular-nums">
                      {k.actualValue !== null
                        ? `${k.actualValue.toFixed(1)} ${k.targetUnit}`
                        : '—'}
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase text-[var(--bh-muted)]">
                      Gap
                    </span>
                    <div className="font-serif text-base tabular-nums">
                      {k.gapPct === null
                        ? '—'
                        : `${k.gapPct > 0 ? '+' : ''}${k.gapPct.toFixed(0)}%`}
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-[var(--bh-muted)]">
                  {k.reasoning}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Persona overlay */}
      {Object.keys(s.breakdown.personaCounts).length > 0 ? (
        <section>
          <h2 className="font-serif text-xl">Persona distribution</h2>
          <div className="mt-3 space-y-1">
            {Object.entries(s.breakdown.personaCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([p, n]) => (
                <div key={p} className="flex items-baseline justify-between text-xs">
                  <span>{p}</span>
                  <span className="tabular-nums text-[var(--bh-muted)]">{n}</span>
                </div>
              ))}
          </div>
        </section>
      ) : null}

      {/* Activity highlights */}
      {s.activityHighlights.length > 0 ? (
        <section>
          <h2 className="font-serif text-xl">Period highlights</h2>
          <ol className="mt-3 relative space-y-2 border-l border-[var(--bh-line)] pl-4">
            {s.activityHighlights.map((h, i) => (
              <li key={i} className="text-sm">
                <div className="text-[10px] text-[var(--bh-muted)]">
                  {formatDate(h.occurredAt)} · {h.kind.replace(/_/g, ' ')}
                </div>
                <div className="font-medium">{h.summary}</div>
                {h.body ? (
                  <p className="text-xs text-[var(--bh-ink)]">{h.body}</p>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* Recommendations */}
      {report.recommendations ? (
        <section className="tbh-page-break">
          <h2 className="font-serif text-xl">Recommendations</h2>
          <div className="mt-3 whitespace-pre-wrap rounded-lg border border-[var(--bh-line)] bg-[var(--bh-sage-50)]/40 p-4 text-sm leading-7">
            {report.recommendations}
          </div>
        </section>
      ) : null}

      {/* Notes to send to the agency (shareable mode only) */}
      {report.mode === 'shareable' && report.notesForAgency ? (
        <section>
          <h2 className="font-serif text-xl flex items-center gap-2">
            <Briefcase className="h-4 w-4" /> Cover note for the agency
          </h2>
          <div className="mt-3 whitespace-pre-wrap rounded-lg border border-[var(--bh-line)] bg-white p-4 italic">
            {report.notesForAgency}
          </div>
        </section>
      ) : null}

      {/* Coverage disclosure */}
      <section>
        <h2 className="font-serif text-xl">Measurement coverage</h2>
        <p className="mt-2 text-xs text-[var(--bh-muted)]">
          Every number above is constrained by what Bloom can actually see.
          This section discloses the load-bearing gaps.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3 text-xs">
          <CoverageBadge
            label="Web pixel"
            status={s.coverage.pixel}
            ok="installed"
          />
          <CoverageBadge
            label="Google Ads OAuth"
            status={s.coverage.googleAdsOAuth}
            ok="connected"
          />
          <CoverageBadge
            label="Calendly Q&A"
            status={s.coverage.calendlyQa}
            ok="capturing"
          />
        </div>
        {s.coverage.attributionStart ? (
          <p className="mt-3 text-xs text-[var(--bh-muted)]">
            Earliest attribution event in this agency&apos;s channels:{' '}
            {formatDate(s.coverage.attributionStart)}.
          </p>
        ) : null}
        <ul className="mt-3 list-disc pl-5 text-xs text-[var(--bh-muted)] space-y-1">
          {s.coverage.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </section>

      {/* Footer */}
      <footer className="border-t border-[var(--bh-line)] pt-4 text-center text-[10px] uppercase tracking-[0.2em] text-[var(--bh-muted)]">
        TBH · {report.shortCode} · {s.windowDays}-day window · generated by The Bloom House
      </footer>
    </article>
  )
}

function HeadlineStat({
  label,
  value,
  sub,
  highlight,
}: {
  label: string
  value: string
  sub?: string
  highlight?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        highlight
          ? 'border-[var(--bh-sage-500)] bg-[var(--bh-sage-50)]/40'
          : 'border-[var(--bh-line)] bg-white'
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-[var(--bh-muted)]">
        {label}
      </div>
      <div className="mt-1 font-serif text-xl tabular-nums">{value}</div>
      {sub ? (
        <div className="mt-0.5 text-[10px] text-[var(--bh-muted)]">{sub}</div>
      ) : null}
    </div>
  )
}

function CoverageBadge({
  label,
  status,
  ok,
}: {
  label: string
  status: string
  ok: string
}) {
  const isOk = status === ok
  return (
    <div
      className={`rounded-lg border p-2 ${
        isOk
          ? 'border-emerald-200 bg-emerald-50/40'
          : 'border-amber-200 bg-amber-50/40'
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-[var(--bh-muted)]">
        {label}
      </div>
      <div className="mt-0.5 font-medium">
        {status.replace(/_/g, ' ')}
      </div>
    </div>
  )
}
