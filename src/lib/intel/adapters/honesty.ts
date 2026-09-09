/**
 * Honesty rail — how a canonical `Distribution` becomes something a
 * surface may render.
 *
 * INTEL-CANONICAL-API.md §3 says every metric carries its own `n` and
 * `enoughData`, and every ratio is `null` (never a fake 0) on a zero
 * denominator. That contract is only worth having if the render side
 * honours it, so this module is the single place a Distribution turns
 * into text. Surfaces call `renderDistribution` and render what comes
 * back. They never reach into `.value` themselves.
 *
 * The rule the helpers enforce:
 *   - `enoughData: false` NEVER renders a bare number. It renders the
 *     reason plus the sample size, so the operator can see why the
 *     number is being withheld and what would unlock it.
 *   - `value: null` renders an em-free dash, never 0.
 *   - Every rendered value carries its n.
 *
 * Pure. No React, no client. Unit-tested in ./__tests__/honesty.test.ts.
 */

import type { Distribution } from '@/lib/intel/canonical'

/** How a Distribution should be drawn. */
export interface RenderedDistribution {
  /** The headline string a surface may print. Never a bare number when
   *  `enoughData` is false — it is a withheld-value marker instead. */
  text: string
  /** Sample size, always present, always rendered next to `text`. */
  n: number
  /** Passthrough of the reader's sufficiency flag. */
  enoughData: boolean
  /** Operator-readable explanation. Null only when enoughData is true. */
  reason: string | null
  /** True when the surface should dim / de-emphasise the cell. */
  dim: boolean
  /** Tooltip text a surface can hang off the cell. */
  title: string
}

/** Withheld-value marker. A single character so table columns stay tidy.
 *  Deliberately not '0' and not an empty cell: both read as data. */
export const WITHHELD = '–'

export type DistributionFormat = 'percent' | 'money' | 'ratio' | 'number'

const SAMPLE_FLOOR_COPY =
  'Below the reporting floor for this metric. The reader returns the value but flags it as not yet trustworthy.'

const REASON_COPY: Record<NonNullable<Distribution['reason']>, string> = {
  insufficient_sample: SAMPLE_FLOOR_COPY,
  no_data: 'No data for this cell yet.',
  zero_denominator:
    'Nothing to divide by. The denominator is zero, so a rate here would be invented, not measured.',
}

function formatValue(value: number, format: DistributionFormat): string {
  switch (format) {
    case 'percent':
      return `${Math.round(value * 100)}%`
    case 'money':
      return `$${Math.round(value).toLocaleString()}`
    case 'ratio':
      return `${value.toFixed(2)}x`
    case 'number':
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  }
}

/**
 * Turn a Distribution into the four things a surface needs: what to
 * print, the sample size, whether to dim it, and why.
 *
 * `showWithheldValue` lets a surface print the under-floor number in a
 * dimmed, explicitly-flagged cell (the /intel/attribution pattern) when
 * the operator has asked to see working numbers. It defaults to false:
 * the safe rendering withholds.
 */
export function renderDistribution(
  d: Distribution,
  format: DistributionFormat = 'number',
  opts: { showWithheldValue?: boolean } = {},
): RenderedDistribution {
  const reason = d.reason ? REASON_COPY[d.reason] : null

  if (d.value === null) {
    return {
      text: WITHHELD,
      n: d.n,
      enoughData: false,
      reason: reason ?? REASON_COPY.no_data,
      dim: true,
      title: `${reason ?? REASON_COPY.no_data} (n=${d.n})`,
    }
  }

  if (!d.enoughData) {
    const text = opts.showWithheldValue ? formatValue(d.value, format) : WITHHELD
    return {
      text,
      n: d.n,
      enoughData: false,
      reason: reason ?? SAMPLE_FLOOR_COPY,
      dim: true,
      title: `${reason ?? SAMPLE_FLOOR_COPY} (n=${d.n})`,
    }
  }

  return {
    text: formatValue(d.value, format),
    n: d.n,
    enoughData: true,
    reason: null,
    dim: false,
    title: `Measured across ${d.n} couple${d.n === 1 ? '' : 's'}.`,
  }
}

/** Honest-empty Distribution. Used when a surface has to stand in for a
 *  reader cell that was never returned (e.g. a channel present in spend
 *  but absent from the attribution rollup). */
export function emptyDistribution(): Distribution {
  return { value: null, n: 0, enoughData: false, reason: 'no_data' }
}

/**
 * Count how many of a set of Distributions cleared their floor. Surfaces
 * use this to decide whether a whole panel is honest enough to headline,
 * or whether it should lead with a DataMaturity block instead.
 */
export function sufficiencySummary(dists: readonly Distribution[]): {
  total: number
  enough: number
  /** True when at least one cell cleared its floor. */
  anyEnough: boolean
  /** Largest n seen. Feeds the DataMaturity progress bar. */
  maxN: number
} {
  let enough = 0
  let maxN = 0
  for (const d of dists) {
    if (d.enoughData) enough++
    if (d.n > maxN) maxN = d.n
  }
  return { total: dists.length, enough, anyEnough: enough > 0, maxN }
}
