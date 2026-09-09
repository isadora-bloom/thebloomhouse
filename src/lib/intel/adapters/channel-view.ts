/**
 * Channel-truth view model — the ONE shape both /intel/sources and
 * /intel/attribution render for "which channel is working".
 *
 * Why an adapter and not page code: before this, /intel/sources built
 * its channel table from /api/intel/sources/funnel (wedding_touchpoints
 * + weddings) while /intel/attribution built its own from the couple
 * spine. Same question, two derivations, two answers. Both pages now
 * render `ChannelTruthView`, which is derived only from the canonical
 * `getSourceAttribution` return. If the two pages ever disagree again it
 * is because they were handed different `SourceAttribution` objects, not
 * because they did different maths.
 *
 * INTEL-CANONICAL-API.md §1: surfaces are dumb renderers. Nothing here
 * touches a database; nothing here recomputes a rate. It re-labels,
 * orders, and attaches the honesty rail.
 *
 * Pure. Unit-tested in ./__tests__/channel-view.test.ts.
 */

import type {
  AttributionModel,
  ChannelStat,
  SourceAttribution,
} from '@/lib/intel/canonical'
import { formatSourceLabel } from '@/lib/utils/format-source-label'
import {
  renderDistribution,
  sufficiencySummary,
  type RenderedDistribution,
} from './honesty'

/** The synthetic channel `buildCoupleAttribution` uses for couples with
 *  no acquisition touchpoint at all. It is real information (it says the
 *  Tracer has not re-bound those couples yet), so it is kept in the
 *  table rather than dropped, but it is never eligible to be a leader. */
export const UNKNOWN_ACQUISITION_CHANNEL = '(unknown_acquisition)'

export interface ChannelTruthRow {
  /** Raw spine channel key. Stable, snake_case, never displayed bare. */
  channel: string
  /** Coordinator-facing label. */
  label: string
  /** Distinct couples credited to this channel under the chosen model. */
  n: number
  conversion: RenderedDistribution
  cac: RenderedDistribution
  revenuePerDollar: RenderedDistribution
  /** Highest volume under the chosen model. */
  isVolumeLeader: boolean
  /** Highest conversion among channels that cleared their floor. */
  isConversionLeader: boolean
  /** True for the synthetic no-acquisition-touch bucket. */
  isUnattributed: boolean
}

export interface ChannelTruthView {
  model: AttributionModel
  rows: ChannelTruthRow[]
  /** Channel keys, straight from the reader — not recomputed here. */
  topByVolume: string | null
  topByConversion: string | null
  /** True when volume and conversion point at different channels. The
   *  doctrine line (battery Q26) the surface has to make visible. */
  volumeDivergesFromConversion: boolean
  /** Sum of per-channel n. Not a couple count — a couple with two
   *  credited channels under a linear model appears in both. */
  totalCredits: number
  /** How many channel conversions cleared their reporting floor. */
  sufficiency: ReturnType<typeof sufficiencySummary>
  generatedAt: string
}

export const MODEL_LABEL: Record<AttributionModel, string> = {
  first_touch: 'First touch',
  last_touch: 'Last touch',
  linear: 'Linear',
  time_decay: 'Time decay',
}

/** Model explainers, so both surfaces say the same sentence about the
 *  same model. Wording mirrors the builder's own explainers. */
export const MODEL_EXPLAINER: Record<AttributionModel, string> = {
  first_touch:
    'All credit to the earliest credible acquisition touchpoint. This is the default because it answers "where did they find us", which is the question a marketing budget is spent against.',
  last_touch:
    'All credit to the most recent acquisition touchpoint before booking. Flatters whatever channel closes rather than whatever channel finds.',
  linear:
    'Credit split evenly across every acquisition touchpoint on the journey. Fractions are expected.',
  time_decay:
    'Credit weighted towards the touchpoints nearest the booking, on a 14-day half-life.',
}

function sortRows(a: ChannelTruthRow, b: ChannelTruthRow): number {
  // Unattributed last — it is a data-quality signal, not a channel.
  if (a.isUnattributed !== b.isUnattributed) return a.isUnattributed ? 1 : -1
  if (b.n !== a.n) return b.n - a.n
  return a.label.localeCompare(b.label)
}

/**
 * Build the shared channel-truth view from a canonical SourceAttribution.
 *
 * `showWithheldValues` is passed through to the honesty rail: false (the
 * default) withholds any figure the reader flagged as below its floor;
 * true prints it dimmed with the reason attached. /intel/attribution
 * opts in because its audience is auditing the model; /intel/sources
 * leaves it off because its audience is deciding where to spend.
 */
export function buildChannelTruthView(
  attribution: SourceAttribution,
  opts: { showWithheldValues?: boolean } = {},
): ChannelTruthView {
  const show = opts.showWithheldValues ?? false

  const rows: ChannelTruthRow[] = attribution.channels.map((c: ChannelStat) => {
    const isUnattributed = c.channel === UNKNOWN_ACQUISITION_CHANNEL
    return {
      channel: c.channel,
      label: isUnattributed ? 'No acquisition touch' : formatSourceLabel(c.channel),
      n: c.n,
      conversion: renderDistribution(c.conversion, 'percent', { showWithheldValue: show }),
      cac: renderDistribution(c.cac, 'money', { showWithheldValue: show }),
      revenuePerDollar: renderDistribution(c.revenuePerDollar, 'ratio', {
        showWithheldValue: show,
      }),
      isVolumeLeader: !isUnattributed && attribution.topByVolume === c.channel,
      isConversionLeader:
        !isUnattributed && attribution.topByConversion === c.channel,
      isUnattributed,
    }
  })

  rows.sort(sortRows)

  return {
    model: attribution.model,
    rows,
    topByVolume: attribution.topByVolume,
    topByConversion: attribution.topByConversion,
    volumeDivergesFromConversion:
      attribution.topByVolume !== null &&
      attribution.topByConversion !== null &&
      attribution.topByVolume !== attribution.topByConversion,
    totalCredits: attribution.channels.reduce((sum, c) => sum + c.n, 0),
    sufficiency: sufficiencySummary(attribution.channels.map((c) => c.conversion)),
    generatedAt: attribution.generatedAt,
  }
}

/**
 * One sentence the surface prints above the table. Says what the numbers
 * mean and, when they diverge, that volume is not conversion — the point
 * the doctrine says a source surface must not let an operator miss.
 */
export function channelTruthHeadline(view: ChannelTruthView): string {
  if (view.rows.length === 0) {
    return 'No channels credited yet. Once the spine has acquisition touchpoints, they appear here.'
  }
  const volume = view.rows.find((r) => r.isVolumeLeader)
  const conversion = view.rows.find((r) => r.isConversionLeader)
  if (!volume && !conversion) {
    return 'Channels are credited, but none has cleared its reporting floor yet, so no leader is claimed.'
  }
  if (volume && conversion && view.volumeDivergesFromConversion) {
    return `Most couples come from ${volume.label}, but ${conversion.label} converts best. Volume is not conversion.`
  }
  if (volume && conversion) {
    return `${volume.label} leads on both volume and conversion under ${MODEL_LABEL[view.model].toLowerCase()}.`
  }
  if (volume) {
    return `${volume.label} brings the most couples. No channel has enough booked couples yet to name a conversion leader.`
  }
  return `${conversion!.label} converts best among channels that have cleared their reporting floor.`
}
