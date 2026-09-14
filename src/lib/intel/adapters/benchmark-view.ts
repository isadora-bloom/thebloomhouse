/**
 * Benchmark view model (NOVEMBER-PLAN.md wave 8, W56).
 *
 * The one shape /intel/benchmark and the `get_venue_benchmark` tool both
 * stand behind. Per INTEL-CANONICAL-API.md §1 the page is a dumb renderer
 * and this is the thing between it and the service, so the page prints
 * strings and does no arithmetic of its own.
 *
 * Nothing here recomputes anything. It formats, it picks the sentence
 * worth reading first, and it writes the method note. Every number it
 * receives came from `src/lib/services/cohort/benchmark.ts`, which in turn
 * read it from the reader the single-venue pages use.
 *
 * Server-only by association: `getBenchmarkView` reaches the service, and
 * the service refuses to run in a browser. The guard
 * `scripts/check-no-browser-benchmark-import.mjs` fails the build if a
 * client component imports either module.
 *
 * The pure builder is unit-tested in ./__tests__/benchmark-view.test.ts.
 */

import type {
  BenchmarkComparison,
  BenchmarkMetricValue,
  BenchmarkUnit,
  VenueBenchmark,
} from '@/lib/services/cohort/benchmark'
import { WITHHELD } from './honesty'

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatValue(value: number | null, unit: BenchmarkUnit): string {
  if (value === null) return WITHHELD
  switch (unit) {
    case 'percent':
      return `${Math.round(value * 100)}%`
    case 'hours':
      if (value < 1) return `${Math.round(value * 60)} min`
      if (value < 48) return `${value < 10 ? value.toFixed(1) : Math.round(value)} hrs`
      return `${(value / 24).toFixed(1)} days`
    case 'points': {
      const rounded = Math.round(value * 100) / 100
      if (rounded === 0) return 'flat'
      return `${rounded > 0 ? '+' : ''}${rounded}`
    }
  }
}

/** Ordinal suffix, so a percentile reads as a position rather than a
 *  second percentage sitting next to a percentage. */
export function ordinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

export interface BenchmarkRowView {
  key: string
  label: string
  question: string
  /** The caller's own number, already formatted. */
  yourValue: string
  /** Sample size behind the caller's number. Always rendered next to it. */
  yourN: number
  /** True when the caller's own number is below its sample floor and
   *  should be dimmed. */
  yourDim: boolean
  /** Why the caller's number is withheld or shaky. Null when it is solid. */
  yourNote: string | null
  /** Peer middle, formatted. Withheld marker when suppressed. */
  peerMedian: string
  /** The middle half of the peer set, as one string. */
  peerRange: string
  peerCount: number
  /** '64th' or null. */
  percentileLabel: string | null
  /** One line saying where the caller sits and in which direction better
   *  lies. Always safe to print. */
  standing: string
  /** 'ahead' / 'behind' / 'level' / 'unknown', for colour only. */
  standingTone: 'ahead' | 'behind' | 'level' | 'unknown'
  suppressed: boolean
  method: string
}

export interface BenchmarkView {
  /** False when the peer set is below the threshold. The page then prints
   *  `gateMessage` and nothing else. */
  enoughPeers: boolean
  /** False when the venue has not switched benchmarks on in Settings. The
   *  page then shows where the switch is instead of the peer count. */
  optedIn: boolean
  /** Plain-English reason the page is blank, with the count in it. Null
   *  when there are enough peers. */
  gateMessage: string | null
  /** True when the peers are demo venues. The page shows a visible label. */
  demoPeers: boolean
  demoLabel: string | null
  peerCount: number
  minPeers: number
  /** The line worth reading first. */
  headline: string
  rows: BenchmarkRowView[]
  /** How the whole thing works, in words an owner would use. */
  methodNote: string
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const REASON_COPY: Record<string, string> = {
  no_data: 'Nothing on file for this yet.',
  zero_denominator: 'Nothing to divide by yet, so a rate here would be invented rather than measured.',
  insufficient_sample: 'Too few couples so far for this to be trusted as fact.',
  read_failed:
    'This one could not be read just now. The others on this page are unaffected, and it will fill in on the next load if the problem was temporary.',
}

function yourNote(you: BenchmarkMetricValue): string | null {
  if (you.value !== null && you.enoughData) return null
  if (!you.reason) return 'Nothing on file for this yet.'
  return REASON_COPY[you.reason] ?? you.reason
}

function standingFor(row: BenchmarkComparison): {
  standing: string
  tone: BenchmarkRowView['standingTone']
} {
  if (row.suppressed) {
    return {
      standing: row.suppressedReason ?? 'Not enough venues to compare this yet.',
      tone: 'unknown',
    }
  }
  if (row.you.value === null) {
    return { standing: 'No number of your own to place yet.', tone: 'unknown' }
  }
  if (!row.you.enoughData) {
    return {
      standing: `Your figure is still built on ${row.you.n} couple${row.you.n === 1 ? '' : 's'}, so it is shown but not placed.`,
      tone: 'unknown',
    }
  }
  const p = row.percentile
  if (p === null) return { standing: 'No number of your own to place yet.', tone: 'unknown' }

  const direction = row.higherIsBetter ? 'higher is better' : 'lower is better'
  if (p >= 75) {
    return { standing: `Ahead of ${p}% of the other venues (${direction}).`, tone: 'ahead' }
  }
  if (p <= 25) {
    return { standing: `Behind ${100 - p}% of the other venues (${direction}).`, tone: 'behind' }
  }
  return { standing: `Around the middle of the group (${direction}).`, tone: 'level' }
}

function buildRow(row: BenchmarkComparison): BenchmarkRowView {
  const { standing, tone } = standingFor(row)
  const peerRange =
    row.suppressed || row.peerP25 === null || row.peerP75 === null
      ? WITHHELD
      : `${formatValue(row.peerP25, row.unit)} to ${formatValue(row.peerP75, row.unit)}`

  return {
    key: row.key,
    label: row.label,
    question: row.question,
    yourValue: formatValue(row.you.value, row.unit),
    yourN: row.you.n,
    yourDim: row.you.value === null || !row.you.enoughData,
    yourNote: yourNote(row.you),
    peerMedian: row.suppressed ? WITHHELD : formatValue(row.peerMedian, row.unit),
    peerRange,
    peerCount: row.peerCount,
    percentileLabel:
      row.suppressed || row.percentile === null ? null : ordinal(row.percentile),
    standing,
    standingTone: tone,
    suppressed: row.suppressed,
    method: row.method,
  }
}

/** The blank-page message. It names the count, because "not yet" without
 *  a number is the kind of thing an owner has to come back and ask about. */
function gateMessageFor(result: VenueBenchmark): string {
  if (!result.callerOptedIn) {
    return (
      'Benchmarks are switched off for your venue. Nothing of yours is shared and nothing from other venues is read ' +
      'until you turn them on under Settings, where the switch says exactly what is shared: anonymised middle figures, ' +
      'never a venue name and never the numbers of any one venue.'
    )
  }
  const have = result.peerCount
  const need = result.minPeers
  const noun = have === 1 ? 'venue' : 'venues'
  const stillNeeded = need - have
  return (
    `Benchmarks need more venues. There ${have === 1 ? 'is' : 'are'} ${have} other ${noun} to compare against, ` +
    `and ${need} are needed before a middle figure means anything. ` +
    `${stillNeeded === 1 ? 'One more venue' : `${stillNeeded} more venues`} finishing setup will turn this page on by itself. ` +
    'Nothing is shown until then, because a comparison drawn from one or two venues is a number pretending to be a benchmark.'
  )
}

function headlineFor(rows: BenchmarkRowView[]): string {
  const placed = rows.filter((r) => !r.suppressed && r.percentileLabel !== null)
  if (placed.length === 0) {
    return 'The group is big enough to compare against, but none of your own figures are solid enough to place yet.'
  }
  const ahead = placed.filter((r) => r.standingTone === 'ahead')
  const behind = placed.filter((r) => r.standingTone === 'behind')

  if (behind.length === 0 && ahead.length > 0) {
    return `You are in the top quarter on ${ahead.map((r) => r.label.toLowerCase()).join(', ')}, and nothing here puts you at the back.`
  }
  if (ahead.length === 0 && behind.length > 0) {
    return `Nothing here puts you at the front, and ${behind.map((r) => r.label.toLowerCase()).join(', ')} ${behind.length === 1 ? 'sits' : 'sit'} in the bottom quarter.`
  }
  if (ahead.length > 0 && behind.length > 0) {
    return `Strongest on ${ahead[0]!.label.toLowerCase()}, weakest on ${behind[0]!.label.toLowerCase()}.`
  }
  return 'Every figure you can be placed on sits around the middle of the group.'
}

function methodNoteFor(result: VenueBenchmark, rows: BenchmarkRowView[]): string {
  const peers = `${result.peerCount} other venue${result.peerCount === 1 ? '' : 's'}`
  const who = result.demoPeers
    ? `${peers} in the sample account, which is what a demo compares against`
    : `${peers} that have finished setting up`
  return (
    `Each row is one number of yours, held against ${who}. ` +
    'The middle figure is the median of those venues and the range is the middle half of them, so one unusual venue cannot move it far. ' +
    'Your position is the share of them you are ahead of, counted in the direction that is better for that particular figure. ' +
    'No venue is named anywhere on this page, and no venue’s own numbers are shown: you see how many there were, their middle, and where you sit. ' +
    `A row with fewer than ${result.minPeers} venues able to answer it is left blank rather than guessed at. ` +
    `Your own figures are the same ones the rest of Bloom shows you, read from the same place, so nothing here will disagree with ${rows.length > 0 ? 'the pages they came from' : 'the rest of the product'}.`
  )
}

/** Pure. Hand it a `VenueBenchmark` and it returns everything the page
 *  prints. */
export function buildBenchmarkView(result: VenueBenchmark): BenchmarkView {
  const rows = result.comparisons.map(buildRow)

  return {
    enoughPeers: result.enoughPeers,
    optedIn: result.callerOptedIn,
    gateMessage: result.enoughPeers ? null : gateMessageFor(result),
    demoPeers: result.demoPeers,
    demoLabel: result.demoPeers
      ? 'Demo peers. This sample account is compared against the other sample venues so the page can be seen working.'
      : null,
    peerCount: result.peerCount,
    minPeers: result.minPeers,
    headline: result.enoughPeers ? headlineFor(rows) : gateMessageFor(result),
    // Below the gate the page shows nothing but the gate message, so the
    // rows are still built (the tool source reads their `suppressed`
    // flags) but the page never reaches them.
    rows: result.enoughPeers ? rows : [],
    methodNote: methodNoteFor(result, rows),
    generatedAt: result.generatedAt,
  }
}

/** What the page calls: read, then shape. One import, one call. */
export async function getBenchmarkView(venueId: string): Promise<BenchmarkView> {
  const { getVenueBenchmark } = await import('@/lib/services/cohort/benchmark')
  return buildBenchmarkView(await getVenueBenchmark(venueId))
}
