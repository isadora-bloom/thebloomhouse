'use client'

/**
 * Wave 6B — marketing ROI dashboard wrapper.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (6B: dashboard surfaces the
 * persona × channel heatmap + top-line numbers + biggest disparities).
 *
 * Composition:
 *   - Hero row of blended metrics (spend / CAC / conversion / ROI)
 *   - Window selector (30 / 90 / 365 days)
 *   - Heatmap (PersonaChannelHeatmap)
 *   - Top opportunity cards (3 biggest ROI disparities)
 *   - Per-channel cards (spend / inquiries / conversion / CAC / ROI
 *     broken out by persona)
 *   - Footer with last_computed_at + Recompute now button
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  DollarSign,
  Target,
  Users,
} from 'lucide-react'
import { PersonaChannelHeatmap, type HeatmapCell } from './PersonaChannelHeatmap'

interface SummaryResponse {
  ok: true
  venueId: string
  window: { days: number; start: string | null; end: string | null }
  totals: {
    spend_cents: number
    inquiries: number
    booked: number
    conversion_pct: number | null
    blended_cac_cents: number | null
    blended_roi_pct: number | null
    total_booked_value_cents: number
  }
  topChannelsBySpend: Array<{
    channel: string
    spend_cents: number
    share_pct: number
  }>
  topPersonasBySize: Array<{ persona_label: string; inquiries: number }>
  biggestDisparities: Array<{
    channel: string
    persona_label: string
    roi_pct: number
    channel_avg_roi_pct: number
    ratio: number
    spend_cents: number
    booked_count: number
    kind: 'over' | 'under'
  }>
  lastComputedAt: string | null
  empty: boolean
}

interface HeatmapResponse {
  ok: true
  venueId: string
  window: { days: number; start: string | null; end: string | null }
  personas: string[]
  channels: string[]
  cells: HeatmapCell[]
  lastComputedAt: string | null
  empty: boolean
}

type WindowOption = 30 | 90 | 365

const WINDOW_OPTIONS: WindowOption[] = [30, 90, 365]

function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  const dollars = cents / 100
  if (dollars >= 1000) {
    return `$${(dollars / 1000).toFixed(1)}k`
  }
  return `$${dollars.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`
}

function formatPct(pct: number | null): string {
  if (pct === null) return '—'
  return `${pct.toFixed(1)}%`
}

function formatPersonaLabel(p: string): string {
  if (p === '__untagged__') return 'Untagged'
  return p.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatChannelLabel(c: string): string {
  const map: Record<string, string> = {
    google_ads: 'Google Ads',
    meta_ads: 'Meta Ads',
    tiktok_ads: 'TikTok Ads',
    theknot_fee: 'The Knot',
    weddingwire_fee: 'WeddingWire',
    organic_seo: 'Organic SEO',
    vendor_referral: 'Vendor Referral',
    other: 'Other',
  }
  return (
    map[c] ??
    c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
  )
}

function relativeTimeIso(iso: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'never'
  const diffMs = Date.now() - t
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}

export function MarketingRoiDashboard() {
  const [windowDays, setWindowDays] = useState<WindowOption>(90)
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [recomputing, setRecomputing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null)

  const fetchAll = useCallback(async (days: WindowOption) => {
    setLoading(true)
    setErr(null)
    try {
      const [sResp, hResp] = await Promise.all([
        fetch(`/api/admin/intel/marketing-roi/summary?windowDays=${days}`),
        fetch(`/api/admin/intel/marketing-roi/heatmap?windowDays=${days}`),
      ])
      if (sResp.ok) {
        const j = (await sResp.json()) as SummaryResponse
        setSummary(j)
      }
      if (hResp.ok) {
        const j = (await hResp.json()) as HeatmapResponse
        setHeatmap(j)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchAll(windowDays)
  }, [fetchAll, windowDays])

  const handleRecompute = useCallback(async () => {
    setRecomputing(true)
    setRecomputeMsg(null)
    try {
      const resp = await fetch('/api/admin/intel/marketing-roi/recompute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowDays }),
      })
      const j = (await resp.json()) as {
        ok: boolean
        cellsWritten?: number
        error?: string
      }
      if (!resp.ok || !j.ok) {
        setRecomputeMsg(`Recompute failed: ${j.error ?? 'unknown error'}`)
      } else {
        setRecomputeMsg(`Recomputed. ${j.cellsWritten ?? 0} cells written.`)
        await fetchAll(windowDays)
      }
    } catch (e) {
      setRecomputeMsg(
        `Recompute threw: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setRecomputing(false)
    }
  }, [fetchAll, windowDays])

  const perChannelBreakdown = useMemo(() => {
    if (!heatmap) return []
    const byChannel = new Map<
      string,
      Array<{
        persona: string
        cell: HeatmapCell
      }>
    >()
    for (const c of heatmap.cells) {
      if (!byChannel.has(c.channel)) byChannel.set(c.channel, [])
      byChannel.get(c.channel)!.push({ persona: c.persona_label, cell: c })
    }
    // Order channels by total spend desc.
    return Array.from(byChannel.entries())
      .map(([channel, entries]) => {
        const totalSpend = entries.reduce((s, e) => s + e.cell.spend_cents, 0)
        const totalInquiries = entries.reduce(
          (s, e) => s + e.cell.inquiries_count,
          0,
        )
        const totalBooked = entries.reduce(
          (s, e) => s + e.cell.booked_count,
          0,
        )
        return { channel, totalSpend, totalInquiries, totalBooked, entries }
      })
      .sort((a, b) => b.totalSpend - a.totalSpend)
  }, [heatmap])

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl text-stone-900">
            Marketing ROI
          </h1>
          <p className="mt-1 text-sm text-stone-600">
            Persona × channel × revenue. ROI per channel without the
            persona overlay is a lie. Cells with fewer than 10 leads are
            grayed out.
          </p>
          <p className="mt-2 text-xs text-stone-500">
            Looking for forensic Discovery / Validation / Broadcast splits or the
            Wedding MBA presentation export? See the{' '}
            <a
              href="/intel/channels"
              className="text-sage-700 hover:text-sage-900 underline underline-offset-2"
            >
              Channel Intelligence Hub
            </a>{' '}
            (the newer hub).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-stone-200 bg-white p-1">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setWindowDays(opt)}
                className={`px-3 py-1 text-xs rounded ${
                  windowDays === opt
                    ? 'bg-stone-900 text-white'
                    : 'text-stone-600 hover:bg-stone-100'
                }`}
              >
                {opt}d
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleRecompute}
            disabled={recomputing}
            className="inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3 py-2 text-xs hover:bg-stone-50 disabled:opacity-50"
          >
            {recomputing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Recompute now
          </button>
        </div>
      </div>

      {err ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {err}
        </div>
      ) : null}
      {recomputeMsg ? (
        <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
          {recomputeMsg}
        </div>
      ) : null}

      {/* Hero stats */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HeroStat
          icon={<DollarSign className="h-4 w-4" />}
          label="Total spend"
          value={formatCents(summary?.totals.spend_cents ?? 0)}
          sub={`${summary?.totals.inquiries ?? 0} inquiries, ${
            summary?.totals.booked ?? 0
          } booked`}
        />
        <HeroStat
          icon={<Target className="h-4 w-4" />}
          label="Blended CAC"
          value={formatCents(summary?.totals.blended_cac_cents ?? null)}
          sub="spend / booked"
        />
        <HeroStat
          icon={<Users className="h-4 w-4" />}
          label="Blended conversion"
          value={formatPct(summary?.totals.conversion_pct ?? null)}
          sub="booked / inquiries"
        />
        <HeroStat
          icon={<TrendingUp className="h-4 w-4" />}
          label="Blended ROI"
          value={formatPct(summary?.totals.blended_roi_pct ?? null)}
          sub={formatCents(summary?.totals.total_booked_value_cents ?? 0)}
        />
      </section>

      {/* Heatmap */}
      <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="font-serif text-lg text-stone-900">
            Persona × channel heatmap
          </h2>
          <span className="text-xs text-stone-500">
            Last {windowDays} days · {heatmap?.cells.length ?? 0} cells
          </span>
        </div>
        {loading && !heatmap ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : heatmap ? (
          <div className="mt-4">
            <PersonaChannelHeatmap rollups={heatmap} windowDays={windowDays} />
          </div>
        ) : null}
      </section>

      {/* Top opportunities */}
      <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="font-serif text-lg text-stone-900">
          Top opportunities
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          Cells whose ROI deviates from the channel average by &gt; 2x or
          &lt; 0.5x. Sorted by spend size (biggest leverage first).
        </p>

        {summary && summary.biggestDisparities.length > 0 ? (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            {summary.biggestDisparities.slice(0, 3).map((d, i) => (
              <DisparityCard key={`${d.channel}-${d.persona_label}-${i}`} d={d} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-stone-500">
            No significant disparities yet. Each channel needs at least
            two persona cells with n ≥ 10 to surface a comparison.
          </p>
        )}
      </section>

      {/* Per-channel cards */}
      <section>
        <h2 className="font-serif text-lg text-stone-900 mb-3">
          Per-channel breakdown
        </h2>
        {perChannelBreakdown.length === 0 ? (
          <div className="rounded-md border border-stone-200 bg-white p-5 text-sm text-stone-500">
            No channels yet. Record marketing spend to populate.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {perChannelBreakdown.map((ch) => (
              <ChannelCard key={ch.channel} channelData={ch} />
            ))}
          </div>
        )}
      </section>

      {/* Top channels + personas chips */}
      {summary && (
        <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-stone-700">
              Top channels by spend
            </h3>
            <ul className="mt-2 space-y-1 text-sm">
              {summary.topChannelsBySpend.length === 0 ? (
                <li className="text-stone-500">none</li>
              ) : (
                summary.topChannelsBySpend.map((c) => (
                  <li
                    key={c.channel}
                    className="flex items-center justify-between"
                  >
                    <span>{formatChannelLabel(c.channel)}</span>
                    <span className="tabular-nums text-stone-600">
                      {formatCents(c.spend_cents)} ({c.share_pct}%)
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>
          <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-stone-700">
              Top personas by cohort size
            </h3>
            <ul className="mt-2 space-y-1 text-sm">
              {summary.topPersonasBySize.length === 0 ? (
                <li className="text-stone-500">
                  No persona overlay yet. Run the persona catch-up on{' '}
                  /api/admin/marketing-spend/persona-backfill once enough
                  couples have been reconstructed.
                </li>
              ) : (
                summary.topPersonasBySize.map((p) => (
                  <li
                    key={p.persona_label}
                    className="flex items-center justify-between"
                  >
                    <span>{formatPersonaLabel(p.persona_label)}</span>
                    <span className="tabular-nums text-stone-600">
                      {p.inquiries} inq
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="text-xs text-stone-500 pt-2 border-t border-stone-100">
        Last computed: {relativeTimeIso(summary?.lastComputedAt ?? null)}
        {summary?.lastComputedAt
          ? ` (${summary.lastComputedAt.slice(0, 19).replace('T', ' ')} UTC)`
          : null}
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HeroStat({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-stone-500">
        {icon}
        {label}
      </div>
      <div className="mt-2 font-serif text-2xl text-stone-900 tabular-nums">
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-stone-500">{sub}</div> : null}
    </div>
  )
}

function DisparityCard({
  d,
}: {
  d: SummaryResponse['biggestDisparities'][number]
}) {
  const isOver = d.kind === 'over'
  return (
    <div
      className={`rounded-2xl border p-4 ${
        isOver
          ? 'border-emerald-200 bg-emerald-50/50'
          : 'border-rose-200 bg-rose-50/50'
      }`}
    >
      <div className="flex items-center gap-2 text-xs">
        {isOver ? (
          <TrendingUp className="h-3 w-3 text-emerald-700" />
        ) : (
          <AlertTriangle className="h-3 w-3 text-rose-700" />
        )}
        <span
          className={`font-semibold uppercase tracking-wide ${
            isOver ? 'text-emerald-800' : 'text-rose-800'
          }`}
        >
          {isOver ? 'Over-performer' : 'Under-performer'}
        </span>
      </div>
      <div className="mt-2 font-serif text-base text-stone-900">
        {formatChannelLabel(d.channel)} ×{' '}
        {formatPersonaLabel(d.persona_label)}
      </div>
      <div className="mt-2 text-sm text-stone-700 space-y-0.5">
        <div className="tabular-nums">
          ROI {formatPct(d.roi_pct)} (channel avg{' '}
          {formatPct(d.channel_avg_roi_pct)})
        </div>
        <div className="text-xs text-stone-500 tabular-nums">
          {d.ratio.toFixed(2)}x channel avg · {formatCents(d.spend_cents)}{' '}
          spend · {d.booked_count} booked
        </div>
      </div>
      <div className="mt-3 text-xs text-stone-600">
        {isOver
          ? 'Consider reallocating more budget to this persona × channel pairing.'
          : 'Consider redirecting this spend or refining the targeting.'}
      </div>
    </div>
  )
}

function ChannelCard({
  channelData,
}: {
  channelData: {
    channel: string
    totalSpend: number
    totalInquiries: number
    totalBooked: number
    entries: Array<{ persona: string; cell: HeatmapCell }>
  }
}) {
  const { channel, totalSpend, totalInquiries, totalBooked, entries } =
    channelData
  const conversionPct =
    totalInquiries > 0
      ? Math.round((totalBooked / totalInquiries) * 1000) / 10
      : null
  const channelCac = totalBooked > 0 ? totalSpend / totalBooked : null

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-serif text-base text-stone-900">
          {formatChannelLabel(channel)}
        </h3>
        <span className="text-xs text-stone-500 tabular-nums">
          {formatCents(totalSpend)}
        </span>
      </div>
      <div className="mt-1 text-xs text-stone-500 tabular-nums">
        {totalInquiries} inquiries · {totalBooked} booked · CAC{' '}
        {formatCents(channelCac)} · conv{' '}
        {conversionPct === null ? '—' : `${conversionPct.toFixed(1)}%`}
      </div>
      <div className="mt-3 space-y-2">
        {entries
          .sort((a, b) => b.cell.spend_cents - a.cell.spend_cents)
          .map((e) => (
            <div
              key={`${channel}-${e.persona}`}
              className="flex items-baseline justify-between text-xs"
            >
              <span className="text-stone-700">
                {formatPersonaLabel(e.persona)}
              </span>
              <span className="tabular-nums text-stone-600">
                {e.cell.n_too_small ? (
                  <span className="text-stone-400">n &lt; 10</span>
                ) : (
                  <>
                    {formatCents(e.cell.cac_cents)} ·{' '}
                    {formatPct(e.cell.conversion_pct)} ·{' '}
                    {formatPct(e.cell.roi_pct)}
                  </>
                )}
              </span>
            </div>
          ))}
      </div>
    </div>
  )
}
