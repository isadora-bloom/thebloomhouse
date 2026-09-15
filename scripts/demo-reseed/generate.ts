/**
 * demo-reseed — the pure generator.
 *
 * No IO. No clock read (the caller passes `today`). No database. Given a
 * seed and a date, it returns the same dataset every time, which is what
 * lets a unit test assert on the shape and lets the operator get the same
 * demo twice.
 *
 * Read DEMO-RESEED-DESIGN.md §3 for the story model this implements. The
 * one property that matters more than any other: every date in the output
 * is an OFFSET, so heat stays alive whenever the reseed is run.
 */

import {
  DEMO_VENUES,
  FICTIONAL_EMAIL_DOMAINS,
  FIRST_NAMES,
  FORBIDDEN_EMAIL_FRAGMENTS,
  HEAT_POINTS,
  HERO_PARTNER_EMAIL,
  HERO_PARTNER_NAME,
  HERO_PRIMARY_EMAIL,
  HERO_PRIMARY_NAME,
  HERO_VENUE_ID,
  HERO_WEDDING_ID,
  PARTNER_NAMES,
  SOURCE_FOR_CHANNEL,
  SURNAMES,
  tierForScore,
  type DemoVenue,
} from './roster'
import { makeRng, weightedPick, type Rng } from './rng'
import type {
  DemoChannel,
  DemoCoupleStory,
  DemoDataset,
  DemoLifecycle,
  DemoSignalStep,
  DemoTier,
  DemoWeddingSource,
} from './types'

export interface GenerateOptions {
  seed?: number
  /** ISO instant the offsets are measured from. Defaults to `SEED_TODAY`,
   *  so this module never reads a clock and two runs agree. The live
   *  reseed CLI passes the real clock explicitly. */
  today?: string
  /** Roughly how many couples to produce across all four venues. The
   *  actual count is the sum of the per-venue shares, so it lands within
   *  a couple of the request. */
  coupleCount?: number
}

export const DEFAULT_SEED = 20260909
export const DEFAULT_COUPLE_COUNT = 60

/**
 * The instant every offset in the demo is measured from when the caller
 * does not supply one.
 *
 * `scripts/demo-reseed.ts` passes the real clock, because a reseed run
 * against a live demo should make the demo look like the day it was run.
 * Everything that has to be REPRODUCIBLE — the composed e2e seed, the
 * coverage report, the determinism test — takes this constant instead, so
 * two runs a week apart produce the same rows and a diff of the generated
 * SQL is a diff of intent rather than of the calendar.
 *
 * Midday UTC rather than midnight: a story step at `minuteOfDay` 0 on
 * `daysAgo` 0 would otherwise sit exactly on the boundary and flip
 * between "today" and "yesterday" depending on the reader's timezone.
 */
export const SEED_TODAY = '2026-09-15T12:00:00.000Z'

/** Lifecycle mix. Weights, not percentages; normalised at pick time. */
const LIFECYCLE_WEIGHTS: Record<DemoLifecycle, number> = {
  inquiry: 30,
  tour_booked: 12,
  toured: 15,
  booked: 20,
  lost: 15,
  completed: 8,
}

/** Origin channel mix. */
const CHANNEL_WEIGHTS: Record<DemoChannel, number> = {
  knot: 28,
  website: 24,
  weddingwire: 14,
  instagram: 12,
  gmail: 18,
  // Calendly is never an origin — a tour booking always follows an
  // inquiry on some other channel. Nor is HoneyBook: the contract is the
  // end of a story, never its start. Nor SMS: a couple only has the
  // number once someone has replied to them.
  calendly: 0,
  honeybook: 0,
  sms: 0,
}

/** `weddings.status` for each lifecycle. CHECK list from migration 001. */
export const WEDDING_STATUS_FOR_LIFECYCLE: Record<DemoLifecycle, string> = {
  inquiry: 'inquiry',
  tour_booked: 'tour_scheduled',
  toured: 'tour_completed',
  booked: 'booked',
  lost: 'lost',
  completed: 'completed',
}

const LOST_REASONS: readonly string[] = [
  'Went with a venue closer to family',
  'Budget came in under our minimum',
  'Their date was already held',
  'Stopped replying after the tour',
  'Chose an all-inclusive package elsewhere',
]

const LOST_STAGES: ReadonlyArray<'inquiry' | 'tour' | 'hold' | 'contract'> = [
  'inquiry',
  'tour',
  'hold',
  'contract',
]

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function assertFictionalEmail(email: string): void {
  const lower = email.toLowerCase()
  for (const fragment of FORBIDDEN_EMAIL_FRAGMENTS) {
    if (lower.includes(fragment)) {
      throw new Error(
        `demo-reseed refuses to generate the address ${email}: ` +
          `it contains "${fragment}", which is either a real inbox or a relay. ` +
          `Use an RFC 2606 reserved domain instead.`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Copy. Short, human, venue-flavoured — this is what a demo visitor reads
// when they open a touchpoint, so it should not look machine-made.
// ---------------------------------------------------------------------------

function inquiryBody(rng: Rng, venue: DemoVenue, guestCount: number): string {
  const openers = [
    `We are hoping for something around ${guestCount} people and ${venue.name} keeps coming up in every list we make.`,
    `Are you holding any Saturdays next autumn? We are a party of about ${guestCount}.`,
    `My partner grew up nearby and has wanted to see ${venue.name} since we got engaged. Roughly ${guestCount} guests.`,
    `We saw the hilltop photos and could not stop talking about them. About ${guestCount} guests, flexible on the date.`,
  ]
  return rng.pick(openers)
}

function replyBody(rng: Rng): string {
  return rng.pick([
    'That works, thank you. One more question about the bar minimum.',
    'We had a look at the brochure last night and have a few notes.',
    'My mum asked about parking, sorry to add to the list.',
    'Sending this from my phone, but yes, that date still suits us.',
    'We loved the barn. The lighting in the second photo especially.',
  ])
}

function tourBody(rng: Rng, venue: DemoVenue): string {
  return rng.pick([
    `Booked in for the ${venue.name} tour. Looking forward to it.`,
    'Tour confirmed. We may bring one parent along if that is alright.',
    'Slot booked. We will be driving up the morning of.',
  ])
}

function postTourBody(rng: Rng): string {
  return rng.pick([
    'Thank you for the walk round. We are talking it over this week.',
    'Loved it. Could you send the pricing sheet again with the Friday rate?',
    'That was lovely. We have one other venue to see and then we will decide.',
  ])
}

function contractBody(rng: Rng): string {
  return rng.pick([
    'Signed and sent back. Thank you for being patient with us.',
    'Contract is signed. Deposit going out on Monday.',
    'All signed. We cannot quite believe it is booked.',
  ])
}

function smsBody(rng: Rng): string {
  return rng.pick([
    'Running about fifteen minutes late for the tour, sorry.',
    'Is parking on the left as we come up the drive?',
    'Sent the guest numbers through on email just now.',
    'Can we bring my mum on Saturday?',
    'Thank you for today, we both loved it.',
  ])
}

function coolingBody(rng: Rng): string {
  return rng.pick([
    'Thank you for the follow up. We are still deciding.',
    'Sorry for the slow reply, work has been busy.',
    'We are going to sit on it a little longer.',
  ])
}

// ---------------------------------------------------------------------------
// Timeline builders — one per lifecycle. Every step is an offset.
// ---------------------------------------------------------------------------

interface TimelineContext {
  rng: Rng
  venue: DemoVenue
  originChannel: DemoChannel
  guestCount: number
}

function step(
  daysAgo: number,
  minuteOfDay: number,
  channel: DemoChannel,
  actionType: string,
  signalTier: DemoSignalStep['signalTier'],
  direction: 'inbound' | 'outbound',
  bodyText: string,
  heatEvents: string[],
): DemoSignalStep {
  return {
    daysAgo,
    minuteOfDay,
    channel,
    actionType,
    signalTier,
    direction,
    bodyText,
    heatEvents,
  }
}

/** The opening inquiry every story shares. */
function openingSteps(
  ctx: TimelineContext,
  inquiryDaysAgo: number,
  responseDelayHours: number,
  extraHeat: string[],
): DemoSignalStep[] {
  const { rng, venue, originChannel } = ctx
  const inquiryMinute = rng.int(8 * 60, 21 * 60)
  const replyDaysAgo = Math.max(0, inquiryDaysAgo - responseDelayHours / 24)
  return [
    step(
      inquiryDaysAgo,
      inquiryMinute,
      originChannel,
      // These verbs are not decorative. `progressionEventTypeFor` maps
      // (channel, action_type) to a progression event, and it only knows
      // the live vocabulary: knot/weddingwire 'inquiry', website
      // 'inquiry_form_submitted', gmail 'reply'. The reseed used to emit
      // 'channel_inquiry' and 'form_submit', which map to nothing, so
      // every Knot and web-form inquiry in the demo landed as a
      // touchpoint with no progression row and no decay clock behind it.
      originChannel === 'instagram'
        ? 'ig_dm'
        : originChannel === 'website'
          ? 'inquiry_form_submitted'
          : originChannel === 'gmail'
            ? 'reply'
            : 'inquiry',
      originChannel === 'instagram' ? 'medium' : 'high',
      'inbound',
      inquiryBody(rng, venue, ctx.guestCount),
      ['initial_inquiry', ...extraHeat],
    ),
    step(
      replyDaysAgo,
      Math.min(22 * 60, inquiryMinute + rng.int(30, 240)),
      'gmail',
      'venue_sent',
      'medium',
      'outbound',
      `Thanks for getting in touch about ${venue.name}. Here are a few dates we still have open.`,
      [],
    ),
  ]
}

function buildInquiry(ctx: TimelineContext): {
  steps: DemoSignalStep[]
  inquiryDaysAgo: number
  responseDelayHours: number
} {
  const { rng } = ctx
  // Four shapes so the leads list is not uniformly warm or uniformly
  // dead: something landed today, something is a fortnight old and
  // cooling, something has been sitting since spring, and something is
  // old enough that the monthly story, the cohort funnel and the weekday
  // conversion charts have more than one season to draw. Eighteen months
  // is the window those readers ask for.
  const shape = weightedPick(rng, { fresh: 28, cooling: 26, stale: 26, historic: 20 })
  const inquiryDaysAgo =
    shape === 'fresh'
      ? rng.int(0, 5)
      : shape === 'cooling'
        ? rng.int(12, 38)
        : shape === 'stale'
          ? rng.int(70, 175)
          : rng.int(210, 540)
  const responseDelayHours =
    shape === 'stale' || shape === 'historic' ? rng.int(6, 72) : rng.int(1, 20)
  const extraHeat =
    shape === 'fresh'
      ? rng.chance(0.6)
        ? ['tour_requested', 'high_commitment_signal']
        : ['high_specificity']
      : shape === 'cooling'
        ? ['high_specificity']
        : []

  const steps = openingSteps(ctx, inquiryDaysAgo, responseDelayHours, extraHeat)

  if (shape === 'fresh') {
    steps.push(
      step(
        Math.max(0, inquiryDaysAgo - 1),
        ctx.rng.int(9 * 60, 20 * 60),
        'gmail',
        'reply',
        'high',
        'inbound',
        replyBody(ctx.rng),
        ['email_reply_received', 'family_mentioned'],
      ),
    )
    if (ctx.rng.chance(0.5)) {
      steps.push(
        step(
          0,
          ctx.rng.int(9 * 60, 20 * 60),
          'website',
          'pricing_view',
          'low',
          'inbound',
          'Viewed the pricing page.',
          ['pricing_page_view'],
        ),
      )
    }
  } else if (shape === 'cooling' || shape === 'historic') {
    steps.push(
      step(
        Math.max(0, inquiryDaysAgo - ctx.rng.int(2, 6)),
        ctx.rng.int(9 * 60, 20 * 60),
        'gmail',
        'reply',
        'high',
        'inbound',
        coolingBody(ctx.rng),
        ['email_reply_received'],
      ),
    )
  }

  return { steps, inquiryDaysAgo, responseDelayHours }
}

function buildTourBooked(ctx: TimelineContext): {
  steps: DemoSignalStep[]
  inquiryDaysAgo: number
  responseDelayHours: number
  tourDaysAgo: number
} {
  const { rng, venue } = ctx
  const inquiryDaysAgo = rng.int(6, 30)
  const responseDelayHours = rng.int(1, 12)
  const steps = openingSteps(ctx, inquiryDaysAgo, responseDelayHours, [
    'tour_requested',
  ])
  // Strictly after the inquiry. A tour booked before the couple got in
  // touch would sort ahead of the mint and orphan the whole story.
  const bookedDaysAgo = rng.int(0, Math.max(1, inquiryDaysAgo - 2))
  // Negative days-ago = in the future. The tour has not happened yet.
  const tourDaysAgo = -rng.int(2, 21)
  steps.push(
    step(
      bookedDaysAgo,
      rng.int(9 * 60, 19 * 60),
      'calendly',
      'tour_booked',
      'high',
      'inbound',
      tourBody(rng, venue),
      ['tour_scheduled'],
    ),
  )
  if (rng.chance(0.5)) {
    steps.push(
      step(
        Math.max(0, bookedDaysAgo - 1),
        rng.int(9 * 60, 20 * 60),
        'gmail',
        'reply',
        'high',
        'inbound',
        replyBody(rng),
        ['email_reply_received'],
      ),
    )
  }
  return { steps, inquiryDaysAgo, responseDelayHours, tourDaysAgo }
}

function buildToured(ctx: TimelineContext): {
  steps: DemoSignalStep[]
  inquiryDaysAgo: number
  responseDelayHours: number
  tourDaysAgo: number
} {
  const { rng, venue } = ctx
  const tourDaysAgo = rng.int(2, 30)
  const inquiryDaysAgo = tourDaysAgo + rng.int(7, 35)
  const responseDelayHours = rng.int(1, 18)
  const steps = openingSteps(ctx, inquiryDaysAgo, responseDelayHours, [
    'tour_requested',
  ])
  steps.push(
    step(
      tourDaysAgo + rng.int(3, 10),
      rng.int(9 * 60, 19 * 60),
      'calendly',
      'tour_booked',
      'high',
      'inbound',
      tourBody(rng, venue),
      ['tour_scheduled'],
    ),
    step(
      tourDaysAgo,
      rng.int(10 * 60, 16 * 60),
      'calendly',
      'tour_attended',
      'highest',
      'inbound',
      `Toured ${venue.name}.`,
      ['tour_completed'],
    ),
    step(
      Math.max(0, tourDaysAgo - rng.int(1, 4)),
      rng.int(9 * 60, 21 * 60),
      'gmail',
      'reply',
      'high',
      'inbound',
      postTourBody(rng),
      ['email_reply_received', 'high_commitment_signal'],
    ),
  )
  return { steps, inquiryDaysAgo, responseDelayHours, tourDaysAgo }
}

function buildBooked(ctx: TimelineContext): {
  steps: DemoSignalStep[]
  inquiryDaysAgo: number
  responseDelayHours: number
  tourDaysAgo: number
  signedDaysAgo: number
} {
  const { rng, venue } = ctx
  const signedDaysAgo = rng.int(3, 120)
  const tourDaysAgo = signedDaysAgo + rng.int(7, 30)
  const inquiryDaysAgo = tourDaysAgo + rng.int(10, 40)
  const responseDelayHours = rng.int(1, 10)
  const steps = openingSteps(ctx, inquiryDaysAgo, responseDelayHours, [
    'tour_requested',
    'high_commitment_signal',
  ])
  steps.push(
    step(
      tourDaysAgo + rng.int(3, 10),
      rng.int(9 * 60, 19 * 60),
      'calendly',
      'tour_booked',
      'high',
      'inbound',
      tourBody(rng, venue),
      ['tour_scheduled'],
    ),
    step(
      tourDaysAgo,
      rng.int(10 * 60, 16 * 60),
      'calendly',
      'tour_attended',
      'highest',
      'inbound',
      `Toured ${venue.name}.`,
      ['tour_completed'],
    ),
    step(
      signedDaysAgo + rng.int(2, 8),
      rng.int(9 * 60, 18 * 60),
      'gmail',
      'proposal_view',
      'medium_high',
      'inbound',
      'Opened the proposal.',
      ['contract_sent', 'contract_viewed'],
    ),
    step(
      signedDaysAgo,
      rng.int(9 * 60, 21 * 60),
      'gmail',
      'reply',
      'highest',
      'inbound',
      contractBody(rng),
      ['contract_signed'],
    ),
    // The contract itself, on the channel the spine recognises. This is
    // what writes the `contract_signed` row in couple_progression_events
    // — the couple's email above says they are signing, but only this
    // records that they did. Heat is left empty so the signing points
    // are not counted twice.
    step(
      signedDaysAgo,
      rng.int(9 * 60, 21 * 60),
      'honeybook',
      'contract_signed',
      'highest',
      'inbound',
      'Contract signed.',
      [],
    ),
  )
  return { steps, inquiryDaysAgo, responseDelayHours, tourDaysAgo, signedDaysAgo }
}

function buildLost(ctx: TimelineContext): {
  steps: DemoSignalStep[]
  inquiryDaysAgo: number
  responseDelayHours: number
  tourDaysAgo: number | null
  lostDaysAgo: number
} {
  const { rng, venue } = ctx
  const lostDaysAgo = rng.int(20, 160)
  const inquiryDaysAgo = lostDaysAgo + rng.int(15, 70)
  const responseDelayHours = rng.int(4, 96)
  const steps = openingSteps(ctx, inquiryDaysAgo, responseDelayHours, [])
  const toured = rng.chance(0.45)
  const tourDaysAgo = toured ? lostDaysAgo + rng.int(5, 25) : null
  if (tourDaysAgo !== null) {
    steps.push(
      step(
        tourDaysAgo + rng.int(3, 9),
        rng.int(9 * 60, 19 * 60),
        'calendly',
        'tour_booked',
        'high',
        'inbound',
        tourBody(rng, venue),
        ['tour_scheduled'],
      ),
      step(
        tourDaysAgo,
        rng.int(10 * 60, 16 * 60),
        'calendly',
        'tour_attended',
        'highest',
        'inbound',
        `Toured ${venue.name}.`,
        ['tour_completed'],
      ),
    )
  }
  steps.push(
    step(
      lostDaysAgo,
      rng.int(9 * 60, 20 * 60),
      'gmail',
      'reply',
      'high',
      'inbound',
      rng.pick([
        'We have decided to go elsewhere. Thank you for all your time.',
        'We booked another venue last week. Sorry for the slow word.',
        'Our plans changed and we are going much smaller. Thank you anyway.',
      ]),
      ['not_interested_signal'],
    ),
  )
  return { steps, inquiryDaysAgo, responseDelayHours, tourDaysAgo, lostDaysAgo }
}

function buildCompleted(ctx: TimelineContext): {
  steps: DemoSignalStep[]
  inquiryDaysAgo: number
  responseDelayHours: number
  tourDaysAgo: number
  signedDaysAgo: number
  weddingDaysAgo: number
} {
  const { rng, venue } = ctx
  const weddingDaysAgo = rng.int(10, 150)
  const signedDaysAgo = weddingDaysAgo + rng.int(180, 320)
  const tourDaysAgo = signedDaysAgo + rng.int(10, 30)
  const inquiryDaysAgo = tourDaysAgo + rng.int(10, 40)
  const responseDelayHours = rng.int(1, 12)
  const steps = openingSteps(ctx, inquiryDaysAgo, responseDelayHours, [
    'tour_requested',
  ])
  steps.push(
    step(
      tourDaysAgo,
      rng.int(10 * 60, 16 * 60),
      'calendly',
      'tour_attended',
      'highest',
      'inbound',
      `Toured ${venue.name}.`,
      ['tour_completed'],
    ),
    step(
      signedDaysAgo,
      rng.int(9 * 60, 20 * 60),
      'gmail',
      'reply',
      'highest',
      'inbound',
      contractBody(rng),
      ['contract_signed'],
    ),
    step(
      Math.max(0, weddingDaysAgo - rng.int(2, 12)),
      rng.int(9 * 60, 20 * 60),
      'gmail',
      'reply',
      'high',
      'inbound',
      rng.pick([
        'Thank you for the most wonderful day. The team were extraordinary.',
        'We are still coming down off it. Thank you, all of you.',
        'Photos are back and they are lovely. Thank you again.',
      ]),
      ['email_reply_received'],
    ),
  )
  return {
    steps,
    inquiryDaysAgo,
    responseDelayHours,
    tourDaysAgo,
    signedDaysAgo,
    weddingDaysAgo,
  }
}

// ---------------------------------------------------------------------------
// Heat prediction
// ---------------------------------------------------------------------------

/**
 * Predict what `wedding_heat` will read for a story, using the same
 * formula the view uses: sum of `points * 0.98 ^ days` over INBOUND
 * events only, clamped to 0..100 and rounded.
 *
 * Advisory. The view is the truth and `--verify` reads it back. Phase B
 * candidate-identity contribution is not modelled because the reseed
 * writes no `candidate_identities` rows.
 */
export function predictHeat(steps: readonly DemoSignalStep[]): number {
  let sum = 0
  for (const s of steps) {
    if (s.direction !== 'inbound') continue
    for (const evt of s.heatEvents) {
      const points = HEAT_POINTS[evt]
      if (points === undefined) continue
      const days = Math.max(0, s.daysAgo)
      sum += points * Math.pow(0.98, days)
    }
  }
  return Math.max(0, Math.min(100, Math.round(sum)))
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

interface NameSlot {
  primaryFirst: string
  partnerFirst: string
  surname: string
  /** Most couples do not share a surname before the wedding. A demo
   *  where every partner shares one reads synthetic at a glance. */
  partnerSurname: string
}

function buildNamePool(rng: Rng, size: number): NameSlot[] {
  const out: NameSlot[] = []
  const seen = new Set<string>()
  let guard = 0
  while (out.length < size && guard < size * 40) {
    guard++
    const primaryFirst = rng.pick(FIRST_NAMES)
    const partnerFirst = rng.pick(PARTNER_NAMES)
    const surname = rng.pick(SURNAMES)
    const partnerSurname = rng.chance(0.65) ? rng.pick(SURNAMES) : surname
    const key = `${primaryFirst}|${surname}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ primaryFirst, partnerFirst, surname, partnerSurname })
  }
  if (out.length < size) {
    throw new Error(
      `demo-reseed: could not build ${size} distinct names from the roster. ` +
        `Add entries to FIRST_NAMES / SURNAMES in roster.ts.`,
    )
  }
  return out
}

function venueShares(coupleCount: number): Array<{ venue: DemoVenue; count: number }> {
  const totalWeight = DEMO_VENUES.reduce((sum, v) => sum + v.weight, 0)
  return DEMO_VENUES.map((venue) => ({
    venue,
    count: Math.max(1, Math.round((venue.weight / totalWeight) * coupleCount)),
  }))
}

export function generateDemoDataset(options: GenerateOptions = {}): DemoDataset {
  const seed = options.seed ?? DEFAULT_SEED
  const today = options.today ?? SEED_TODAY
  const coupleCount = options.coupleCount ?? DEFAULT_COUPLE_COUNT
  const rng = makeRng(seed)

  const shares = venueShares(coupleCount)
  const total = shares.reduce((sum, s) => sum + s.count, 0)
  const names = buildNamePool(rng, total)

  const stories: DemoCoupleStory[] = []
  let nameIndex = 0

  for (const { venue, count } of shares) {
    for (let i = 0; i < count; i++) {
      const isHero = venue.id === HERO_VENUE_ID && i === 0
      const slot = names[nameIndex++]

      // The hero keeps the names the couple-portal seed rows and the
      // marketing copy already use. Everyone else is generated.
      const primaryName = isHero ? HERO_PRIMARY_NAME : `${slot.primaryFirst} ${slot.surname}`
      const partnerName = isHero
        ? HERO_PARTNER_NAME
        : `${slot.partnerFirst} ${slot.partnerSurname}`

      const domain = rng.pick(FICTIONAL_EMAIL_DOMAINS)
      const primaryEmail = isHero
        ? HERO_PRIMARY_EMAIL
        : `${slugify(slot.primaryFirst)}.${slugify(slot.surname)}@${domain}`
      const partnerEmail = isHero
        ? HERO_PARTNER_EMAIL
        : rng.chance(0.55)
          ? `${slugify(slot.partnerFirst)}.${slugify(slot.partnerSurname)}@${domain}`
          : null
      assertFictionalEmail(primaryEmail)
      if (partnerEmail) assertFictionalEmail(partnerEmail)

      // 555-01xx is the reserved-for-fiction block.
      const primaryPhone = `540-555-0${String(100 + (nameIndex % 900)).padStart(3, '0')}`

      // About half the roster has a handle. Normalised the way
      // `normalizeHandle` does it: lower case, no @, no URL.
      const instagramHandle = rng.chance(0.5)
        ? `${slugify(slot.primaryFirst)}.${slugify(slot.partnerFirst)}`
        : null

      const lifecycle: DemoLifecycle = isHero
        ? 'booked'
        : weightedPick(rng, LIFECYCLE_WEIGHTS)
      const originChannel = weightedPick(rng, CHANNEL_WEIGHTS)
      const guestCount = rng.int(2, 5) * 25 + rng.int(0, 20)

      const ctx: TimelineContext = { rng, venue, originChannel, guestCount }

      let steps: DemoSignalStep[]
      let inquiryDaysAgo: number
      let responseDelayHours: number
      let tourDaysAgo: number | null = null
      let tourOutcome: DemoCoupleStory['tourOutcome'] = null
      let weddingDateOffsetDays: number | null = null
      let bookingValue: number | null = null
      let lostReason: string | null = null
      let lostStage: DemoCoupleStory['lostStage'] = null

      if (lifecycle === 'inquiry') {
        const built = buildInquiry(ctx)
        steps = built.steps
        inquiryDaysAgo = built.inquiryDaysAgo
        responseDelayHours = built.responseDelayHours
        if (rng.chance(0.6)) weddingDateOffsetDays = -rng.int(120, 640)
      } else if (lifecycle === 'tour_booked') {
        const built = buildTourBooked(ctx)
        steps = built.steps
        inquiryDaysAgo = built.inquiryDaysAgo
        responseDelayHours = built.responseDelayHours
        tourDaysAgo = built.tourDaysAgo
        weddingDateOffsetDays = -rng.int(150, 600)
      } else if (lifecycle === 'toured') {
        const built = buildToured(ctx)
        steps = built.steps
        inquiryDaysAgo = built.inquiryDaysAgo
        responseDelayHours = built.responseDelayHours
        tourDaysAgo = built.tourDaysAgo
        tourOutcome = 'completed'
        weddingDateOffsetDays = -rng.int(120, 560)
      } else if (lifecycle === 'booked') {
        const built = buildBooked(ctx)
        steps = built.steps
        inquiryDaysAgo = built.inquiryDaysAgo
        responseDelayHours = built.responseDelayHours
        tourDaysAgo = built.tourDaysAgo
        tourOutcome = 'completed'
        weddingDateOffsetDays = -rng.int(45, 520)
        bookingValue = venue.basePrice + rng.int(0, 24) * 250
      } else if (lifecycle === 'lost') {
        const built = buildLost(ctx)
        steps = built.steps
        inquiryDaysAgo = built.inquiryDaysAgo
        responseDelayHours = built.responseDelayHours
        tourDaysAgo = built.tourDaysAgo
        tourOutcome = built.tourDaysAgo === null ? null : 'completed'
        lostReason = rng.pick(LOST_REASONS)
        lostStage = built.tourDaysAgo === null ? 'inquiry' : rng.pick(LOST_STAGES.slice(1))
        if (rng.chance(0.7)) weddingDateOffsetDays = -rng.int(30, 400)
      } else {
        const built = buildCompleted(ctx)
        steps = built.steps
        inquiryDaysAgo = built.inquiryDaysAgo
        responseDelayHours = built.responseDelayHours
        tourDaysAgo = built.tourDaysAgo
        tourOutcome = 'completed'
        weddingDateOffsetDays = built.weddingDaysAgo
        bookingValue = venue.basePrice + rng.int(0, 20) * 250
      }

      // A text, once the coordinator has replied and the couple has a
      // number to text. Two in five stories, which is roughly what a
      // venue's own inbox looks like. `sms_inbound` is the action type
      // the live Twilio and OpenPhone builders emit, so this lands as an
      // `inbound_sms` progression event exactly as a real one would.
      if (rng.chance(0.4)) {
        const smsDaysAgo = Math.max(0, inquiryDaysAgo - rng.int(1, 8))
        steps.push(
          step(
            smsDaysAgo,
            rng.int(8 * 60, 21 * 60),
            'sms',
            'sms_inbound',
            'high',
            'inbound',
            smsBody(rng),
            ['email_reply_received'],
          ),
        )
      }

      // A handful of tours fall over. Real venues have no-shows.
      if (tourOutcome === 'completed' && lifecycle !== 'booked' && lifecycle !== 'completed') {
        if (rng.chance(0.12)) tourOutcome = 'no_show'
      }

      const key = isHero
        ? 'hero-chloe-ryan'
        : `${venue.slug}-${slugify(slot.primaryFirst)}-${slugify(slot.surname)}`

      // The opening inquiry must be the oldest step in the story. The
      // builders derive tour and contract offsets from each other, and a
      // couple of the random ranges can overlap far enough to put a tour
      // booking a day BEFORE the inquiry that led to it. Clamp rather
      // than narrow the ranges: the ranges are what make the funnel look
      // plausible, and a story whose first signal is not the inquiry
      // reads wrong on the couple timeline.
      const openingDaysAgo = steps[0].daysAgo
      const orderedSteps = steps.map((s, index) =>
        index > 0 && s.daysAgo > openingDaysAgo
          ? { ...s, daysAgo: Math.max(0, openingDaysAgo - 1) }
          : s,
      )

      const expectedHeat = predictHeat(orderedSteps)
      const expectedTier: DemoTier = tierForScore(expectedHeat)

      const weddingSource: DemoWeddingSource = SOURCE_FOR_CHANNEL[originChannel] ?? 'other'

      stories.push({
        key,
        venueId: venue.id,
        primaryName,
        partnerName,
        primaryEmail,
        partnerEmail,
        primaryPhone,
        instagramHandle,
        lifecycle,
        weddingSource,
        guestCount,
        bookingValue,
        inquiryDaysAgo,
        responseDelayHours,
        weddingDateOffsetDays,
        tourDaysAgo,
        tourOutcome,
        lostReason,
        lostStage,
        steps: orderedSteps.slice().sort((a, b) => b.daysAgo - a.daysAgo),
        hero: isHero,
        pinnedWeddingId: isHero ? HERO_WEDDING_ID : null,
        expectedHeat,
        expectedTier,
      })
    }
  }

  return {
    seed,
    today,
    venueIds: DEMO_VENUES.map((v) => v.id),
    stories,
  }
}
