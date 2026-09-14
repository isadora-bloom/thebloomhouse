/**
 * Cross-venue benchmarks (NOVEMBER-PLAN.md wave 8, W56).
 *
 * The question: "how do we compare?" Bloom has always been able to tell a
 * venue its own numbers. It has never been able to tell it whether those
 * numbers are good, because there was nothing to hold them against. This
 * module is that comparison, built now against the single-venue model so
 * that nothing further has to be written the day a second real venue
 * signs. The page turns itself on when the peer set is big enough, and
 * stays honestly blank until then.
 *
 * SERVER ONLY
 * -----------
 * The peer query reads rows belonging to venues the caller has no right
 * to see, so it runs as service role and must never be reachable from a
 * browser bundle. Two things hold that line:
 *   1. `assertServerOnly()` throws the moment `window` exists, so a
 *      bundling mistake fails loudly instead of leaking quietly.
 *   2. `scripts/check-no-browser-benchmark-import.mjs` fails the build if
 *      any 'use client' file imports this module or its adapter. It is
 *      wired into `npm run check:governance`, same family as
 *      check-no-browser-weddings-fetch.mjs.
 * The page that renders this is a server component and reaches it through
 * `src/lib/intel/adapters/benchmark-view.ts`.
 *
 * ANONYMOUS BY CONSTRUCTION
 * -------------------------
 * Anonymity here is not a filter applied at the end, which is the kind of
 * thing a later refactor quietly drops. It is the shape of the code:
 * `summarisePeerMetric` takes an array of plain numbers. It has no venue
 * object to leak, no id to forget to strip, no name it could accidentally
 * print. Venue ids exist only inside `buildVenueBenchmark`, are turned
 * into numbers immediately, and never enter the returned object. What the
 * caller receives per metric is a peer count, a median, two quartiles and
 * their own percentile.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * Every figure is read from the reader the single-venue pages already
 * use, never derived a second time here:
 *   - the two funnel rates are `computeFunnel`'s own `overall` stages, the
 *     same rows /intel/cohort draws;
 *   - median response time is `mapCohortIntelToFunnel(...).responseTime`,
 *     the literal canonical mapping, so it matches `getCohortFunnel`;
 *   - the weekday tour rate sums `funnel.byTourWeekday`, the table the
 *     funnel built, across Monday to Friday. Summing counts the funnel
 *     already produced is aggregation, not a second definition of a tour;
 *   - the review trend is `computeReviewsAnalytics`'s `sentiment_trend`;
 *   - channel mix is `mapAttributionToCanonical`, the same mapping behind
 *     `getSourceAttribution` and /intel/sources.
 *
 * DOCTRINE
 * --------
 * doctrine-compliance.yaml PART 24 (cross-venue network) sets three rules
 * this module answers to, and one it does not yet:
 *   - INV-24.4-A minimum cohort size. Honoured, at `BENCHMARK_MIN_PEERS`.
 *     The plan's trigger is three peers, which is what ships; the
 *     doctrine's eventual floor is ten. One constant, one line to raise.
 *   - INV-24.4-B suppression below the minimum. Honoured per metric: a
 *     metric fewer than `BENCHMARK_MIN_PEERS` peers could answer is
 *     suppressed on its own, even when the peer set as a whole clears.
 *   - INV-24.4-C no outlier exposure. Honoured: no best or weakest venue
 *     is named, because no venue is named at all.
 *   - INV-24.1-A opt-in, default off. NOT built. It needs a venue_config
 *     column and this wave writes no migrations. Until it exists, the
 *     onboarding gate below is the only participation condition.
 *
 * COST
 * ----
 * One cohort build, one attribution build and one reviews read per venue
 * in the set. Attribution loads the spine a second time (that is
 * `buildCoupleAttribution`'s own shape, not something added here), so a
 * set of n venues costs roughly 2n spine loads. At a handful of venues
 * that is nothing. If the peer set ever reaches dozens, the fix is a
 * shared loader, not a cache.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Distribution as CanonicalDistribution } from '@/lib/intel/canonical'
import { MIN_DISTRIBUTION_N } from './types'
import { percentile } from './helpers'

// ---------------------------------------------------------------------------
// Server-only assertion
// ---------------------------------------------------------------------------

/** Throws if this module is running in a browser. The peer query reads
 *  other venues' rows as service role; there is no version of that which
 *  is safe on the client, so the failure is loud and immediate rather
 *  than a silent empty result. */
export function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'cohort/benchmark is server-only: the peer query reads other venues as service role. ' +
        'Call it from a server component or a route handler, never from the browser.',
    )
  }
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Peers needed before any comparison is shown. Below this the page says
 *  so plainly and shows nothing else. This is the plan's trigger
 *  condition expressed in code rather than a feature flag, so the day a
 *  third real venue finishes onboarding the page turns itself on. */
export const BENCHMARK_MIN_PEERS = 3

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type BenchmarkMetricKey =
  | 'inquiry_to_tour'
  | 'tour_to_booked'
  | 'response_hours'
  | 'weekday_tour_conversion'
  | 'review_trend'
  | 'channel_concentration'

export type BenchmarkUnit = 'percent' | 'hours' | 'points'

export interface BenchmarkMetricDef {
  key: BenchmarkMetricKey
  /** Short column label. */
  label: string
  /** The plain question this one number answers. */
  question: string
  unit: BenchmarkUnit
  /** True when a bigger number is the better one. Drives the percentile:
   *  a percentile always means "share of peers you are ahead of". */
  higherIsBetter: boolean
  /** How the number is built, in plain English, for the method note. */
  method: string
}

export const BENCHMARK_METRICS: readonly BenchmarkMetricDef[] = [
  {
    key: 'inquiry_to_tour',
    label: 'Enquiry to tour',
    question: 'Of the couples who enquire, how many come and look round?',
    unit: 'percent',
    higherIsBetter: true,
    method:
      'Couples who reached the toured stage, divided by couples who enquired. Read straight off the funnel /intel/cohort draws.',
  },
  {
    key: 'tour_to_booked',
    label: 'Tour to booking',
    question: 'Of the couples who tour, how many sign?',
    unit: 'percent',
    higherIsBetter: true,
    method:
      'Couples who booked, divided by couples who toured. The same funnel step /intel/cohort shows, not a second count.',
  },
  {
    key: 'response_hours',
    label: 'Reply time',
    question: 'How long do we take to answer a first enquiry?',
    unit: 'hours',
    higherIsBetter: false,
    method:
      'Median hours from a couple’s first message the venue can reply to, to the first reply. The canonical response-time figure, so it matches /intel/cohort and Ask your data.',
  },
  {
    key: 'weekday_tour_conversion',
    label: 'Weekday tours',
    question: 'Do our Monday-to-Friday tours turn into bookings?',
    unit: 'percent',
    higherIsBetter: true,
    method:
      'Bookings divided by tours, counting only tours held Monday to Friday. Summed from the weekday table the funnel already built.',
  },
  {
    key: 'review_trend',
    label: 'Review trend',
    question: 'Are the reviews getting better or worse?',
    unit: 'points',
    higherIsBetter: true,
    method:
      'Recent average review sentiment minus the earlier average, on the scale the reviews page uses. Above zero is improving.',
  },
  {
    key: 'channel_concentration',
    label: 'Biggest channel',
    question: 'How much of our enquiry volume leans on one channel?',
    unit: 'percent',
    higherIsBetter: false,
    method:
      'The largest channel’s share of attributed couples. Lower is a wider spread, which is the safer place to be. From the same attribution mapping /intel/sources uses.',
  },
]

const METRIC_BY_KEY = new Map<BenchmarkMetricKey, BenchmarkMetricDef>(
  BENCHMARK_METRICS.map((m) => [m.key, m]),
)

// ---------------------------------------------------------------------------
// Per-venue values
// ---------------------------------------------------------------------------

/** One venue's answer to one metric. `value` is null when the venue has
 *  nothing to answer with; it is never a stand-in zero. `enoughData` is
 *  false below the spine's own sample floor. */
export interface BenchmarkMetricValue {
  value: number | null
  n: number
  enoughData: boolean
  reason?: string
}

export interface VenueBenchmarkValues {
  venueId: string
  values: Record<BenchmarkMetricKey, BenchmarkMetricValue>
}

function empty(reason: string): BenchmarkMetricValue {
  return { value: null, n: 0, enoughData: false, reason }
}

/** A reader threw. The operator sees "could not be read", not the
 *  database's own words: a raw error string on a coordinator surface is
 *  how engineering vocabulary leaks into the product. The detail goes to
 *  the log, which is where somebody is looking for it. */
function readFailed(surface: string, err: unknown): BenchmarkMetricValue {
  console.warn(
    `[benchmark] ${surface} read failed:`,
    err instanceof Error ? err.message : String(err),
  )
  return { value: null, n: 0, enoughData: false, reason: 'read_failed' }
}

function rate(value: number | null, n: number): BenchmarkMetricValue {
  if (value === null) {
    return { value: null, n, enoughData: false, reason: n > 0 ? 'zero_denominator' : 'no_data' }
  }
  if (n < MIN_DISTRIBUTION_N) {
    return { value, n, enoughData: false, reason: 'insufficient_sample' }
  }
  return { value, n, enoughData: true }
}

function fromCanonical(d: CanonicalDistribution): BenchmarkMetricValue {
  return { value: d.value, n: d.n, enoughData: d.enoughData, reason: d.reason }
}

function emptyValues(reason: string): Record<BenchmarkMetricKey, BenchmarkMetricValue> {
  const out = {} as Record<BenchmarkMetricKey, BenchmarkMetricValue>
  for (const m of BENCHMARK_METRICS) out[m.key] = empty(reason)
  return out
}

/**
 * Every benchmark number for one venue, each read from the reader that
 * already owns it. The client is injected so a test can drive this with
 * a fake and no database.
 *
 * A reader that throws costs its own metrics and nothing else. A venue
 * with no reviews configured should still contribute its funnel.
 */
export async function computeVenueBenchmarkValues(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueBenchmarkValues> {
  assertServerOnly()
  if (!venueId) return { venueId, values: emptyValues('no_data') }

  const [{ mapCohortIntelToFunnel, mapAttributionToCanonical }, { buildCohortIntel }, { buildCoupleAttribution }, { computeReviewsAnalytics }] =
    await Promise.all([
      import('@/lib/intel/canonical'),
      import('@/lib/services/cohort'),
      import('@/lib/services/attribution/couple-attribution'),
      import('@/lib/services/intel/reviews-analytics'),
    ])

  const values = emptyValues('no_data')

  // --- funnel, response time, weekday tours: one cohort build ------------
  try {
    const intel = await buildCohortIntel(supabase, venueId)

    const toured = intel.funnel.overall.find((s) => s.key === 'toured')
    const booked = intel.funnel.overall.find((s) => s.key === 'booked')
    const inquiry = intel.funnel.overall.find((s) => s.key === 'inquiry')

    if (toured && inquiry) {
      values.inquiry_to_tour = rate(toured.fromInquiry, inquiry.count)
    }
    if (booked && toured) {
      values.tour_to_booked = rate(booked.fromPrevious, toured.count)
    }

    // The canonical mapping, so this is the same median /intel/cohort and
    // Ask your data report, not a parallel one computed here.
    values.response_hours = fromCanonical(mapCohortIntelToFunnel(intel).responseTime)

    // Monday (1) to Friday (5) of the funnel's own weekday table. On that
    // table `inquiries` has already been overwritten with `toured` by the
    // funnel itself, so `toured` is the denominator either way.
    let weekdayToured = 0
    let weekdayBooked = 0
    intel.funnel.byTourWeekday.forEach((seg, weekday) => {
      if (weekday < 1 || weekday > 5) return
      weekdayToured += seg.toured
      weekdayBooked += seg.booked
    })
    values.weekday_tour_conversion = rate(
      weekdayToured > 0 ? weekdayBooked / weekdayToured : null,
      weekdayToured,
    )
  } catch (err) {
    values.inquiry_to_tour = readFailed('funnel', err)
    values.tour_to_booked = readFailed('funnel', err)
    values.response_hours = readFailed('response time', err)
    values.weekday_tour_conversion = readFailed('weekday tours', err)
  }

  // --- review trend -------------------------------------------------------
  try {
    const reviews = await computeReviewsAnalytics(venueId, supabase)
    const { recent_avg, prior_avg } = reviews.sentiment_trend
    if (recent_avg === null || prior_avg === null) {
      values.review_trend = { value: null, n: reviews.total, enoughData: false, reason: 'no_data' }
    } else {
      values.review_trend = rate(recent_avg - prior_avg, reviews.total)
    }
  } catch (err) {
    values.review_trend = readFailed('reviews', err)
  }

  // --- channel concentration ---------------------------------------------
  try {
    const attribution = mapAttributionToCanonical(
      await buildCoupleAttribution(supabase, venueId),
      'first_touch',
    )
    let total = 0
    let biggest = 0
    for (const channel of attribution.channels) {
      total += channel.n
      if (channel.n > biggest) biggest = channel.n
    }
    values.channel_concentration = rate(total > 0 ? biggest / total : null, total)
  } catch (err) {
    values.channel_concentration = readFailed('channel mix', err)
  }

  return { venueId, values }
}

// ---------------------------------------------------------------------------
// Peer set
// ---------------------------------------------------------------------------

export type BenchmarkMode = 'real' | 'demo'

export interface BenchmarkPeerSet {
  /** 'demo' when the caller is itself a demo venue, in which case it is
   *  compared against the other demo venues so the demo shows the page
   *  working. 'real' for everybody else. */
  mode: BenchmarkMode
  callerIsDemo: boolean
  /** Peer venue ids. Internal to this module: they are turned into plain
   *  numbers before anything is returned to a surface. The caller's own
   *  id is never in here. */
  peerVenueIds: string[]
  /** Venues that qualify for this mode, the caller included. What the
   *  "we need more venues" message counts. */
  qualifyingVenueCount: number
}

interface VenueRow {
  id: string
  is_demo: boolean | null
}

interface VenueConfigRow {
  venue_id: string
  onboarding_completed: boolean | null
}

/**
 * Who the caller is compared against.
 *
 * Real mode: every venue that is not a demo and has finished onboarding,
 * minus the caller. Onboarding is the gate on purpose. It is the plan's
 * own week-4 condition, and a half-onboarded venue's funnel would be a
 * measurement of its import progress, not of how it sells.
 *
 * Demo mode: the caller is a demo venue, so it is compared against the
 * other demo venues. The demo then shows a working page instead of an
 * empty one, and the surface labels those peers as demo so nobody reads
 * them as the real market.
 *
 * The caller is excluded by id in both branches, before anything else
 * happens to the list. A venue is never its own peer, which would flatter
 * every percentile it produced.
 */
export async function benchmarkPeerSet(
  venueId: string,
  supabase?: SupabaseClient,
): Promise<BenchmarkPeerSet> {
  assertServerOnly()
  const db = supabase ?? (await import('@/lib/supabase/service')).createServiceClient()

  const [venuesRes, configRes] = await Promise.all([
    db.from('venues').select('id, is_demo'),
    db.from('venue_config').select('venue_id, onboarding_completed'),
  ])
  if (venuesRes.error) throw new Error(`[benchmark] venues read failed: ${venuesRes.error.message}`)
  if (configRes.error) {
    throw new Error(`[benchmark] venue_config read failed: ${configRes.error.message}`)
  }

  const venues = (venuesRes.data ?? []) as VenueRow[]
  const configs = (configRes.data ?? []) as VenueConfigRow[]
  const onboarded = new Set(
    configs.filter((c) => c.onboarding_completed === true).map((c) => c.venue_id),
  )

  const caller = venues.find((v) => v.id === venueId)
  const callerIsDemo = caller?.is_demo === true

  const qualifies = (v: VenueRow): boolean =>
    callerIsDemo ? v.is_demo === true : v.is_demo !== true && onboarded.has(v.id)

  const qualifying = venues.filter(qualifies)
  // Exclude the caller first, by id, before the list is used for anything.
  const peerVenueIds = qualifying.filter((v) => v.id !== venueId).map((v) => v.id)

  return {
    mode: callerIsDemo ? 'demo' : 'real',
    callerIsDemo,
    peerVenueIds,
    qualifyingVenueCount: qualifying.length,
  }
}

// ---------------------------------------------------------------------------
// Peer maths
// ---------------------------------------------------------------------------

/**
 * Where `value` sits among `peers`: the share of peers it is ahead of,
 * 0 to 100. Ties count half, which is the standard mid-rank treatment and
 * stops a room full of identical venues all reporting 100th percentile.
 *
 * `higherIsBetter` decides what "ahead" means, so a percentile always
 * reads the same way whatever the metric: 80 is good, 20 is not.
 */
export function percentileRank(
  value: number,
  peers: readonly number[],
  higherIsBetter: boolean,
): number | null {
  if (peers.length === 0) return null
  let ahead = 0
  let ties = 0
  for (const peer of peers) {
    if (peer === value) ties++
    else if (higherIsBetter ? value > peer : value < peer) ahead++
  }
  return Math.round(((ahead + ties / 2) / peers.length) * 100)
}

/** One metric, compared. Nothing in here identifies a peer: the only
 *  peer-derived fields are a count, a median and two quartiles. */
export interface BenchmarkComparison {
  key: BenchmarkMetricKey
  label: string
  question: string
  unit: BenchmarkUnit
  higherIsBetter: boolean
  method: string
  /** The caller's own number, with its own sample size and honesty flag. */
  you: BenchmarkMetricValue
  /** How many peers could answer this metric at all. */
  peerCount: number
  peerMedian: number | null
  peerP25: number | null
  peerP75: number | null
  /** 0-100, the share of peers the caller is ahead of. Null when the
   *  caller has no number, or when the metric is suppressed. */
  percentile: number | null
  /** True when too few peers could answer for the comparison to be shown.
   *  Median, quartiles and percentile are all null when it is. */
  suppressed: boolean
  suppressedReason: string | null
}

/**
 * Compare one metric against a bag of peer numbers.
 *
 * The signature is the anonymity guarantee. This function receives
 * `readonly number[]`. It has no venue object to leak and no id it could
 * forget to strip, so no future edit to it can start returning one.
 */
export function summarisePeerMetric(
  key: BenchmarkMetricKey,
  you: BenchmarkMetricValue,
  peerValues: readonly number[],
  minPeers: number = BENCHMARK_MIN_PEERS,
): BenchmarkComparison {
  const def = METRIC_BY_KEY.get(key)
  if (!def) throw new Error(`[benchmark] unknown metric ${key}`)

  const base = {
    key,
    label: def.label,
    question: def.question,
    unit: def.unit,
    higherIsBetter: def.higherIsBetter,
    method: def.method,
    you,
  }

  if (peerValues.length < minPeers) {
    return {
      ...base,
      peerCount: peerValues.length,
      peerMedian: null,
      peerP25: null,
      peerP75: null,
      percentile: null,
      suppressed: true,
      suppressedReason:
        peerValues.length === 0
          ? 'No other venue has a number for this yet.'
          : `Only ${peerValues.length} other venue${peerValues.length === 1 ? '' : 's'} can answer this, and ${minPeers} are needed before a comparison means anything.`,
    }
  }

  const sorted = [...peerValues].sort((a, b) => a - b)
  return {
    ...base,
    peerCount: peerValues.length,
    peerMedian: percentile(sorted, 50),
    peerP25: percentile(sorted, 25),
    peerP75: percentile(sorted, 75),
    percentile:
      you.value === null ? null : percentileRank(you.value, sorted, def.higherIsBetter),
    suppressed: false,
    suppressedReason: null,
  }
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

export interface VenueBenchmark {
  venueId: string
  mode: BenchmarkMode
  /** True when the peers are demo venues, so the surface can say so. */
  demoPeers: boolean
  /** Peers in the set, before any per-metric filtering. */
  peerCount: number
  /** Peers needed before anything is compared. */
  minPeers: number
  /** False when the peer set is below the threshold. The surface then
   *  says so and shows nothing else. */
  enoughPeers: boolean
  /** Venues in the pool including the caller, for the honest message. */
  qualifyingVenueCount: number
  comparisons: BenchmarkComparison[]
  generatedAt: string
}

export interface BuildVenueBenchmarkOptions {
  /** How one venue's numbers are read. Defaults to
   *  `computeVenueBenchmarkValues`, which goes to the spine. Injected by
   *  the unit tests so the peer-set logic, the threshold and the
   *  anonymisation can be driven without a database behind them. */
  readValues?: (
    supabase: SupabaseClient,
    venueId: string,
  ) => Promise<VenueBenchmarkValues>
}

/**
 * Build the whole comparison for one venue.
 *
 * Note the order: the peer set is resolved, each peer's numbers are read,
 * and then the peer rows are collapsed into arrays of plain numbers
 * BEFORE `summarisePeerMetric` sees them. Peer identity does not travel
 * past this function.
 *
 * Below the threshold no peer is read at all. That is not an
 * optimisation, it is the point: there is no reason to touch another
 * venue's rows when nothing can be shown from them.
 */
export async function buildVenueBenchmark(
  supabase: SupabaseClient,
  venueId: string,
  opts: BuildVenueBenchmarkOptions = {},
): Promise<VenueBenchmark> {
  assertServerOnly()
  const readValues = opts.readValues ?? computeVenueBenchmarkValues
  const generatedAt = new Date().toISOString()
  const peers = await benchmarkPeerSet(venueId, supabase)

  const you = await readValues(supabase, venueId)

  if (peers.peerVenueIds.length < BENCHMARK_MIN_PEERS) {
    return {
      venueId,
      mode: peers.mode,
      demoPeers: peers.mode === 'demo',
      peerCount: peers.peerVenueIds.length,
      minPeers: BENCHMARK_MIN_PEERS,
      enoughPeers: false,
      qualifyingVenueCount: peers.qualifyingVenueCount,
      comparisons: BENCHMARK_METRICS.map((m) =>
        summarisePeerMetric(m.key, you.values[m.key], []),
      ),
      generatedAt,
    }
  }

  const peerRows = await Promise.all(
    peers.peerVenueIds.map((id) => readValues(supabase, id)),
  )

  // Peer identity stops here. From this line on there are only numbers.
  const peerNumbers = new Map<BenchmarkMetricKey, number[]>()
  for (const m of BENCHMARK_METRICS) peerNumbers.set(m.key, [])
  for (const row of peerRows) {
    for (const m of BENCHMARK_METRICS) {
      const cell = row.values[m.key]
      // A peer below its own sample floor does not get to move the
      // median. An untrustworthy number is untrustworthy in a peer set
      // too.
      if (cell.value === null || !cell.enoughData) continue
      peerNumbers.get(m.key)!.push(cell.value)
    }
  }

  return {
    venueId,
    mode: peers.mode,
    demoPeers: peers.mode === 'demo',
    peerCount: peers.peerVenueIds.length,
    minPeers: BENCHMARK_MIN_PEERS,
    enoughPeers: true,
    qualifyingVenueCount: peers.qualifyingVenueCount,
    comparisons: BENCHMARK_METRICS.map((m) =>
      summarisePeerMetric(m.key, you.values[m.key], peerNumbers.get(m.key) ?? []),
    ),
    generatedAt,
  }
}

/** Service-client wrapper. Dynamic import so the module itself stays
 *  cheap to load, same shape as canonical.ts. */
export async function getVenueBenchmark(venueId: string): Promise<VenueBenchmark> {
  assertServerOnly()
  const { createServiceClient } = await import('@/lib/supabase/service')
  return buildVenueBenchmark(createServiceClient(), venueId)
}
