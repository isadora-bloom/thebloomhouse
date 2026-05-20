'use client'

/**
 * /intel/cohort — "Funnel & Timing" tab (D9, Tier 8 T8.2).
 *
 * Renders the deterministic couple-keyed cohort intel from
 * /api/admin/intel/cohort-funnel: funnel ratios, response-time
 * distributions, booking lead time, the conversion curve, text-pattern
 * trends, YoY volume, weather effects, and anomalies.
 *
 * Honesty (Appendix C §C.6, Tier-4 of the battery): every distribution
 * carries its own n. A median is rendered as a fact only when the
 * service marked `enoughData` true; below the threshold the cell shows
 * the raw n and "not enough data yet" instead of a confident number.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  GitBranch,
  Timer,
  CalendarClock,
  TrendingDown,
  MessageSquareText,
  CalendarRange,
  CloudRain,
  AlertTriangle,
  Loader2,
  AlertCircle,
  ArrowDownRight,
} from 'lucide-react'
import type { CohortIntel, Distribution } from '@/lib/services/cohort/types'

interface ApiResponse {
  ok: boolean
  venueName?: string
  intel?: CohortIntel
  error?: string
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtHours(h: number | null): string {
  if (h === null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

function fmtDays(d: number | null): string {
  if (d === null) return '—'
  if (d < 60) return `${Math.round(d)}d`
  return `${(d / 30.44).toFixed(1)}mo`
}

function fmtPct(r: number | null): string {
  if (r === null) return '—'
  return `${Math.round(r * 100)}%`
}

function fmtMoney(cents: number | null): string {
  if (cents === null) return '—'
  return `$${Math.round(cents / 100).toLocaleString()}`
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

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

/** A distribution median, honesty-gated. Shows the median only when the
 *  service flagged enoughData; otherwise the raw n + a "thin sample"
 *  note. */
function DistMedian({
  dist,
  unit,
}: {
  dist: Distribution
  unit: 'hours' | 'days'
}) {
  const fmt = unit === 'hours' ? fmtHours : fmtDays
  if (dist.n === 0) {
    return <span className="text-sage-400">no data</span>
  }
  if (!dist.enoughData) {
    return (
      <span
        className="text-amber-700"
        title={`Only ${dist.n} observations — too thin to report a median.`}
      >
        n={dist.n}, too thin
      </span>
    )
  }
  return (
    <span>
      <span className="font-semibold text-sage-900">{fmt(dist.median)}</span>{' '}
      <span className="text-[11px] text-sage-500">
        (n={dist.n}, p25 {fmt(dist.p25)} · p75 {fmt(dist.p75)})
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function FunnelTimingTab() {
  const [intel, setIntel] = useState<CohortIntel | null>(null)
  const [venueName, setVenueName] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/intel/cohort-funnel', {
        cache: 'no-store',
      })
      const body = (await res.json()) as ApiResponse
      if (!res.ok || !body.ok || !body.intel) {
        setError(body.error || `HTTP ${res.status}`)
        setIntel(null)
        return
      }
      setIntel(body.intel)
      setVenueName(body.venueName || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-24 bg-sage-50 rounded-xl animate-pulse" />
        <div className="h-64 bg-sage-50 rounded-xl animate-pulse" />
        <div className="h-64 bg-sage-50 rounded-xl animate-pulse" />
      </div>
    )
  }

  if (error || !intel) {
    return (
      <div className="bg-surface border border-rose-200 rounded-xl p-6 shadow-sm">
        <p className="text-sm text-rose-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          Failed to load cohort funnel: {error || 'no data'}
        </p>
        <button
          type="button"
          onClick={load}
          className="mt-3 px-3 py-1.5 text-xs border border-sage-300 text-sage-700 rounded-md hover:bg-sage-50"
        >
          Retry
        </button>
      </div>
    )
  }

  const { funnel, responseTime, leadTime, curve, textPatterns, yoy, weather, anomalies, meta } =
    intel
  const inquiryCount = funnel.overall[0]?.count ?? 0

  return (
    <div className="space-y-6">
      {/* Meta strip */}
      <div className="flex items-center gap-3 text-xs text-sage-600 flex-wrap">
        <span>
          <span className="font-medium text-sage-900">
            {meta.engagedCoupleCount}
          </span>{' '}
          engaged couples
        </span>
        <span>·</span>
        <span>
          <span className="font-medium text-sage-900">
            {meta.touchpointCount}
          </span>{' '}
          touchpoints
        </span>
        {meta.earliestTouchpoint && (
          <>
            <span>·</span>
            <span>
              {meta.earliestTouchpoint.slice(0, 10)} →{' '}
              {meta.latestTouchpoint?.slice(0, 10)}
            </span>
          </>
        )}
        <span>·</span>
        <span className="text-sage-400">{venueName}</span>
      </div>

      {/* ---- Funnel ---- */}
      <Section
        icon={<GitBranch className="w-4 h-4" />}
        title="Couple funnel"
        hint={`${funnel.ghostCount} ghosted · ${funnel.channelScopedCount} channel-scoped`}
      >
        <div className="space-y-2">
          {funnel.overall.map((stage) => {
            const width =
              inquiryCount > 0
                ? Math.max(4, Math.round((stage.count / inquiryCount) * 100))
                : 0
            return (
              <div key={stage.key} className="flex items-center gap-3">
                <div className="w-28 text-sm text-sage-700 shrink-0">
                  {stage.label}
                </div>
                <div className="flex-1 bg-sage-50 rounded h-7 relative overflow-hidden">
                  <div
                    className="bg-sage-500 h-full rounded flex items-center px-2"
                    style={{ width: `${width}%` }}
                  >
                    <span className="text-xs font-medium text-white">
                      {stage.count}
                    </span>
                  </div>
                </div>
                <div className="w-32 text-right text-xs text-sage-500 shrink-0">
                  {stage.fromPrevious !== null && (
                    <span>{fmtPct(stage.fromPrevious)} from prev</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <p className="text-[11px] text-sage-400 mt-3">
          Stages are monotone — a booked couple counts at every upstream
          stage even when an individual touchpoint (e.g. the tour) was never
          captured.
        </p>
      </Section>

      {/* ---- Response time ---- */}
      <Section
        icon={<Timer className="w-4 h-4" />}
        title="Response time"
        hint="first inbound → first venue reply"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="bg-sage-50/60 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wide text-sage-500 font-semibold">
              Overall median
            </div>
            <div className="mt-1 text-sm">
              <DistMedian dist={responseTime.overall} unit="hours" />
            </div>
          </div>
          <div className="bg-sage-50/60 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wide text-sage-500 font-semibold">
              12-month delta
            </div>
            <div className="mt-1 text-sm">
              {responseTime.deltaHours === null ? (
                <span className="text-sage-400">
                  not enough history for a delta
                </span>
              ) : (
                <span
                  className={
                    responseTime.deltaHours <= 0
                      ? 'text-emerald-700'
                      : 'text-rose-700'
                  }
                >
                  {responseTime.deltaHours <= 0 ? 'faster by ' : 'slower by '}
                  {fmtHours(Math.abs(responseTime.deltaHours))}
                  <span className="text-[11px] text-sage-500">
                    {' '}
                    ({fmtHours(responseTime.prior12moMedian)} →{' '}
                    {fmtHours(responseTime.last12moMedian)})
                  </span>
                </span>
              )}
            </div>
          </div>
          <div className="bg-sage-50/60 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wide text-sage-500 font-semibold">
              Inquiries never replied to
            </div>
            <div className="mt-1 text-sm font-semibold text-sage-900">
              {responseTime.neverRepliedCount}
            </div>
          </div>
        </div>

        {/* bookers vs ghosters */}
        <div className="text-[10px] uppercase tracking-wide text-sage-500 font-semibold mb-1">
          Bookers vs ghosters
        </div>
        <table className="w-full text-sm">
          <tbody>
            {responseTime.byOutcome.map((o) => (
              <tr key={o.outcome} className="border-b border-border last:border-0">
                <td className="py-1.5 capitalize text-sage-700 w-32">
                  {o.outcome.replace('_', ' ')}
                </td>
                <td className="py-1.5">
                  <DistMedian dist={o.dist} unit="hours" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* by channel */}
        {responseTime.byChannel.length > 0 && (
          <>
            <div className="text-[10px] uppercase tracking-wide text-sage-500 font-semibold mt-4 mb-1">
              By arrival channel
            </div>
            <table className="w-full text-sm">
              <tbody>
                {responseTime.byChannel.map((c) => (
                  <tr
                    key={c.channel}
                    className="border-b border-border last:border-0"
                  >
                    <td className="py-1.5 text-sage-700 w-32">{c.channel}</td>
                    <td className="py-1.5">
                      <DistMedian dist={c.dist} unit="hours" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Section>

      {/* ---- Lead time ---- */}
      <Section
        icon={<CalendarClock className="w-4 h-4" />}
        title="Booking lead time"
        hint={`${leadTime.couplesWithDate} with a wedding date · ${leadTime.couplesWithoutDate} without`}
      >
        <div className="text-sm mb-3">
          Median lead time:{' '}
          <DistMedian dist={leadTime.dist} unit="days" />
        </div>
        <div className="space-y-1.5">
          {leadTime.histogram.map((b) => {
            const max = Math.max(...leadTime.histogram.map((x) => x.count), 1)
            const w = Math.round((b.count / max) * 100)
            return (
              <div key={b.bucket} className="flex items-center gap-3">
                <div className="w-28 text-xs text-sage-600 shrink-0">
                  {b.bucket}
                </div>
                <div className="flex-1 bg-sage-50 rounded h-5">
                  <div
                    className="bg-teal-500 h-full rounded"
                    style={{ width: `${b.count > 0 ? Math.max(3, w) : 0}%` }}
                  />
                </div>
                <div className="w-8 text-right text-xs text-sage-500">
                  {b.count}
                </div>
              </div>
            )
          })}
        </div>
      </Section>

      {/* ---- Conversion curve ---- */}
      <Section
        icon={<TrendingDown className="w-4 h-4" />}
        title="Response speed → tour conversion"
        hint="where the curve bends"
      >
        <table className="w-full text-sm mb-3">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-sage-500">
              <th className="text-left font-semibold py-1">Response band</th>
              <th className="text-right font-semibold py-1">Couples</th>
              <th className="text-right font-semibold py-1">Tour rate</th>
            </tr>
          </thead>
          <tbody>
            {curve.bands.map((b, i) => (
              <tr
                key={b.label}
                className={`border-b border-border last:border-0 ${
                  curve.kneeBandIndex === i ? 'bg-amber-50/60' : ''
                }`}
              >
                <td className="py-1.5 text-sage-700">
                  {b.label}
                  {curve.kneeBandIndex === i && (
                    <ArrowDownRight className="w-3.5 h-3.5 text-amber-600 inline ml-1" />
                  )}
                </td>
                <td className="py-1.5 text-right text-sage-600">{b.couples}</td>
                <td className="py-1.5 text-right">
                  {b.touredRate === null ? (
                    <span className="text-sage-400">—</span>
                  ) : (
                    <span className="font-medium text-sage-900">
                      {fmtPct(b.touredRate)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-sage-600 italic">{curve.kneeNote}</p>

        {/* pre-tour signals */}
        <div className="text-[10px] uppercase tracking-wide text-sage-500 font-semibold mt-4 mb-1">
          Pre-tour signals — booking vs ghost
        </div>
        <table className="w-full text-sm">
          <tbody>
            {curve.preTourSignals.map((s) => (
              <tr key={s.signal} className="border-b border-border last:border-0">
                <td className="py-1.5 text-sage-700">{s.signal}</td>
                <td className="py-1.5 text-right text-[11px] text-sage-500 w-40">
                  {s.beforeBooking} before booking · {s.beforeGhost} before
                  ghost
                </td>
                <td className="py-1.5 text-right w-20">
                  {s.lift === null ? (
                    <span className="text-sage-400">—</span>
                  ) : (
                    <span
                      className={
                        s.lift >= 1.2
                          ? 'text-emerald-700 font-medium'
                          : s.lift <= 0.8
                            ? 'text-rose-700 font-medium'
                            : 'text-sage-600'
                      }
                    >
                      {s.lift.toFixed(2)}x
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ---- Funnel segments ---- */}
      <Section
        icon={<CalendarRange className="w-4 h-4" />}
        title="Funnel by segment"
        hint="season · tour weekday · holiday window"
      >
        <SegmentTable title="By inquiry season" rows={funnel.bySeason} />
        <SegmentTable
          title="By tour weekday"
          rows={funnel.byTourWeekday}
          mode="tour"
        />
        <SegmentTable
          title="By holiday window of inquiry"
          rows={funnel.byHolidayWindow}
        />
      </Section>

      {/* ---- Text patterns ---- */}
      <Section
        icon={<MessageSquareText className="w-4 h-4" />}
        title="What couples are asking about"
        hint="keyword mentions over time"
      >
        {textPatterns.families.map((f) => {
          const totalMentions = f.monthly.reduce((s, m) => s + m.mentions, 0)
          return (
            <div key={f.family} className="mb-3 last:mb-0">
              <div className="flex items-baseline gap-2">
                <span className="font-medium text-sage-900">{f.label}</span>
                <span className="text-[11px] text-sage-500">
                  {totalMentions} mentions ·{' '}
                  {f.trend === 'insufficient_data'
                    ? 'not enough months'
                    : f.trend}
                </span>
              </div>
              <div className="flex items-end gap-0.5 h-10 mt-1">
                {f.monthly.map((m) => {
                  const max = Math.max(
                    ...f.monthly.map((x) => x.mentions),
                    1,
                  )
                  const h = Math.round((m.mentions / max) * 100)
                  return (
                    <div
                      key={m.month}
                      className="flex-1 bg-sage-200 rounded-t"
                      style={{ height: `${m.mentions > 0 ? Math.max(6, h) : 2}%` }}
                      title={`${m.month}: ${m.mentions}/${m.inboundTotal} inbound`}
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
        <p className="text-[11px] text-sage-400 mt-2">
          {textPatterns.firstMessage.note}
        </p>
      </Section>

      {/* ---- YoY ---- */}
      <Section
        icon={<CalendarRange className="w-4 h-4" />}
        title={`Year over year — ${yoy.thisYearLabel} vs ${yoy.lastYearLabel}`}
        hint="inbound inquiry volume"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-sage-500">
              <th className="text-left font-semibold py-1">Month</th>
              <th className="text-right font-semibold py-1">
                {yoy.lastYearLabel}
              </th>
              <th className="text-right font-semibold py-1">
                {yoy.thisYearLabel}
              </th>
              <th className="text-right font-semibold py-1">Δ</th>
              {yoy.marketingSpendAvailable && (
                <th className="text-right font-semibold py-1">Spend Δ</th>
              )}
            </tr>
          </thead>
          <tbody>
            {yoy.monthly.map((m) => (
              <tr key={m.month} className="border-b border-border last:border-0">
                <td className="py-1 text-sage-700">{m.label}</td>
                <td className="py-1 text-right text-sage-600">{m.lastYear}</td>
                <td className="py-1 text-right text-sage-900 font-medium">
                  {m.thisYear}
                </td>
                <td className="py-1 text-right">
                  {m.deltaPct === null ? (
                    <span className="text-sage-400">—</span>
                  ) : (
                    <span
                      className={
                        m.deltaPct > 0
                          ? 'text-emerald-700'
                          : m.deltaPct < 0
                            ? 'text-rose-700'
                            : 'text-sage-500'
                      }
                    >
                      {m.deltaPct > 0 ? '+' : ''}
                      {m.deltaPct}%
                    </span>
                  )}
                </td>
                {yoy.marketingSpendAvailable && (
                  <td className="py-1 text-right text-[11px] text-sage-500">
                    {fmtMoney(m.lastYearSpendCents)} →{' '}
                    {fmtMoney(m.thisYearSpendCents)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-sage-400 mt-2">{yoy.marketingNote}</p>
      </Section>

      {/* ---- Weather ---- */}
      <Section
        icon={<CloudRain className="w-4 h-4" />}
        title="Weather & tour no-shows"
      >
        {!weather.available ? (
          <p className="text-sm text-sage-500">{weather.note}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-rose-50/50 border border-rose-100 rounded-lg p-3">
                <div className="text-[10px] uppercase tracking-wide text-rose-700 font-semibold">
                  Bad-weather days
                </div>
                <div className="mt-1 text-sm text-sage-900">
                  <span className="font-semibold">
                    {fmtPct(weather.badWeatherNoShowRate)}
                  </span>{' '}
                  no-show
                  <span className="text-[11px] text-sage-500">
                    {' '}
                    ({weather.badWeatherNoShows}/{weather.badWeatherTours})
                  </span>
                </div>
              </div>
              <div className="bg-emerald-50/50 border border-emerald-100 rounded-lg p-3">
                <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold">
                  Fair-weather days
                </div>
                <div className="mt-1 text-sm text-sage-900">
                  <span className="font-semibold">
                    {fmtPct(weather.fairWeatherNoShowRate)}
                  </span>{' '}
                  no-show
                  <span className="text-[11px] text-sage-500">
                    {' '}
                    ({weather.fairWeatherNoShows}/{weather.fairWeatherTours})
                  </span>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-sage-400 mt-2">{weather.note}</p>
          </>
        )}
      </Section>

      {/* ---- Anomalies ---- */}
      <Section
        icon={<AlertTriangle className="w-4 h-4" />}
        title="Volume anomalies"
        hint={`${anomalies.length} flagged`}
      >
        {anomalies.length === 0 ? (
          <p className="text-sm text-sage-500">
            No months deviate sharply from this venue&apos;s baseline — or
            there is not yet enough history (need 6+ months).
          </p>
        ) : (
          <ul className="space-y-2">
            {anomalies.map((a) => (
              <li key={a.month} className="flex items-start gap-2 text-sm">
                <AlertTriangle
                  className={`w-4 h-4 mt-0.5 shrink-0 ${
                    a.severity === 'high'
                      ? 'text-rose-600'
                      : a.severity === 'medium'
                        ? 'text-amber-600'
                        : 'text-sage-500'
                  }`}
                />
                <span className="text-sage-700">{a.note}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="text-[10px] text-sage-400 text-center pt-2">
        Computed {new Date(intel.generatedAt).toLocaleString()} · venue
        timezone {intel.timezone}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Segment table
// ---------------------------------------------------------------------------

function SegmentTable({
  title,
  rows,
  mode = 'inquiry',
}: {
  title: string
  rows: CohortIntel['funnel']['bySeason']
  mode?: 'inquiry' | 'tour'
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="text-[10px] uppercase tracking-wide text-sage-500 font-semibold mb-1">
        {title}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-sage-400">
            <th className="text-left font-medium py-0.5">Segment</th>
            <th className="text-right font-medium py-0.5">
              {mode === 'tour' ? 'Tours' : 'Inquiries'}
            </th>
            {mode === 'inquiry' && (
              <th className="text-right font-medium py-0.5">→ Tour</th>
            )}
            <th className="text-right font-medium py-0.5">→ Booked</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border last:border-0">
              <td className="py-1 text-sage-700">{r.label}</td>
              <td className="py-1 text-right text-sage-600">
                {mode === 'tour' ? r.toured : r.inquiries}
              </td>
              {mode === 'inquiry' && (
                <td className="py-1 text-right text-sage-600">
                  {r.inquiryToTour === null
                    ? '—'
                    : `${Math.round(r.inquiryToTour * 100)}%`}
                </td>
              )}
              <td className="py-1 text-right text-sage-900 font-medium">
                {mode === 'tour'
                  ? r.tourToBooked === null
                    ? '—'
                    : `${Math.round(r.tourToBooked * 100)}%`
                  : r.inquiryToBooked === null
                    ? '—'
                    : `${Math.round(r.inquiryToBooked * 100)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
