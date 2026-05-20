'use client'

/**
 * /intel/attribution — D3 couple-keyed source attribution (Tier 8 T8.2).
 *
 * Reads /api/admin/intel/couple-attribution and renders four sections:
 *
 *  - Meta strip: couple count, booked count, acquisition-touch count,
 *    couples-without-acquisition-touch honesty card.
 *  - Channel rollup: per-channel × per-model. Model selector swaps which
 *    cell is shown. Highest-volume vs highest-conversion are badged
 *    distinctly so the operator can see they may differ (Q26).
 *  - Content mentions: which content families correlate with booking
 *    (Q28). enoughData-gated lift.
 *  - Per-couple drill-down: pick a couple, see their ordered touchpoint
 *    ribbon, then see how each of the four models distributed credit
 *    across channels for that couple (Q5 "show the logic").
 *
 * Honesty doctrine (§C.6 Tier 4): every cell carries its own n, rates
 * use safe ratios (null on zero denominator), and not-enough-data is
 * called out instead of hidden behind a confident-looking 0%.
 */

import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Share2,
  Layers,
  ScanLine,
  Loader2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  ArrowRight,
  CircleDot,
} from 'lucide-react'
import type {
  AttributionResult,
  AttributionModel,
  ChannelModelCell,
  CoupleAttributionRow,
} from '@/lib/services/attribution/couple-attribution'
import { ATTRIBUTION_MODELS } from '@/lib/services/attribution/couple-attribution'

interface ApiResponse {
  ok: boolean
  venueName?: string
  intel?: AttributionResult
  error?: string
}

const MODEL_LABEL: Record<AttributionModel, string> = {
  first_touch: 'First touch',
  last_touch: 'Last touch',
  linear: 'Linear',
  time_decay: 'Time decay (14d)',
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtNum(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function fmtPct(r: number | null): string {
  if (r === null) return '—'
  return `${Math.round(r * 100)}%`
}

function fmtMoney(cents: number | null): string {
  if (cents === null) return '—'
  return `$${Math.round(cents / 100).toLocaleString()}`
}

function fmtRatio(r: number | null): string {
  if (r === null) return '—'
  return `${r.toFixed(2)}×`
}

// ---------------------------------------------------------------------------
// Section primitive (matches /intel/cohort styling)
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AttributionPage() {
  const [data, setData] = useState<AttributionResult | null>(null)
  const [venueName, setVenueName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<AttributionModel>('first_touch')
  const [openCouple, setOpenCouple] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/intel/couple-attribution', {
        cache: 'no-store',
      })
      const body: ApiResponse = await res.json()
      if (!body.ok || !body.intel) {
        setError(body.error ?? 'Failed to load attribution')
      } else {
        setData(body.intel)
        setVenueName(body.venueName ?? null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Pre-compute highest-volume + highest-conversion channel under the
  // current model so we can badge them on the channel rollup. Doctrine
  // (Q26): highest-volume is not necessarily highest-conversion; the
  // surface must make that distinction visible.
  const volumeLeader = useMemo(() => {
    if (!data) return null
    const acqChannels = data.channels.filter((c) => c.isAcquisition)
    if (acqChannels.length === 0) return null
    return acqChannels.reduce((max, c) =>
      c.models[model].weightedCouples > max.models[model].weightedCouples ? c : max,
    )
  }, [data, model])

  const conversionLeader = useMemo(() => {
    if (!data) return null
    const acqChannels = data.channels
      .filter((c) => c.isAcquisition && c.models[model].enoughData)
    if (acqChannels.length === 0) return null
    return acqChannels.reduce((best, c) => {
      const r = c.models[model].inquiryToBookingRate ?? -1
      const br = best.models[model].inquiryToBookingRate ?? -1
      return r > br ? c : best
    })
  }, [data, model])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-sage-900">
          Source attribution
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Where couples came from, under four multi-touch models — read
          directly from the identity-first spine (couples + touchpoints).
          {venueName ? ` · ${venueName}` : ''}
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sage-600 px-2 py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading attribution…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-900 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Could not load attribution</div>
            <div className="text-rose-700 mt-0.5">{error}</div>
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Meta strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetaCard label="Couples" value={fmtNum(data.meta.coupleCount)} />
            <MetaCard label="Booked" value={fmtNum(data.meta.coupleBookedCount)} />
            <MetaCard
              label="Acquisition touches"
              value={fmtNum(data.meta.acquisitionTouchCount)}
              hint="non-plumbing inbound signals"
            />
            <MetaCard
              label="Plumbing touches"
              value={fmtNum(data.meta.plumbingTouchCount)}
              hint="gmail / sms / calendly / honeybook"
            />
          </div>

          {data.meta.couplesWithoutAcquisitionTouch > 0 && (
            <div className="px-4 py-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm">
              <div className="font-medium mb-0.5">
                {fmtNum(data.meta.couplesWithoutAcquisitionTouch)} of{' '}
                {fmtNum(data.meta.coupleCount)} couples have zero acquisition
                touchpoints
              </div>
              <div className="text-amber-800">
                These appear in the rollup totals under{' '}
                <code>(unknown_acquisition)</code> rather than crediting plumbing
                channels. The most common cause is a couple that was mirrored
                from the legacy weddings table without the Tracer re-binding
                its interactions — re-run the Tracer for affected couples.
              </div>
            </div>
          )}

          {!data.meta.marketingSpendAvailable && (
            <div className="px-4 py-3 rounded-lg border border-sage-200 bg-warm-white text-sage-800 text-sm">
              {data.meta.marketingSpendNote}
            </div>
          )}
          {data.meta.marketingSpendAvailable && data.meta.marketingSpendNote && (
            <div className="text-xs text-sage-500">
              {data.meta.marketingSpendNote}
            </div>
          )}

          {/* Model selector + explainer */}
          <Section
            icon={<Layers className="w-4 h-4" />}
            title="Attribution model"
            hint="Q5 — show the logic"
          >
            <div className="flex items-center gap-1 border border-border rounded-lg p-1 bg-warm-white mb-3 w-full sm:w-fit overflow-x-auto">
              {ATTRIBUTION_MODELS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setModel(m)}
                  className={`px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors ${
                    model === m
                      ? 'bg-sage-600 text-white'
                      : 'text-sage-700 hover:bg-sage-100'
                  }`}
                >
                  {MODEL_LABEL[m]}
                </button>
              ))}
            </div>
            <p className="text-sm text-sage-700 leading-relaxed">
              {data.modelExplainers[model]}
            </p>
          </Section>

          {/* Channel rollup */}
          <Section
            icon={<Share2 className="w-4 h-4" />}
            title="Channel rollup"
            hint={`Q26 — volume vs conversion · ${MODEL_LABEL[model]}`}
          >
            {volumeLeader && conversionLeader && volumeLeader.channel !== conversionLeader.channel && (
              <div className="mb-3 text-xs text-sage-700 px-3 py-2 rounded bg-sage-50 border border-sage-200">
                Highest volume is{' '}
                <strong>{volumeLeader.channel}</strong> ({fmtNum(volumeLeader.models[model].weightedCouples)} weighted
                couples), but highest conversion is{' '}
                <strong>{conversionLeader.channel}</strong> ({fmtPct(conversionLeader.models[model].inquiryToBookingRate)}
                ). These are different channels — volume ≠ conversion.
              </div>
            )}
            {volumeLeader && conversionLeader && volumeLeader.channel === conversionLeader.channel && (
              <div className="mb-3 text-xs text-sage-700 px-3 py-2 rounded bg-sage-50 border border-sage-200">
                Highest volume and highest conversion are both{' '}
                <strong>{volumeLeader.channel}</strong> — a single dominant
                channel under this model.
              </div>
            )}
            <div className="overflow-x-auto -mx-6 px-6">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-sage-500 uppercase tracking-wide">
                  <tr>
                    <th className="py-2">Channel</th>
                    <th className="py-2 text-right">Couples</th>
                    <th className="py-2 text-right">Booked</th>
                    <th className="py-2 text-right">Conversion</th>
                    <th className="py-2 text-right">Spend</th>
                    <th className="py-2 text-right">CAC</th>
                    <th className="py-2 text-right">Rev/$</th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.map((row) => {
                    const cell = row.models[model]
                    return (
                      <ChannelRow
                        key={row.channel}
                        channel={row.channel}
                        isAcquisition={row.isAcquisition}
                        cell={cell}
                        isVolumeLeader={volumeLeader?.channel === row.channel}
                        isConversionLeader={
                          conversionLeader?.channel === row.channel
                        }
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-sage-500 mt-3">
              Couples = weighted under the selected model (linear &amp; time
              decay can produce fractions). Booked = same weight applied to
              the couple&apos;s booked outcome. Conversion = booked / couples
              in this cell. Cells with n &lt; 8 distinct couples are dimmed.
            </p>
          </Section>

          {/* Content mentions */}
          <Section
            icon={<ScanLine className="w-4 h-4" />}
            title="Content mentions"
            hint="Q28 — does mentioning a specific piece of content correlate with booking?"
          >
            <div className="overflow-x-auto -mx-6 px-6">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-sage-500 uppercase tracking-wide">
                  <tr>
                    <th className="py-2">Mention</th>
                    <th className="py-2 text-right">Couples</th>
                    <th className="py-2 text-right">Booked</th>
                    <th className="py-2 text-right">Conversion</th>
                    <th className="py-2 text-right">Cohort base</th>
                    <th className="py-2 text-right">Lift</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contentMentions.map((row) => (
                    <tr
                      key={row.family}
                      className="border-t border-border first:border-t-0"
                    >
                      <td className="py-2 font-medium text-sage-900">
                        {row.label}
                      </td>
                      <td className="py-2 text-right">
                        {fmtNum(row.couplesMentioning)}
                      </td>
                      <td className="py-2 text-right">
                        {fmtNum(row.bookedAmongMentioning)}
                      </td>
                      <td className="py-2 text-right">
                        {row.enoughData ? (
                          fmtPct(row.mentionConversion)
                        ) : (
                          <span className="text-amber-700" title={`n=${row.couplesMentioning} is below the n≥8 reporting floor.`}>
                            n={row.couplesMentioning}
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right text-sage-500">
                        {fmtPct(row.cohortConversion)}
                      </td>
                      <td className="py-2 text-right">
                        {row.enoughData ? fmtRatio(row.lift) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-sage-500 mt-3">
              Lift = mention conversion / cohort base. 1.0× means mentioners
              convert at the same rate as the cohort; 1.5× means 50% better.
              Reported only when at least 8 couples mention the family.
            </p>
          </Section>

          {/* Per-couple drill-down */}
          <Section
            icon={<CircleDot className="w-4 h-4" />}
            title="Per-couple ribbon"
            hint="Q5 — see exactly how credit was distributed for a single couple"
          >
            <p className="text-sm text-sage-700 mb-3">
              Pick a couple to see their ordered touchpoint ribbon. Below the
              ribbon, each of the four models reports which channels got
              credit and how much.
            </p>
            <div className="divide-y divide-border border border-border rounded-lg">
              {data.couples.slice(0, 40).map((c) => (
                <CoupleDrillDown
                  key={c.coupleId}
                  couple={c}
                  open={openCouple === c.coupleId}
                  onToggle={() =>
                    setOpenCouple((cur) => (cur === c.coupleId ? null : c.coupleId))
                  }
                />
              ))}
            </div>
            {data.couples.length > 40 && (
              <p className="text-xs text-sage-500 mt-2">
                Showing 40 of {data.couples.length.toLocaleString()} couples.
              </p>
            )}
          </Section>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

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

function ChannelRow({
  channel,
  isAcquisition,
  cell,
  isVolumeLeader,
  isConversionLeader,
}: {
  channel: string
  isAcquisition: boolean
  cell: ChannelModelCell
  isVolumeLeader: boolean
  isConversionLeader: boolean
}) {
  const dim = !cell.enoughData
  return (
    <tr className="border-t border-border first:border-t-0">
      <td className="py-2">
        <div className="flex items-center gap-2">
          <span
            className={`font-medium ${
              isAcquisition ? 'text-sage-900' : 'text-sage-500'
            }`}
          >
            {channel}
          </span>
          {!isAcquisition && (
            <span className="text-[10px] text-sage-500 uppercase tracking-wide bg-sage-50 px-1.5 py-0.5 rounded">
              plumbing
            </span>
          )}
          {isVolumeLeader && (
            <span className="text-[10px] text-amber-800 uppercase tracking-wide bg-amber-50 px-1.5 py-0.5 rounded">
              top volume
            </span>
          )}
          {isConversionLeader && (
            <span className="text-[10px] text-emerald-800 uppercase tracking-wide bg-emerald-50 px-1.5 py-0.5 rounded">
              top conversion
            </span>
          )}
        </div>
      </td>
      <td className={`py-2 text-right ${dim ? 'text-sage-500' : ''}`}>
        {fmtNum(cell.weightedCouples)}
        {dim && (
          <span className="text-[10px] text-sage-400 ml-1">n={cell.distinctCouples}</span>
        )}
      </td>
      <td className={`py-2 text-right ${dim ? 'text-sage-500' : ''}`}>
        {fmtNum(cell.weightedBooked)}
      </td>
      <td className={`py-2 text-right ${dim ? 'text-sage-500' : ''}`}>
        {cell.enoughData ? fmtPct(cell.inquiryToBookingRate) : '—'}
      </td>
      <td className="py-2 text-right text-sage-700">
        {fmtMoney(cell.spendCents)}
      </td>
      <td className="py-2 text-right text-sage-700">
        {fmtMoney(cell.cacCents)}
      </td>
      <td className="py-2 text-right text-sage-700">
        {fmtRatio(cell.revenuePerDollar)}
      </td>
    </tr>
  )
}

function CoupleDrillDown({
  couple,
  open,
  onToggle,
}: {
  couple: CoupleAttributionRow
  open: boolean
  onToggle: () => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 py-3 hover:bg-sage-50/60 transition-colors flex items-center gap-3"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-sage-500 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-sage-500 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-sage-900 truncate">
            {couple.primaryName ?? '(no name)'}
          </div>
          <div className="text-xs text-sage-500">
            {couple.lifecycleState} · {couple.ribbon.length} touchpoints
            {couple.acquisitionTouchCount > 0
              ? `, ${couple.acquisitionTouchCount} acquisition`
              : ', no acquisition touch'}
            {couple.bookedAt && ' · booked'}
          </div>
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4 pl-12 space-y-3">
          {/* Ribbon */}
          <div>
            <div className="text-xs uppercase tracking-wide text-sage-500 mb-1.5">
              Touchpoint ribbon
            </div>
            <ol className="space-y-1">
              {couple.ribbon.map((tp, idx) => (
                <li
                  key={tp.id}
                  className="text-xs flex items-center gap-2"
                >
                  <span className="font-mono text-sage-400 w-6 shrink-0">
                    {idx + 1}.
                  </span>
                  <span
                    className={`font-medium ${
                      tp.isAcquisition ? 'text-sage-900' : 'text-sage-500'
                    }`}
                  >
                    {tp.channel}
                  </span>
                  <span className="text-sage-500">{tp.actionType}</span>
                  <ArrowRight className="w-3 h-3 text-sage-400 shrink-0" />
                  <span className="text-sage-500">{tp.direction}</span>
                  <span className="text-sage-400">
                    · {new Date(tp.occurredAt).toLocaleDateString()}
                  </span>
                  {!tp.isAcquisition && tp.direction === 'inbound' && (
                    <span className="text-[10px] text-sage-400 uppercase tracking-wide ml-1">
                      plumbing
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>

          {/* Credits across all 4 models */}
          <div>
            <div className="text-xs uppercase tracking-wide text-sage-500 mb-1.5">
              Credit by model
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {ATTRIBUTION_MODELS.map((m) => (
                <div
                  key={m}
                  className="border border-border rounded-md px-3 py-2 bg-warm-white"
                >
                  <div className="text-xs font-medium text-sage-700 mb-1">
                    {MODEL_LABEL[m]}
                  </div>
                  <div className="space-y-0.5">
                    {couple.credits[m].length === 0 ? (
                      <div className="text-xs text-sage-400">no credit</div>
                    ) : (
                      couple.credits[m].map((c) => (
                        <div
                          key={c.channel}
                          className="flex items-center gap-2 text-xs"
                        >
                          <span
                            className={
                              c.channel === '(unknown_acquisition)'
                                ? 'text-amber-700'
                                : 'text-sage-900'
                            }
                          >
                            {c.channel}
                          </span>
                          <span className="text-sage-500">
                            {fmtPct(c.weight)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
