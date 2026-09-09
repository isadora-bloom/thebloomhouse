'use client'

/**
 * Channel truth — the shared channel table.
 *
 * ONE component, rendered by /intel/sources and /intel/attribution, fed
 * by ONE endpoint (/api/intel/canonical/source-attribution), which calls
 * ONE reader (getSourceAttribution). Before this, the two pages derived
 * conversion from different tables and disagreed on screen.
 *
 * Everything printed here comes from `buildChannelTruthView`. The
 * component does no arithmetic of its own — not a percentage, not a
 * total. If a number needs to change, it changes in the reader.
 *
 * Honesty rail: every cell prints through renderDistribution, so a
 * figure below its reporting floor renders as a withheld marker with the
 * reason attached rather than as a confident-looking number, and every
 * row carries its n.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Loader2, Share2 } from 'lucide-react'
import { DataMaturity } from '@/components/ui/data-maturity'
import { EmptyState } from '@/components/ui/empty-state'
import { WhyThisCard } from '@/components/ui/why-this-card'
import type { AttributionModel, SourceAttribution } from '@/lib/intel/canonical'
import {
  buildChannelTruthView,
  channelTruthHeadline,
  MODEL_EXPLAINER,
  MODEL_LABEL,
  type ChannelTruthRow,
} from '@/lib/intel/adapters/channel-view'
import { WITHHELD } from '@/lib/intel/adapters/honesty'

/** Models the operator can pick between on a coordinator surface. The
 *  reader supports a fourth (time_decay); it is kept off the toggle
 *  because /intel/attribution already exposes it in its audit view and a
 *  four-way toggle on a spend page invites model-shopping. */
export const OPERATOR_MODELS: AttributionModel[] = ['first_touch', 'last_touch', 'linear']

interface AttributionPart {
  venueId: string
  venueName: string | null
  attribution: SourceAttribution
}

interface ApiResponse {
  ok: boolean
  model?: AttributionModel
  parts?: AttributionPart[]
  truncated?: boolean
  error?: string
}

/**
 * Fetch the canonical attribution for the current scope. Shared by both
 * pages so neither can quietly point at a different endpoint.
 */
export function useCanonicalAttribution(model: AttributionModel, sinceDays?: number) {
  const [parts, setParts] = useState<AttributionPart[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ model })
      if (sinceDays && sinceDays > 0) params.set('sinceDays', String(sinceDays))
      const res = await fetch(`/api/intel/canonical/source-attribution?${params}`, {
        cache: 'no-store',
      })
      const body = (await res.json()) as ApiResponse
      if (!body.ok) {
        setError(body.error ?? `Channel truth failed (HTTP ${res.status})`)
        setParts([])
      } else {
        setParts(body.parts ?? [])
        setTruncated(Boolean(body.truncated))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setParts([])
    } finally {
      setLoading(false)
    }
  }, [model, sinceDays])

  useEffect(() => {
    void load()
  }, [load])

  return { parts, truncated, loading, error, reload: load }
}

// ---------------------------------------------------------------------------
// Model toggle
// ---------------------------------------------------------------------------

export function ModelToggle({
  model,
  onChange,
  models = OPERATOR_MODELS,
}: {
  model: AttributionModel
  onChange: (m: AttributionModel) => void
  models?: AttributionModel[]
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-warm-white p-1 w-fit">
      {models.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
            model === m ? 'bg-sage-600 text-white' : 'text-sage-700 hover:bg-sage-100'
          }`}
        >
          {MODEL_LABEL[m]}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

function Cell({
  rendered,
}: {
  rendered: ChannelTruthRow['conversion']
}) {
  return (
    <td
      className={`py-2 text-right tabular-nums ${rendered.dim ? 'text-sage-400' : 'text-sage-900'}`}
      title={rendered.title}
    >
      {rendered.text}
      {rendered.text === WITHHELD ? (
        <span className="ml-1 text-[10px] uppercase tracking-wide text-sage-400">
          n={rendered.n}
        </span>
      ) : null}
    </td>
  )
}

/**
 * The channel table for ONE venue's attribution.
 *
 * `showWithheldValues` prints below-floor numbers dimmed with their
 * reason (the auditing view on /intel/attribution) instead of withholding
 * them outright (the spending view on /intel/sources).
 */
export function ChannelTruthTable({
  attribution,
  venueName,
  showWithheldValues = false,
}: {
  attribution: SourceAttribution
  venueName?: string | null
  showWithheldValues?: boolean
}) {
  const view = useMemo(
    () => buildChannelTruthView(attribution, { showWithheldValues }),
    [attribution, showWithheldValues],
  )

  if (view.rows.length === 0) {
    return (
      <EmptyState
        icon={Share2}
        title="No channels credited yet"
        subtitle="Channel truth is derived from acquisition touchpoints on the spine. Once couples arrive with a first touch, every channel appears here with its own sample size."
        variant="dashed"
      />
    )
  }

  return (
    <div className="space-y-3">
      {venueName ? (
        <p className="text-xs uppercase tracking-wide text-sage-500">{venueName}</p>
      ) : null}

      <p className="text-sm text-sage-800">{channelTruthHeadline(view)}</p>

      {!view.sufficiency.anyEnough ? (
        <DataMaturity
          current={view.sufficiency.maxN}
          threshold={8}
          unit="couples on the busiest channel"
          unlocks="conversion, cost per booking and revenue per pound"
        />
      ) : null}

      <div className="-mx-6 overflow-x-auto px-6">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-sage-500">
            <tr>
              <th className="py-2">Channel</th>
              <th className="py-2 text-right">Couples</th>
              <th className="py-2 text-right">Conversion</th>
              <th className="py-2 text-right">Cost per booking</th>
              <th className="py-2 text-right">Revenue per $</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.channel} className="border-t border-border first:border-t-0">
                <td className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`font-medium ${
                        row.isUnattributed ? 'text-amber-800' : 'text-sage-900'
                      }`}
                    >
                      {row.label}
                    </span>
                    {row.isVolumeLeader ? (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800">
                        top volume
                      </span>
                    ) : null}
                    {row.isConversionLeader ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-800">
                        top conversion
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="py-2 text-right tabular-nums text-sage-900">{row.n}</td>
                <Cell rendered={row.conversion} />
                <Cell rendered={row.cac} />
                <Cell rendered={row.revenuePerDollar} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <WhyThisCard
        title="Where these numbers come from"
        reasoning={`${MODEL_EXPLAINER[view.model]} Every figure on this table is returned by getSourceAttribution, the single canonical reader. /intel/sources and /intel/attribution render this same component from this same call, so they cannot show you two different conversion rates for one channel.`}
        evidence={[
          `Model: ${MODEL_LABEL[view.model]}.`,
          `${view.sufficiency.enough} of ${view.sufficiency.total} channels have cleared the eight-couple reporting floor.`,
          `A cell showing "${WITHHELD}" is withheld, not zero. Hover it for the reason.`,
          `Credits total ${view.totalCredits}. Under linear and time decay one couple can be credited to several channels, so this is larger than the couple count.`,
          `Generated ${new Date(view.generatedAt).toLocaleString()}.`,
        ]}
        source="getSourceAttribution (src/lib/intel/canonical.ts)"
      />
    </div>
  )
}

/**
 * The whole section: loading, error, per-venue tables. Both pages drop
 * this in and pass their own model state.
 */
export function ChannelTruthSection({
  model,
  sinceDays,
  showWithheldValues = false,
}: {
  model: AttributionModel
  sinceDays?: number
  showWithheldValues?: boolean
}) {
  const { parts, truncated, loading, error } = useCanonicalAttribution(model, sinceDays)

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 px-2 py-8 text-sage-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading channel truth from the spine…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium">Could not load channel truth</div>
          <div className="mt-0.5 text-rose-700">{error}</div>
        </div>
      </div>
    )
  }

  if (parts.length === 0) {
    return (
      <EmptyState
        icon={Share2}
        title="No venue in scope"
        subtitle="Pick a venue from the scope switcher to see which channels are working."
        variant="dashed"
      />
    )
  }

  return (
    <div className="space-y-8">
      {parts.map((p) => (
        <ChannelTruthTable
          key={p.venueId}
          attribution={p.attribution}
          venueName={parts.length > 1 ? p.venueName : null}
          showWithheldValues={showWithheldValues}
        />
      ))}
      {truncated ? (
        <p className="text-xs text-sage-500">
          Showing the first {parts.length} venues in this scope. Channel truth is read
          one venue at a time because conversion rates cannot be honestly added
          together.
        </p>
      ) : null}
      {parts.length > 1 ? (
        <p className="text-xs text-sage-500">
          One table per venue. Rates are not merged across venues: conversion is
          bookings over couples, and adding two rates would produce a number nobody
          measured.
        </p>
      ) : null}
    </div>
  )
}
