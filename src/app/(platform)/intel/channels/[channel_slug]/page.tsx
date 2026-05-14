'use client'

/**
 * Wave 25 — Channel Intelligence Hub per-source deep dive.
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (every cited number anchored to
 *     sample size)
 *   - feedback_self_reported_sources_not_truth.md (Validation segment
 *     explicitly flagged "do not credit to channel")
 *   - PROMPT-BIAS-AUDIT.md (v1-contam disclosure on calibration banner)
 *
 * One channel, full forensic readout. The Wedding MBA talk surface.
 */

import { useEffect, useState, use } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  RefreshCw,
  AlertCircle,
  Compass,
  TrendingDown,
  ScrollText,
} from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { SourceFunnelChart } from '@/components/intel/SourceFunnelChart'
import { SourcePresentationExport } from '@/components/intel/SourcePresentationExport'
import type { PerSourcePayload } from '@/lib/services/channel-intel-hub/types'

type WindowDays = 30 | 90 | 365

function fmt$(cents: number | null): string {
  if (cents === null) return '—'
  return `$${(cents / 100).toFixed(0)}`
}

function fmtPct(r: number | null): string {
  if (r === null) return '—'
  return `${(r * 100).toFixed(1)}%`
}

export default function ChannelSourcePage(
  props: { params: Promise<{ channel_slug: string }> },
) {
  const { channel_slug } = use(props.params)
  const venueId = useVenueId()
  const [windowDays, setWindowDays] = useState<WindowDays>(90)
  const [payload, setPayload] = useState<PerSourcePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [recomputing, setRecomputing] = useState(false)

  async function load() {
    if (!venueId || !channel_slug) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/intel/channels/${channel_slug}/snapshot?venueId=${venueId}&windowDays=${windowDays}`,
      )
      const json = (await res.json()) as PerSourcePayload
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`)
        return
      }
      setPayload(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function recompute() {
    if (!venueId) return
    setRecomputing(true)
    setError(null)
    try {
      await fetch(`/api/admin/intel/channels/${channel_slug}/recompute?venueId=${venueId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ windowDays }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRecomputing(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, channel_slug, windowDays])

  const snapshot = payload?.snapshot
  const narrator = payload?.narrator

  const v1Pct = snapshot
    ? snapshot.sample_sizes.ae_total > 0
      ? (snapshot.confidence_signals.v1_contaminated_count /
          snapshot.sample_sizes.ae_total) *
        100
      : 0
    : 0

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-4">
        <Link
          href="/intel/channels"
          className="inline-flex items-center gap-1 text-sm text-stone-600 hover:text-stone-900"
        >
          <ArrowLeft className="w-4 h-4" />
          All channels
        </Link>
      </div>

      {/* Hero */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-stone-500 mb-2">
            <Compass className="w-3 h-3" />
            Channel Intelligence Hub
          </div>
          <h1 className="text-4xl font-serif text-stone-900 mb-1">
            {snapshot?.display_name ?? channel_slug}
          </h1>
          <p className="text-stone-600">
            {snapshot ? (
              <>
                {snapshot.sample_sizes.unique_weddings} unique weddings ·{' '}
                {snapshot.sample_sizes.ae_total} attribution events · window {windowDays}d
              </>
            ) : (
              'Loading…'
            )}
          </p>
        </div>
        <div className="flex flex-col gap-2 items-end">
          <div className="flex gap-1">
            {([30, 90, 365] as WindowDays[]).map((w) => (
              <button
                key={w}
                onClick={() => setWindowDays(w)}
                className={`px-3 py-1 rounded text-sm ${
                  windowDays === w
                    ? 'bg-stone-800 text-white'
                    : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
          <button
            onClick={recompute}
            disabled={recomputing || !venueId}
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-sage-600 text-white rounded text-sm hover:bg-sage-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${recomputing ? 'animate-spin' : ''}`} />
            {recomputing ? 'Recomputing…' : 'Force refresh snapshot'}
          </button>
        </div>
      </div>

      {/* Calibration banner */}
      {snapshot && (
        <div
          className={`mb-6 rounded-lg p-4 border ${
            v1Pct > 25
              ? 'bg-amber-50 border-amber-300'
              : 'bg-stone-50 border-stone-200'
          }`}
        >
          <div className="flex flex-wrap gap-4 text-xs">
            <span>
              <strong className="text-stone-800">Sample:</strong>{' '}
              <span className="font-mono">{snapshot.sample_sizes.ae_total}</span> AE ·{' '}
              <span className="font-mono">{snapshot.sample_sizes.unique_weddings}</span> weddings
            </span>
            <span>
              <strong className="text-stone-800">v1-contam:</strong>{' '}
              <span className={`font-mono ${v1Pct > 25 ? 'text-amber-700' : 'text-stone-700'}`}>
                {v1Pct.toFixed(1)}%
              </span>
            </span>
            <span>
              <strong className="text-stone-800">freshness:</strong>{' '}
              <span className="font-mono text-stone-700">
                {snapshot.confidence_signals.data_freshness_iso}
              </span>
            </span>
            <span>
              <strong className="text-stone-800">prompts:</strong>{' '}
              <span className="font-mono text-stone-700">
                {snapshot.confidence_signals.prompt_versions_used.length === 0
                  ? '(forensic only)'
                  : snapshot.confidence_signals.prompt_versions_used.join(', ')}
              </span>
            </span>
            <span>
              <strong className="text-stone-800">fn:</strong>{' '}
              <code className="font-mono text-stone-700">
                {snapshot.confidence_signals.computed_with_function}
              </code>
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-700 mt-0.5" />
          <div className="text-sm text-red-800">{error}</div>
        </div>
      )}

      {loading && !payload && (
        <div className="text-stone-500">Loading snapshot + narrator…</div>
      )}

      {snapshot && (
        <div className="space-y-6">
          {/* Narrator headline */}
          {narrator?.headline_pull_quote && (
            <div className="bg-gradient-to-br from-sage-50 to-stone-50 border-l-4 border-sage-700 rounded p-6">
              <ScrollText className="w-4 h-4 text-sage-700 mb-2" />
              <p className="text-2xl font-serif text-sage-900 italic leading-relaxed">
                &ldquo;{narrator.headline_pull_quote}&rdquo;
              </p>
            </div>
          )}

          {/* Narrator refusal */}
          {narrator?.refusal_reason && (
            <div className="bg-red-50 border border-red-200 rounded p-4">
              <div className="text-sm text-red-900">
                <strong>Narrator refused to narrate:</strong> {narrator.refusal_reason}
              </div>
            </div>
          )}

          {/* Story arc */}
          <SourceFunnelChart storyArc={snapshot.story_arc} minSampleSize={10} />

          {/* Narrator paragraphs */}
          {narrator && !narrator.refusal_reason && (
            <div className="bg-white border border-stone-200 rounded-xl p-6 space-y-4">
              <h3 className="text-xl font-serif text-stone-900">Narrative</h3>
              {narrator.story_arc_paragraph && (
                <p className="text-stone-800 leading-relaxed">{narrator.story_arc_paragraph}</p>
              )}
              {narrator.cac_reveal_paragraph && (
                <p className="text-stone-800 leading-relaxed">{narrator.cac_reveal_paragraph}</p>
              )}
              {narrator.recommendation_if_any && (
                <div className="bg-lime-50 border-l-4 border-lime-700 p-4 rounded">
                  <div className="text-xs uppercase tracking-wide text-lime-800 mb-1">
                    Recommendation
                  </div>
                  <p className="text-sm text-stone-900">{narrator.recommendation_if_any}</p>
                </div>
              )}
            </div>
          )}

          {/* Forensic CAC reveal */}
          <div className="bg-gradient-to-r from-amber-50 to-orange-50 border-2 border-amber-300 rounded-xl p-6">
            <div className="flex items-baseline gap-2 mb-4">
              <TrendingDown className="w-5 h-5 text-amber-800" />
              <h3 className="text-xl font-serif text-amber-900">Forensic CAC reveal</h3>
            </div>
            <p className="text-sm text-amber-900 mb-4">
              What this channel <em>looked like</em> it cost per booked wedding vs what it
              actually delivered when broadcast inquiries + cross-platform-footprint rows
              are removed from the denominator.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white rounded p-4 border border-amber-200">
                <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">
                  Spend in window
                </div>
                <div className="text-2xl font-mono text-stone-900">
                  {fmt$(snapshot.cost_metrics.spend_cents)}
                </div>
              </div>
              <div className="bg-white rounded p-4 border border-amber-200">
                <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">
                  Apparent CAC
                </div>
                <div className="text-2xl font-mono text-stone-900">
                  {fmt$(snapshot.cost_metrics.cac_cents)}
                </div>
                <div className="text-xs text-stone-500 mt-1">
                  spend / all booked attributed
                </div>
              </div>
              <div className="bg-white rounded p-4 border-2 border-amber-500">
                <div className="text-xs uppercase tracking-wide text-amber-800 mb-1 font-semibold">
                  Real CAC (strict)
                </div>
                <div className="text-2xl font-mono text-amber-900 font-bold">
                  {fmt$(snapshot.cost_metrics.cac_excluding_broadcast_and_crossplatform_cents)}
                </div>
                <div className="text-xs text-stone-600 mt-1">
                  excluding broadcast + cross-platform
                </div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-stone-700">
              <div>
                <strong>Real CAC (excluding broadcast only):</strong>{' '}
                <span className="font-mono">
                  {fmt$(snapshot.cost_metrics.cac_excluding_broadcast_cents)}
                </span>
              </div>
              <div>
                <strong>Cost per inquiry:</strong>{' '}
                <span className="font-mono">{fmt$(snapshot.cost_metrics.cost_per_inquiry_cents)}</span>{' '}
                · <strong>per tour:</strong>{' '}
                <span className="font-mono">{fmt$(snapshot.cost_metrics.cost_per_tour_cents)}</span>
              </div>
            </div>
          </div>

          {/* Conversion funnel */}
          <div className="bg-white border border-stone-200 rounded-xl p-6">
            <h3 className="text-xl font-serif text-stone-900 mb-4">Conversion funnel</h3>
            <div className="grid grid-cols-3 gap-4">
              <FunnelStep
                label="Inquiries"
                count={snapshot.funnel.inquiries}
                accent="#7D8471"
              />
              <FunnelStep
                label="Tours"
                count={snapshot.funnel.tours}
                accent="#A6894A"
                dropRate={snapshot.funnel.drop_inquiry_to_tour_0_1}
              />
              <FunnelStep
                label="Booked"
                count={snapshot.funnel.booked}
                accent="#2E7D54"
                dropRate={snapshot.funnel.drop_tour_to_booked_0_1}
              />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-4 text-xs text-stone-600">
              <div>Inquiry → Tour: {fmtPct(snapshot.funnel.inquiry_to_tour_rate_0_1)}</div>
              <div>Tour → Booked: {fmtPct(snapshot.funnel.tour_to_booked_rate_0_1)}</div>
              <div>Inquiry → Booked: {fmtPct(snapshot.funnel.inquiry_to_booked_rate_0_1)}</div>
            </div>
          </div>

          {/* Quality */}
          <div className="bg-white border border-stone-200 rounded-xl p-6">
            <h3 className="text-xl font-serif text-stone-900 mb-4">Quality signals</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <QualityCell
                label="Avg booking value"
                value={fmt$(snapshot.quality_metrics.avg_booking_value_cents)}
                muted={snapshot.quality_metrics.avg_booking_value_cents === null}
              />
              <QualityCell
                label="Median lead time"
                value={
                  snapshot.quality_metrics.median_lead_time_days !== null
                    ? `${snapshot.quality_metrics.median_lead_time_days}d`
                    : '—'
                }
                muted={snapshot.quality_metrics.median_lead_time_days === null}
              />
              <QualityCell
                label="Avg review rating"
                value={
                  snapshot.quality_metrics.avg_review_rating !== null
                    ? `${snapshot.quality_metrics.avg_review_rating} / 5`
                    : '—'
                }
                subtext={`n=${snapshot.quality_metrics.review_count}`}
                muted={snapshot.quality_metrics.avg_review_rating === null}
              />
              <QualityCell
                label="Persona spread"
                value={
                  Object.keys(snapshot.quality_metrics.persona_distribution).length > 0
                    ? `${Object.keys(snapshot.quality_metrics.persona_distribution).length} personas`
                    : 'limited persona data'
                }
                muted={Object.keys(snapshot.quality_metrics.persona_distribution).length === 0}
              />
            </div>
            {Object.keys(snapshot.quality_metrics.persona_distribution).length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {Object.entries(snapshot.quality_metrics.persona_distribution).map(
                  ([persona, count]) => (
                    <span
                      key={persona}
                      className="px-3 py-1 bg-stone-100 rounded-full text-xs"
                    >
                      {persona} · {count}
                    </span>
                  ),
                )}
              </div>
            )}
          </div>

          {/* Disagreements */}
          {payload && payload.disagreements.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
              <h3 className="text-xl font-serif text-amber-900 mb-3">
                Disagreement findings ({payload.disagreements.length})
              </h3>
              <p className="text-sm text-amber-900 mb-3">
                We detected divergence between the stated source (CRM / couple form) and
                the forensic source for cases involving this channel.
              </p>
              <ul className="space-y-2 text-sm">
                {payload.disagreements.slice(0, 5).map((d) => (
                  <li key={d.id} className="bg-white rounded p-3 border border-amber-100">
                    <span className="text-stone-500">Stated:</span>{' '}
                    <code className="font-mono">{JSON.stringify(d.stated_value)}</code>{' '}
                    <span className="text-stone-500">· Forensic:</span>{' '}
                    <code className="font-mono">{JSON.stringify(d.forensic_value)}</code>{' '}
                    {d.magnitude_score !== null && (
                      <span className="text-amber-800 font-mono">
                        (magnitude {d.magnitude_score})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Wedding MBA export */}
          <SourcePresentationExport
            venueId={snapshot.venue_id}
            channelSlug={snapshot.channel_slug}
            windowDays={windowDays}
          />

          {/* Reproducibility footer */}
          <div className="bg-stone-50 border border-stone-200 rounded p-4 text-xs text-stone-600">
            <strong className="text-stone-800">Reproducibility:</strong> Snapshot computed
            at <code className="font-mono">{snapshot.computed_at_iso}</code> from
            auto-attributed first-touch rows, weddings, marketing spend, reviews, and
            reconstructed couple intel. Story-arc segmentation reads each channel&apos;s
            role and intent. The presentation export above freezes this snapshot so the
            share-token URL is stable.
          </div>
        </div>
      )}
    </div>
  )
}

function FunnelStep({
  label,
  count,
  accent,
  dropRate,
}: {
  label: string
  count: number
  accent: string
  dropRate?: number | null
}) {
  return (
    <div className="text-center">
      <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">{label}</div>
      <div className="text-4xl font-mono" style={{ color: accent }}>
        {count}
      </div>
      {dropRate !== undefined && dropRate !== null && (
        <div className="text-xs text-red-700 mt-1">
          −{(dropRate * 100).toFixed(0)}% drop
        </div>
      )}
    </div>
  )
}

function QualityCell({
  label,
  value,
  subtext,
  muted,
}: {
  label: string
  value: string
  subtext?: string
  muted?: boolean
}) {
  return (
    <div className={muted ? 'opacity-50' : ''}>
      <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">{label}</div>
      <div className="text-lg font-mono text-stone-900">{value}</div>
      {subtext && <div className="text-xs text-stone-500">{subtext}</div>}
    </div>
  )
}
