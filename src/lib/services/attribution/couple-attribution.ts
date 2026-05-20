/**
 * D3 — couple-keyed source attribution (Tier 8 / Appendix C §C.5).
 *
 * Reads the identity-first spine (`couples` + `touchpoints`) and rolls up
 * acquisition credit per channel under four multi-touch models. This is
 * the spine-side parallel of `attribution/index.ts` (which is wedding-
 * keyed over `wedding_touchpoints` and still load-bearing for the legacy
 * `/intel/sources` page). The two services may co-exist while §C.5's
 * Phase F sunset is staged.
 *
 * Battery questions answered:
 *  - Q5  ("which surface gets credit — and can I see the logic?"):
 *        the per-couple drill-down returns the ordered touchpoint ribbon
 *        plus the credited-channel map under every model. The surface
 *        shows the ribbon → model → credit chain end-to-end.
 *  - Q26 (highest first-touch-to-booking conversion vs highest volume):
 *        per-channel volume AND inquiry-to-booking conversion are both
 *        returned so the user can read them side-by-side. Doctrine note:
 *        volume ≠ conversion is a first-class distinction in the surface.
 *  - Q28 (content mention conversion lift — blog / IG reel / Pinterest):
 *        the per-couple ribbon's `raw_payload` is text-mined for content-
 *        mention families and rolled up with a lift number against the
 *        cohort base rate. enoughData-gated.
 *  - Q33 (adversarial-consistency: best channel / which to cut / where
 *        to invest more): the same per-channel rollup is the answer to
 *        all three framings. Volume + conversion + CAC + revenue_per_$
 *        are surfaced together so the operator chooses the lens; the
 *        underlying numbers are constant across the three questions.
 *
 * Honesty doctrine (§C.6 Tier 4):
 *  - Every per-channel cell carries its own `n`; rates are derived via
 *    `ratio` (null on zero denominator, never 0/0 = NaN).
 *  - `enoughData` flags any cell below MIN_ATTRIBUTION_N.
 *  - When a couple has no acquisition-class touchpoint, first/last/linear
 *    credits route to a synthetic `'(unknown_acquisition)'` bucket
 *    rather than crediting plumbing channels. The surface labels this
 *    explicitly so the operator doesn't read it as a channel.
 *
 * Multi-venue safe: every read filters on venueId. No venue-specific
 * clauses. The PLUMBING_CHANNELS set is a doctrine constant, not a
 * Rixey patch.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CohortData, TouchpointRow } from '../cohort/types'
import { loadCohortData } from '../cohort/data'
import { buildCoupleFacts, type CoupleFacts } from '../cohort/facts'
import { isOutbound } from '../cohort/direction'
import { ratio, round2 } from '../cohort/helpers'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AttributionModel =
  | 'first_touch'
  | 'last_touch'
  | 'linear'
  | 'time_decay'

export const ATTRIBUTION_MODELS: AttributionModel[] = [
  'first_touch',
  'last_touch',
  'linear',
  'time_decay',
]

/**
 * Plumbing channels: scheduling tools, response media, CRM hand-off
 * surfaces. These appear in the touchpoint ribbon (so Q5 transparency
 * shows them) but they do NOT receive acquisition credit — a couple
 * who replied over Gmail did not discover the venue on Gmail.
 *
 * This is doctrine, not Rixey config. Same rule applies to every venue.
 * gmail / sms / calendly / honeybook are response and scheduling tooling
 * for every venue Bloom onboards.
 */
export const PLUMBING_CHANNELS = new Set([
  'gmail',
  'sms',
  'calendly',
  'honeybook',
])

export function isAcquisitionChannel(channel: string): boolean {
  return !PLUMBING_CHANNELS.has(channel)
}

/** Time-decay half-life: how quickly older touchpoints lose credit. */
const TIME_DECAY_HALF_LIFE_DAYS = 14
const TIME_DECAY_HALF_LIFE_MS = TIME_DECAY_HALF_LIFE_DAYS * 86400_000

/** Below this n, channel cells are flagged not-enough-data. Same floor
 *  as D9's MIN_DISTRIBUTION_N keeps both surfaces honest in parallel. */
export const MIN_ATTRIBUTION_N = 8

/** Content-mention families for Q28. Regex over touchpoint text in the
 *  ribbon. Mention-counts are dedup'd per couple per family so a couple
 *  who mentions Instagram three times still only contributes once. */
const CONTENT_MENTION_FAMILIES: { family: string; label: string; re: RegExp }[] = [
  {
    family: 'instagram',
    label: 'Instagram',
    re: /\b(instagram|insta(gram)?|ig\b|reel|reels)\b/i,
  },
  {
    family: 'pinterest',
    label: 'Pinterest',
    re: /\b(pinterest|pin(s|ned)?\b)\b/i,
  },
  {
    family: 'blog',
    label: 'Blog post',
    re: /\b(blog(\s*post)?|article|read your)\b/i,
  },
  {
    family: 'tiktok',
    label: 'TikTok',
    re: /\btik\s?tok\b/i,
  },
  {
    family: 'photo',
    label: 'Specific photo',
    re: /\b(saw (a |the )?(pic|photo|image)|that photo|the picture of)\b/i,
  },
  {
    family: 'video',
    label: 'Specific video',
    re: /\b(saw (a |the )?video|that video|youtube)\b/i,
  },
]

/** A couple's full ribbon + the credits each model assigned. The surface
 *  uses this to show the Q5 "show the logic" drill-down. */
export interface CoupleAttributionRow {
  coupleId: string
  primaryName: string | null
  lifecycleState: string
  outcome: 'booked' | 'ghost' | 'in_progress'
  bookedAt: string | null
  /** Booking_value in cents when available — `couples` doesn't carry it
   *  directly today; if a future schema attaches it, the loader will
   *  populate this. Surface treats null as "revenue unknown". */
  revenueCents: number | null
  /** Full touchpoint ribbon, occurred_at ASC, every channel including
   *  plumbing. The surface renders this verbatim for transparency. */
  ribbon: {
    id: string
    channel: string
    actionType: string
    occurredAt: string
    direction: 'inbound' | 'outbound'
    isAcquisition: boolean
    signalTier: string
  }[]
  /** The couples acquisition touchpoints — ribbon entries that pass
   *  `isAcquisitionChannel`. The four models distribute credit over
   *  this list (not the full ribbon). */
  acquisitionTouchCount: number
  /** Per-model channel-credit map. Sums to 1.0 per model when at least
   *  one acquisition touchpoint exists; sums to 0 when not (credit
   *  routes to '(unknown_acquisition)' which is then surfaced honestly). */
  credits: Record<AttributionModel, { channel: string; weight: number }[]>
}

export interface ChannelModelCell {
  /** Sum of model-weighted couple credits in this cell. */
  weightedCouples: number
  weightedBooked: number
  weightedRevenueCents: number
  /** Distinct couples with ANY weight in this channel under this model.
   *  This is the n surfaces gate enoughData on — fractional couples
   *  inflate a linear-model n in a misleading way. */
  distinctCouples: number
  distinctBooked: number
  /** Inquiry-to-booking conversion derived from weightedCouples (denominator)
   *  and weightedBooked (numerator). null when weightedCouples = 0. */
  inquiryToBookingRate: number | null
  /** Marketing spend in cents observed for this channel in the same
   *  window (or null when no spend data). */
  spendCents: number | null
  /** Cost-per-booked-couple in cents. null when spend or bookings = 0. */
  cacCents: number | null
  /** Revenue-per-dollar-spent ratio. null when spend = 0 or revenue
   *  unknown. */
  revenuePerDollar: number | null
  enoughData: boolean
}

export interface ChannelAttributionRow {
  channel: string
  isAcquisition: boolean
  models: Record<AttributionModel, ChannelModelCell>
}

export interface ContentMentionRow {
  family: string
  label: string
  couplesMentioning: number
  bookedAmongMentioning: number
  mentionConversion: number | null
  cohortConversion: number | null
  /** mentionConversion / cohortConversion. null when either is null. */
  lift: number | null
  enoughData: boolean
}

export interface AttributionResult {
  venueId: string
  generatedAt: string
  timezone: string
  meta: {
    coupleCount: number
    coupleBookedCount: number
    acquisitionTouchCount: number
    plumbingTouchCount: number
    /** Couples that have ZERO acquisition-class touchpoints. They drag
     *  every channel rate toward zero — same shape as D9's
     *  `couplesWithoutTouchpoints` honesty card. */
    couplesWithoutAcquisitionTouch: number
    marketingSpendAvailable: boolean
    marketingSpendNote: string
  }
  channels: ChannelAttributionRow[]
  contentMentions: ContentMentionRow[]
  /** Per-couple ribbons. Cap is applied to keep the payload bounded — the
   *  surface can paginate, and at v1 Rixey-scale this is fine. */
  couples: CoupleAttributionRow[]
  /** Human-readable explainers, one per model, that the surface renders
   *  verbatim next to the model selector. Doctrine: never explain the
   *  model only in the API response — the operator needs to see it. */
  modelExplainers: Record<AttributionModel, string>
}

export interface BuildAttributionOptions {
  /** Inclusive lower bound on touchpoint occurred_at (ISO). */
  since?: string | null
  /** Maximum number of couple ribbons to return; defaults to 500.
   *  Surface paginates anyway, this is a payload cap. */
  coupleLimit?: number
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MODEL_EXPLAINERS: Record<AttributionModel, string> = {
  first_touch:
    'First touch: the earliest acquisition-class touchpoint in this couple\'s ribbon gets 100% of the credit. Says "where did this couple discover us." Strongest when acquisition channels are paid (Knot / Google Ads) and downstream channels are response plumbing.',
  last_touch:
    'Last touch: the latest acquisition-class touchpoint before booking (or before the most recent ribbon entry if not booked) gets 100% of the credit. Says "what closed this lead." Useful when retargeting / second-touch surfaces actually drive the booking decision.',
  linear:
    'Linear: every distinct acquisition-class channel in the ribbon gets equal credit (1/N). Useful when first and last touch both feel partial and you do not want to overweight either end.',
  time_decay:
    `Time decay: acquisition touchpoints closer to the booking (or the most recent ribbon entry) get more credit, with a ${TIME_DECAY_HALF_LIFE_DAYS}-day half-life. Recency-biased — useful when the couple\'s decision is driven by what they saw last but you still want to honor everything in their ribbon.`,
}

/** Compute per-model channel credit weights for one couple, summing to
 *  1.0 across all channels when at least one acquisition touch exists. */
function computeCredits(
  acquisitionTouches: TouchpointRow[],
  anchorMs: number,
): Record<AttributionModel, Map<string, number>> {
  const credits: Record<AttributionModel, Map<string, number>> = {
    first_touch: new Map(),
    last_touch: new Map(),
    linear: new Map(),
    time_decay: new Map(),
  }

  if (acquisitionTouches.length === 0) {
    // No acquisition touch — every model contributes 1.0 to
    // '(unknown_acquisition)' so the couple still appears in the rollup
    // total, but credit doesn't leak to plumbing.
    for (const m of ATTRIBUTION_MODELS) {
      credits[m].set('(unknown_acquisition)', 1)
    }
    return credits
  }

  // First touch: earliest acquisition touch.
  const first = acquisitionTouches[0]
  credits.first_touch.set(first.channel, 1)

  // Last touch: latest acquisition touch on or before anchor (when
  // anchor is a booking event) or the latest overall when no booking.
  // anchorMs is either the booked touchpoint's time OR the latest ribbon
  // entry's time when not booked.
  const lastBeforeAnchor =
    [...acquisitionTouches]
      .reverse()
      .find((t) => Date.parse(t.occurred_at) <= anchorMs) ??
    acquisitionTouches[acquisitionTouches.length - 1]
  credits.last_touch.set(lastBeforeAnchor.channel, 1)

  // Linear: equal credit across distinct channels.
  const distinct = new Set(acquisitionTouches.map((t) => t.channel))
  const each = 1 / distinct.size
  for (const ch of distinct) credits.linear.set(ch, each)

  // Time decay: weight each touch by 2^(-Δdays/halfLife) against the
  // anchor, then normalise weights to sum to 1. Aggregate to channel.
  const rawWeights = acquisitionTouches.map((t) => {
    const delta = Math.max(0, anchorMs - Date.parse(t.occurred_at))
    return Math.pow(2, -delta / TIME_DECAY_HALF_LIFE_MS)
  })
  const sum = rawWeights.reduce((s, w) => s + w, 0)
  if (sum > 0) {
    for (let i = 0; i < acquisitionTouches.length; i++) {
      const ch = acquisitionTouches[i].channel
      const w = rawWeights[i] / sum
      credits.time_decay.set(ch, (credits.time_decay.get(ch) ?? 0) + w)
    }
  } else {
    // All touches are infinitely far back — degenerate; fall back to
    // linear so the couple isn't silently dropped.
    for (const ch of distinct) credits.time_decay.set(ch, each)
  }

  return credits
}

/** Per-couple ribbon shape + computed credits. */
function buildCoupleAttributionRow(
  facts: CoupleFacts,
): CoupleAttributionRow {
  const acquisitionTouches = facts.touchpoints.filter(
    (t) => !isOutbound(t) && isAcquisitionChannel(t.channel),
  )

  // Anchor for last-touch / time-decay: booking moment if known, else
  // the latest ribbon entry's time.
  const bookedTp = facts.touchpoints.find(
    (t) =>
      t.action_type === 'booked' ||
      t.action_type === 'contract_signed',
  )
  const anchorMs = bookedTp
    ? Date.parse(bookedTp.occurred_at)
    : facts.touchpoints.length > 0
      ? Date.parse(facts.touchpoints[facts.touchpoints.length - 1].occurred_at)
      : Date.parse(facts.couple.created_at)

  const credits = computeCredits(acquisitionTouches, anchorMs)

  return {
    coupleId: facts.couple.id,
    primaryName: facts.couple.primary_contact_name ?? null,
    lifecycleState: facts.couple.lifecycle_state,
    outcome: facts.outcome,
    bookedAt: bookedTp ? bookedTp.occurred_at : null,
    revenueCents: null, // couples table doesn't carry revenue today
    ribbon: facts.touchpoints.map((t) => ({
      id: t.id,
      channel: t.channel,
      actionType: t.action_type,
      occurredAt: t.occurred_at,
      direction: isOutbound(t) ? 'outbound' : 'inbound',
      isAcquisition: !isOutbound(t) && isAcquisitionChannel(t.channel),
      signalTier: t.signal_tier,
    })),
    acquisitionTouchCount: acquisitionTouches.length,
    credits: {
      first_touch: [...credits.first_touch.entries()].map(([channel, weight]) => ({
        channel,
        weight: round2(weight),
      })),
      last_touch: [...credits.last_touch.entries()].map(([channel, weight]) => ({
        channel,
        weight: round2(weight),
      })),
      linear: [...credits.linear.entries()].map(([channel, weight]) => ({
        channel,
        weight: round2(weight),
      })),
      time_decay: [...credits.time_decay.entries()].map(([channel, weight]) => ({
        channel,
        weight: round2(weight),
      })),
    },
  }
}

/** Roll up per-channel × per-model cells from a list of couple attributions. */
function rollupChannels(
  rows: CoupleAttributionRow[],
  spendByChannel: Map<string, number>,
): ChannelAttributionRow[] {
  // raw[channel][model] -> running totals
  const raw = new Map<string, Record<AttributionModel, ChannelModelCell>>()

  const emptyCell = (): ChannelModelCell => ({
    weightedCouples: 0,
    weightedBooked: 0,
    weightedRevenueCents: 0,
    distinctCouples: 0,
    distinctBooked: 0,
    inquiryToBookingRate: null,
    spendCents: null,
    cacCents: null,
    revenuePerDollar: null,
    enoughData: false,
  })

  const ensure = (channel: string) => {
    let cur = raw.get(channel)
    if (!cur) {
      cur = {
        first_touch: emptyCell(),
        last_touch: emptyCell(),
        linear: emptyCell(),
        time_decay: emptyCell(),
      }
      raw.set(channel, cur)
    }
    return cur
  }

  for (const r of rows) {
    for (const model of ATTRIBUTION_MODELS) {
      const credits = r.credits[model]
      for (const c of credits) {
        const cell = ensure(c.channel)[model]
        cell.weightedCouples += c.weight
        cell.distinctCouples += 1
        if (r.outcome === 'booked') {
          cell.weightedBooked += c.weight
          cell.distinctBooked += 1
          if (r.revenueCents !== null) {
            cell.weightedRevenueCents += c.weight * r.revenueCents
          }
        }
      }
    }
  }

  const out: ChannelAttributionRow[] = []
  for (const [channel, models] of raw) {
    const isAcq = isAcquisitionChannel(channel) && channel !== '(unknown_acquisition)'
    const spendCents = spendByChannel.get(channel) ?? null
    for (const model of ATTRIBUTION_MODELS) {
      const cell = models[model]
      cell.inquiryToBookingRate = ratio(cell.weightedBooked, cell.weightedCouples)
      cell.spendCents = spendCents
      cell.cacCents =
        spendCents !== null && cell.weightedBooked > 0
          ? Math.round(spendCents / cell.weightedBooked)
          : null
      cell.revenuePerDollar =
        spendCents !== null && spendCents > 0 && cell.weightedRevenueCents > 0
          ? round2(cell.weightedRevenueCents / spendCents)
          : null
      cell.enoughData = cell.distinctCouples >= MIN_ATTRIBUTION_N
      cell.weightedCouples = round2(cell.weightedCouples)
      cell.weightedBooked = round2(cell.weightedBooked)
    }
    out.push({ channel, isAcquisition: isAcq, models })
  }

  // Sort: acquisition channels first, then by linear weightedCouples desc.
  out.sort((a, b) => {
    if (a.isAcquisition !== b.isAcquisition) return a.isAcquisition ? -1 : 1
    return b.models.linear.weightedCouples - a.models.linear.weightedCouples
  })
  return out
}

/** Roll up content mentions across all couple ribbons. */
function rollupContentMentions(
  facts: CoupleFacts[],
): ContentMentionRow[] {
  const cohortTotal = facts.length
  const cohortBooked = facts.filter((f) => f.booked).length
  const cohortConversion = ratio(cohortBooked, cohortTotal)

  return CONTENT_MENTION_FAMILIES.map(({ family, label, re }) => {
    const couplesMentioning = new Set<string>()
    let booked = 0
    for (const f of facts) {
      const matched = f.touchpoints.some((tp) => {
        if (isOutbound(tp)) return false
        const raw = tp.raw_payload as Record<string, unknown> | null
        if (!raw) return false
        const hay = [
          typeof raw.subject === 'string' ? raw.subject : '',
          typeof raw.body_preview === 'string' ? raw.body_preview : '',
          typeof raw.body === 'string' ? raw.body : '',
          typeof raw.full_body === 'string' ? raw.full_body : '',
        ]
          .join(' ')
          .toLowerCase()
        return re.test(hay)
      })
      if (matched) {
        couplesMentioning.add(f.couple.id)
        if (f.booked) booked += 1
      }
    }
    const n = couplesMentioning.size
    const mentionConversion = ratio(booked, n)
    const lift =
      mentionConversion !== null && cohortConversion !== null && cohortConversion > 0
        ? round2(mentionConversion / cohortConversion)
        : null
    return {
      family,
      label,
      couplesMentioning: n,
      bookedAmongMentioning: booked,
      mentionConversion,
      cohortConversion,
      lift,
      enoughData: n >= MIN_ATTRIBUTION_N,
    }
  })
}

/** Load marketing spend in the window, keyed by channel string. Returns
 *  empty map when no spend data — surface honestly reports CAC=null. */
async function loadSpendByChannel(
  supabase: SupabaseClient,
  venueId: string,
  data: CohortData,
): Promise<{ map: Map<string, number>; available: boolean; note: string }> {
  const out = new Map<string, number>()
  const earliest = data.touchpoints[0]?.occurred_at ?? null
  const latest =
    data.touchpoints.length > 0
      ? data.touchpoints[data.touchpoints.length - 1].occurred_at
      : null
  if (!earliest || !latest) {
    return {
      map: out,
      available: false,
      note: 'No touchpoints in this window — marketing spend not loaded.',
    }
  }

  try {
    const { data: records } = await supabase
      .from('marketing_spend_records')
      .select('channel, amount_cents')
      .eq('venue_id', venueId)
      .gte('spend_date', earliest.slice(0, 10))
      .lte('spend_date', latest.slice(0, 10))
    if (records && records.length > 0) {
      for (const r of records as Array<{ channel: string; amount_cents: number }>) {
        const cents = Number(r.amount_cents) || 0
        out.set(r.channel, (out.get(r.channel) ?? 0) + cents)
      }
      return {
        map: out,
        available: true,
        note:
          'Marketing spend pulled from connected spend records. CAC numbers ' +
          'assume the spend.channel value matches the touchpoint.channel value ' +
          'verbatim — review /portal/marketing-channels-config if a channel ' +
          'reports spend but the matching channel key is missing.',
      }
    }
  } catch {
    // table absent — fall through
  }

  return {
    map: out,
    available: false,
    note:
      'No marketing spend recorded for this window — CAC and revenue-per-' +
      'dollar cannot be computed. Add spend at /intel/marketing-spend.',
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Build the full couple-keyed attribution payload for a venue.
 * Reads the spine once via `loadCohortData`, derives per-couple
 * attribution rows, rolls up per-channel × per-model cells, and joins
 * marketing spend for CAC + revenue-per-dollar.
 */
export async function buildCoupleAttribution(
  supabase: SupabaseClient,
  venueId: string,
  opts: BuildAttributionOptions = {},
): Promise<AttributionResult> {
  const data = await loadCohortData(supabase, venueId, { since: opts.since })
  const facts = buildCoupleFacts(data)
  const couples = facts.map(buildCoupleAttributionRow)
  const { map: spendByChannel, available: marketingSpendAvailable, note: marketingSpendNote } =
    await loadSpendByChannel(supabase, venueId, data)
  const channels = rollupChannels(couples, spendByChannel)
  const contentMentions = rollupContentMentions(facts)

  // Acquisition vs plumbing touch counts on the full venue ribbon.
  let acqCount = 0
  let plumbingCount = 0
  for (const t of data.touchpoints) {
    if (isOutbound(t)) continue
    if (isAcquisitionChannel(t.channel)) acqCount += 1
    else plumbingCount += 1
  }

  const couplesWithoutAcquisitionTouch = couples.filter(
    (c) => c.acquisitionTouchCount === 0,
  ).length

  const coupleLimit = opts.coupleLimit ?? 500
  const cappedCouples =
    couples.length > coupleLimit
      ? // sort by has-acquisition + booked first so the most-interesting
        // ribbons survive the cap
        [...couples]
          .sort((a, b) => {
            const aw = a.acquisitionTouchCount > 0 ? 1 : 0
            const bw = b.acquisitionTouchCount > 0 ? 1 : 0
            if (aw !== bw) return bw - aw
            const ab = a.outcome === 'booked' ? 1 : 0
            const bb = b.outcome === 'booked' ? 1 : 0
            if (ab !== bb) return bb - ab
            return b.ribbon.length - a.ribbon.length
          })
          .slice(0, coupleLimit)
      : couples

  return {
    venueId,
    generatedAt: new Date().toISOString(),
    timezone: data.timezone,
    meta: {
      coupleCount: couples.length,
      coupleBookedCount: couples.filter((c) => c.outcome === 'booked').length,
      acquisitionTouchCount: acqCount,
      plumbingTouchCount: plumbingCount,
      couplesWithoutAcquisitionTouch,
      marketingSpendAvailable,
      marketingSpendNote,
    },
    channels,
    contentMentions,
    couples: cappedCouples,
    modelExplainers: MODEL_EXPLAINERS,
  }
}

