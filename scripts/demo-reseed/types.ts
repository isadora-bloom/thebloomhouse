/**
 * demo-reseed — shared types.
 *
 * NOVEMBER-PLAN.md wave 2, workstream W19. The design this implements is
 * DEMO-RESEED-DESIGN.md (written for week 6, pulled forward into wave 2).
 *
 * The whole point of this module tree is that the story data is expressed
 * in offsets from a live clock, never in calendar dates. Heat is a derived
 * view (`wedding_heat`, migrations 316 + 321) that sums
 * `points * 0.98 ^ days_since_event` over inbound `engagement_events`. A
 * seed with fixed March-to-May dates therefore reads Frozen from June
 * onwards, which is exactly finding 5 of the 2026-09-08 walk. Offsets fix
 * that: run the reseed today and the demo looks like today; run it in
 * March and it looks like March.
 */

import type { NormalizedSignal } from '../../src/lib/services/identity/sources/types'

/** Channels the reseed emits. Every one has a live `NormalizedSignal`
 *  producer in the repo, so nothing here invents a channel taxonomy. */
export type DemoChannel =
  | 'gmail'
  | 'knot'
  | 'weddingwire'
  | 'instagram'
  | 'website'
  | 'calendly'
  // Never an origin either. A couple texts once the coordinator has
  // given them a number, which means after the first email. Present so
  // the multi-channel ribbon has more than email on it, and so the
  // `inbound_sms` progression event exists in the demo at all.
  | 'sms'
  // Never an origin. A booked story ends with the contract landing here,
  // because `contract_signed` is the progression event the spine writes
  // for channel='honeybook' and nothing else (progression.ts) — without
  // it the demo has booked couples and no record of when they signed,
  // and anything measuring how long a couple took to decide reads empty.
  | 'honeybook'

/** Where the story ends up. Maps onto `weddings.status` (the CHECK list
 *  in migration 001) via `WEDDING_STATUS_FOR_LIFECYCLE` in generate.ts. */
export type DemoLifecycle =
  | 'inquiry'
  | 'tour_booked'
  | 'toured'
  | 'booked'
  | 'lost'
  | 'completed'

export type DemoTier = 'hot' | 'warm' | 'cool' | 'cold' | 'frozen'

/** `weddings.source` CHECK values from migration 001. */
export type DemoWeddingSource =
  | 'the_knot'
  | 'weddingwire'
  | 'google'
  | 'instagram'
  | 'referral'
  | 'website'
  | 'walk_in'
  | 'other'

/** One observable signal in a couple's journey. */
export interface DemoSignalStep {
  /** Offset from `today`, in days. Never a calendar date. Larger = older. */
  daysAgo: number
  /** Minutes past midnight UTC, so replays land at plausible times of day
   *  rather than all at the same instant. */
  minuteOfDay: number
  channel: DemoChannel
  actionType: string
  signalTier: NormalizedSignal['signal_tier']
  /** Inbound = the couple did something. Outbound = the venue did.
   *  Only inbound steps move heat (`wedding_heat` filters on direction). */
  direction: 'inbound' | 'outbound'
  /** Short, human, venue-flavoured. Lands in the touchpoint raw_payload. */
  bodyText: string
  /** Heat event types this step fires, in `engagement_events.event_type`
   *  terms. Empty for steps that should not move the needle. */
  heatEvents: string[]
}

/** One synthetic couple, start to finish. */
export interface DemoCoupleStory {
  /** Stable slug, deterministic from the seed. Also the external_id
   *  prefix, which is what makes a re-run a no-op on `touchpoints`. */
  key: string
  venueId: string
  primaryName: string
  partnerName: string | null
  /** RFC 2606 reserved domain. Never a deliverable address. */
  primaryEmail: string
  partnerEmail: string | null
  primaryPhone: string
  /** Instagram handle, already normalised (lower case, no @). Null for
   *  the couples who never turned up on social. Carried onto the signal
   *  so `linkSignal` writes `couples.handles` the way live ingestion
   *  does, rather than the reseed writing that column itself. */
  instagramHandle: string | null
  lifecycle: DemoLifecycle
  weddingSource: DemoWeddingSource
  guestCount: number
  /** Null for anything that never got as far as a number. */
  bookingValue: number | null
  inquiryDaysAgo: number
  /** Hours between the inquiry and the venue's first reply. */
  responseDelayHours: number
  /** Negative = in the future (most booked weddings). Null = never set. */
  weddingDateOffsetDays: number | null
  tourDaysAgo: number | null
  tourOutcome: 'completed' | 'cancelled' | 'no_show' | null
  lostReason: string | null
  lostStage: 'inquiry' | 'tour' | 'hold' | 'contract' | null
  steps: DemoSignalStep[]
  /** The couple-portal hero. Its `weddings.id` is pinned and its portal
   *  rows (checklist, guests, timeline) are never deleted. */
  hero: boolean
  pinnedWeddingId: string | null
  /** What the heat view should read right after a run, computed from the
   *  same 0.98^days formula the view uses. Advisory: the view is the
   *  truth, and `--verify` reads it back. */
  expectedHeat: number
  expectedTier: DemoTier
}

export interface DemoDataset {
  seed: number
  /** ISO instant the offsets are measured from. */
  today: string
  venueIds: string[]
  stories: DemoCoupleStory[]
}

// ---------------------------------------------------------------------------
// Plan shapes — what the applier would do, computed without touching a
// database so a test can assert on it.
// ---------------------------------------------------------------------------

export interface DeleteOp {
  table: string
  /** Always venue-scoped. There is no unscoped delete in this script. */
  venueIds: string[]
  /** Rows to spare, by primary key. Only used for the hero wedding. */
  keepIds?: string[]
  /** Rows to spare, by `wedding_id`. Only used for the hero's people. */
  keepWeddingIds?: string[]
  why: string
}

export type ReseedStepKind =
  | 'mint_wedding'
  | 'mirror_couple'
  | 'link_signal'
  | 'heat_events'
  | 'wedding_state'
  | 'tour_row'
  | 'lost_deal_row'
  | 'hero_contact_sync'
  // Plain mirror rows on a table the spine does not own: a guest list, a
  // budget, a contract, a planning note. Never `couples`, `touchpoints`,
  // `people` or `weddings` — those four have exactly one writer each and
  // the applier refuses any aux step naming them.
  | 'aux_rows'

export interface ReseedStep {
  kind: ReseedStepKind
  storyKey: string
  venueId: string
  /** Sort key. Global replay order is oldest first, which matters because
   *  linkSignal mints on the first signal and matches every later one. */
  occurredAt: string
  /** Present on `link_signal` steps. */
  signal?: NormalizedSignal
  /** Present on `heat_events` steps. */
  heatEvents?: string[]
  heatDirection?: 'inbound' | 'outbound'
  /** Present on `wedding_state` steps. */
  weddingPatch?: Record<string, unknown>
  /** Present on `tour_row` / `lost_deal_row` / `hero_contact_sync` steps. */
  row?: Record<string, unknown>
  /** Present on `aux_rows` steps: the table the rows go to. */
  table?: string
  /** Present on `aux_rows` steps. Rows carrying `<wedding:key>` or
   *  `<couple:key>` placeholders have them substituted at apply time for
   *  the ids the run actually minted. */
  rows?: Array<Record<string, unknown>>
}

export interface ReseedPlan {
  seed: number
  today: string
  venueIds: string[]
  /** Wedding ids the delete phase must not touch. */
  preserveWeddingIds: string[]
  deletes: DeleteOp[]
  /** Every step, oldest first. */
  steps: ReseedStep[]
  summary: {
    stories: number
    signals: number
    heatEvents: number
    /** Mirror rows across every `aux_rows` step. */
    auxRows: number
    byVenue: Record<string, number>
    byLifecycle: Record<DemoLifecycle, number>
    byExpectedTier: Record<DemoTier, number>
  }
}
