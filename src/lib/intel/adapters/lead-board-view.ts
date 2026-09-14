/**
 * Lead board adapter — spine rows in, renderable cards out.
 *
 * `src/lib/intel/readers/lead-board.ts` fetches. This file decides what
 * the numbers mean, and it is pure, so the decisions are testable without
 * a database. Nothing here queries, nothing here writes.
 *
 * The three jobs:
 *
 *  1. ONE STAGE PER COUPLE. Every card's stage comes from
 *     `deriveOperatorStage` (W37) and nothing else, so /agent/leads,
 *     /agent/pipeline, the couples list and the couple page cannot say
 *     four different words about one couple. When the mirrored wedding
 *     has no machine stage on file, `machineStageFromProgression` builds
 *     one out of the inbound anchors the spine does carry, so a couple
 *     the state machine has never touched still lands somewhere it
 *     earned rather than defaulting to "new enquiry".
 *
 *  2. THE BOARD COLUMNS. Thirteen, from `OPERATOR_STAGE_ORDER` in
 *     client-terms. The pipeline used to declare its own seven-label
 *     list; that was the page-local vocabulary W37 set out to delete.
 *
 *  3. THE LEGACY BRIDGE. `LEGACY_STATUS_TO_OPERATOR_STAGE` records where
 *     each old `weddings.status` value lands in the new vocabulary. It is
 *     not used to render anything. It exists so the fixture test can ask
 *     the only question that matters about this change: for the same
 *     couple, does the spine put the card in the column the old query
 *     put it in?
 *
 * Unit-tested in ./__tests__/lead-board-view.test.ts.
 */

import {
  deriveOperatorStage,
  type OperatorStage,
  type OperatorStageResult,
} from '@/lib/services/lifecycle/vocabulary'
import type { LifecycleStage } from '@/lib/services/lifecycle/state-machine'
import { OPERATOR_STAGE_ORDER, operatorStageLabel } from '@/lib/copy/client-terms'
import type { HeatBucket } from '@/lib/services/identity/heat-score'
import type { HeatTier } from '@/lib/heat/tier-colors'
import type {
  ImportWarning,
  LeadBoardRow,
  ProgressionAnchors,
} from '@/lib/intel/readers/lead-board'
import { withLastActivity } from '@/lib/intel/adapters/lead-list-view'

// ---------------------------------------------------------------------------
// 1. The stage
// ---------------------------------------------------------------------------

/**
 * A machine stage built from the spine's own inbound anchors, for a
 * couple whose mirrored wedding has no `lifecycle_stage` on file (or has
 * no mirrored wedding at all — a fragment-promoted couple never had one).
 *
 * Deliberately conservative. Only four of the thirteen stages can be
 * earned this way, because `couple_progression_events` is inbound-only by
 * doctrine (§3 "Don't skip" #1): a proposal going out leaves no trace on
 * the spine, so `proposal_active` is NOT derivable here and a couple with
 * a proposal out reads as `nurture` until the machine says otherwise.
 * That understatement is the point — the alternative is a card claiming a
 * proposal nobody can evidence.
 *
 * Returns null when the couple has no inbound anchors at all, which lets
 * `deriveOperatorStage` fall through to the spine state speaking alone.
 */
export function machineStageFromProgression(
  progression: ProgressionAnchors,
  opts: { touchpointCount: number } = { touchpointCount: 0 },
): LifecycleStage | null {
  if (progression.contractSignedAt) return 'booked'
  if (progression.tourAttendedAt) return 'tour_completed'
  if (progression.tourBookedAt) return 'tour_scheduled'
  if (progression.count > 0) {
    // More than one inbound and they are in a conversation; a single
    // first contact is still a first touch.
    return progression.count > 1 ? 'nurture' : 'first_touch'
  }
  if (opts.touchpointCount > 0) return 'first_touch'
  return null
}

// ---------------------------------------------------------------------------
// 2. Heat
// ---------------------------------------------------------------------------

/**
 * The canonical heat buckets, hottest first. Four, from `heatBucket()` in
 * heat-score.ts — the spine's scale. The legacy `wedding_heat` view had
 * five (hot / warm / cool / cold / frozen) on a clamped 0-100 scale; the
 * spine's is an unbounded decayed sum with an `on_fire` top bucket and no
 * separate cold and frozen floors. A surface renders these words and no
 * others, so the filter row and the badge cannot drift apart again.
 */
export const HEAT_BUCKETS: ReadonlyArray<HeatBucket> = [
  'on_fire',
  'hot',
  'warm',
  'cool',
]

/** The bucket names are also the tier-colour keys, so the shared
 *  HeatBadge renders a canonical bucket with no translation table in
 *  between. Kept as a function rather than an identity cast so a future
 *  divergence has one place to land. */
export function heatBucketTier(bucket: HeatBucket): HeatTier {
  return bucket as HeatTier
}

// ---------------------------------------------------------------------------
// 3. The card
// ---------------------------------------------------------------------------

export interface LeadCard {
  /** Spine id. The couple, not the wedding. */
  coupleId: string
  /** Mirror id, for the existing /intel/clients/[id] route and for a
   *  stage write. Null for a couple with no mirrored wedding — those
   *  cards are read-only, and the surfaces say so. */
  weddingId: string | null
  venueId: string
  venueName: string | null
  names: string
  stage: OperatorStageResult
  /** Null when the touchpoint read failed: unknown, never zero. */
  heatScore: number | null
  heatBucket: HeatBucket | null
  heatLabel: string | null
  /** The evidence lines behind the score, for a tooltip or a why-card. */
  heatWhy: string | null
  firstSeenAt: string | null
  lastActivityAt: string | null
  lastChannel: string | null
  /** The channel the couple first arrived on. Replaces the hand-set
   *  `weddings.source` column. */
  sourceChannel: string | null
  weddingDate: string | null
  /** Whole days since the stage last moved, from
   *  `weddings.lifecycle_stage_set_at`. Null when the stage has never
   *  moved — better an absent figure than "0 days in stage" on a row a
   *  bulk import touched this morning. */
  daysInStage: number | null
  /** Whole days since the earliest signal. Replaces "days since
   *  inquiry", which counted from a hand-set date. */
  daysSinceFirstSeen: number | null
  touchpointCount: number
  clientCode: string | null
  codeExtension: string | null
  confidenceFlag: string | null
  importWarnings: ImportWarning[] | null
  guestCountEstimate: number | null
}

const DAY_MS = 86_400_000

function wholeDaysSince(iso: string | null, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now - t) / DAY_MS))
}

/** One spine row, as a card. Pure; `now` is passed so two cards in one
 *  render cannot be derived against two different clocks. */
export function toLeadCard(row: LeadBoardRow, now: number): LeadCard {
  const machineStage =
    row.machineStage ??
    machineStageFromProgression(row.progression, {
      touchpointCount: row.touchpointCount,
    })

  const stage = deriveOperatorStage({
    spineState: row.lifecycleState,
    machineStage,
    hasBooking: row.hasBooking,
    weddingDate: row.weddingDate,
    lastInboundAt: row.lastProgressionAt ?? row.progression.lastEventAt,
    today: now,
  })

  return {
    coupleId: row.coupleId,
    weddingId: row.weddingId,
    venueId: row.venueId,
    venueName: row.venueName,
    names: row.names ?? 'Unknown',
    stage,
    heatScore: row.heat ? row.heat.displayScore : null,
    heatBucket: row.heat ? row.heat.bucket : null,
    heatLabel: row.heat ? row.heat.label : null,
    heatWhy: row.heat ? row.heat.reasoning : null,
    firstSeenAt: row.firstSeenAt,
    lastActivityAt: row.lastSignal?.at ?? null,
    lastChannel: row.lastSignal?.channel ?? null,
    sourceChannel: row.firstChannel,
    weddingDate: row.weddingDate,
    daysInStage: wholeDaysSince(row.machineStageSetAt, now),
    daysSinceFirstSeen: wholeDaysSince(row.firstSeenAt, now),
    touchpointCount: row.touchpointCount,
    clientCode: row.clientCode,
    codeExtension: row.codeExtension,
    confidenceFlag: row.confidenceFlag,
    importWarnings: row.importWarnings,
    guestCountEstimate: row.guestCountEstimate,
  }
}

export function toLeadCards(rows: readonly LeadBoardRow[], now: number): LeadCard[] {
  return rows.map((r) => toLeadCard(r, now))
}

// ---------------------------------------------------------------------------
// 4. The board
// ---------------------------------------------------------------------------

export interface BoardColumn {
  key: OperatorStage
  label: string
  cards: LeadCard[]
  /** False for the two columns that are identity facts rather than
   *  places in a sale. You cannot drag a couple into "not a couple" —
   *  that is decided by the record, and a drag would be asserting
   *  something the operator has no way to evidence here. */
  droppable: boolean
}

/** The thirteen columns, in the one order defined in client-terms. */
export const BOARD_STAGES: ReadonlyArray<OperatorStage> = OPERATOR_STAGE_ORDER

/** The two stages that describe what a record IS, not where a sale is. */
const RECORD_FACT_STAGES: ReadonlySet<OperatorStage> = new Set([
  'not_a_couple',
  'joined_up',
])

export function isDroppableStage(stage: OperatorStage): boolean {
  return !RECORD_FACT_STAGES.has(stage)
}

export function buildBoardColumns(cards: readonly LeadCard[]): BoardColumn[] {
  return BOARD_STAGES.map((key) => ({
    key,
    label: operatorStageLabel(key),
    cards: cards.filter((c) => c.stage.stage === key),
    droppable: isDroppableStage(key),
  }))
}

// ---------------------------------------------------------------------------
// 5. The lead list
// ---------------------------------------------------------------------------

/**
 * Which stages /agent/leads shows. The old query was
 * `status IN (inquiry, tour_scheduled, tour_completed, proposal_sent)` —
 * "people I might still win". These five are the same idea said in the
 * new words: everything before a signature and after nothing.
 */
export const LEAD_LIST_STAGES: ReadonlyArray<OperatorStage> = [
  'new_enquiry',
  'in_conversation',
  'tour_booked',
  'toured',
  'proposal_out',
]

const LEAD_LIST_SET = new Set<OperatorStage>(LEAD_LIST_STAGES)

export function isLeadListStage(stage: OperatorStage): boolean {
  return LEAD_LIST_SET.has(stage)
}

export function selectLeadList(cards: readonly LeadCard[]): LeadCard[] {
  return cards.filter((c) => isLeadListStage(c.stage.stage))
}

export type LeadSortField = 'heat' | 'first_seen' | 'last_activity'
export type SortDirection = 'asc' | 'desc'

export interface LeadFilter {
  /** Null means every bucket. */
  bucket?: HeatBucket | null
  /** Matched against the couple's names and their arrival channel. */
  query?: string
}

export function filterLeadCards(
  cards: readonly LeadCard[],
  filter: LeadFilter,
): LeadCard[] {
  let out = [...cards]
  if (filter.bucket) {
    // A card with unknown heat is not in any bucket. Dropping it from a
    // bucket filter is honest; counting it as 'cool' would not be.
    out = out.filter((c) => c.heatBucket === filter.bucket)
  }
  const q = filter.query?.trim().toLowerCase()
  if (q) {
    out = out.filter(
      (c) =>
        c.names.toLowerCase().includes(q) ||
        (c.sourceChannel?.toLowerCase().includes(q) ?? false),
    )
  }
  return out
}

function sortKey(card: LeadCard, field: LeadSortField): number {
  switch (field) {
    case 'heat':
      // Unknown heat sorts below a known zero. A cold couple is a fact;
      // an unreadable one is not, and it should not outrank facts.
      return card.heatScore ?? -1
    case 'first_seen':
      return card.firstSeenAt ? Date.parse(card.firstSeenAt) : 0
    case 'last_activity':
      return card.lastActivityAt ? Date.parse(card.lastActivityAt) : 0
  }
}

export function sortLeadCards(
  cards: readonly LeadCard[],
  field: LeadSortField,
  direction: SortDirection,
): LeadCard[] {
  const out = [...cards]
  out.sort((a, b) => {
    const av = sortKey(a, field)
    const bv = sortKey(b, field)
    return direction === 'desc' ? bv - av : av - bv
  })
  return out
}

/** Counts per heat bucket, plus the couples whose heat could not be read.
 *  The distribution bar renders this; `unknown` is drawn as its own
 *  segment rather than folded into the coldest bucket. */
export function heatDistribution(
  cards: readonly LeadCard[],
): Record<HeatBucket | 'unknown', number> {
  const out: Record<string, number> = { on_fire: 0, hot: 0, warm: 0, cool: 0, unknown: 0 }
  for (const c of cards) {
    if (!c.heatBucket) out.unknown += 1
    else out[c.heatBucket] += 1
  }
  return out as Record<HeatBucket | 'unknown', number>
}

// ---------------------------------------------------------------------------
// 6. The legacy bridge
// ---------------------------------------------------------------------------

/**
 * Where each old `weddings.status` value lands in the operator
 * vocabulary. Every value the two pages ever queried, plus the two they
 * filtered out, so the table is total over what the old board could hold.
 *
 * `contracted` and `booked` both land on `booked`: the old board drew
 * them as two columns, but the difference between a signed contract and a
 * booking was never a difference the data held, and `deriveOperatorStage`
 * places a booked couple on the wedding-date arc instead.
 *
 * Nothing renders from this. It is the fixture the migration is checked
 * against, and it is exported so the check lives next to the mapping.
 */
export const LEGACY_STATUS_TO_OPERATOR_STAGE: Readonly<
  Record<string, OperatorStage>
> = {
  inquiry: 'new_enquiry',
  tour_scheduled: 'tour_booked',
  tour_completed: 'toured',
  proposal_sent: 'proposal_out',
  contracted: 'booked',
  booked: 'booked',
  lost: 'gone_quiet',
  cancelled: 'cancelled',
  completed: 'wedding_done',
}

/**
 * The inverse, for a drag. An operator dropping a card into a column is
 * asserting a machine stage, which is the process the machine owns; the
 * write goes through the lifecycle override path so it carries an audit
 * trail rather than silently overwriting a column.
 *
 * `not_a_couple` and `joined_up` are absent on purpose: they are record
 * facts, and their columns are not droppable.
 */
export const OPERATOR_STAGE_TO_MACHINE_STAGE: Readonly<
  Partial<Record<OperatorStage, LifecycleStage>>
> = {
  new_enquiry: 'first_touch',
  in_conversation: 'nurture',
  tour_booked: 'tour_scheduled',
  toured: 'tour_completed',
  proposal_out: 'proposal_active',
  booked: 'booked',
  planning: 'planning_active',
  this_week: 'day_of',
  wedding_done: 'post_event',
  gone_quiet: 'lost',
  cancelled: 'cancelled',
}

/** The legacy `weddings.status` each operator stage still writes, so the
 *  surfaces that have not moved to the spine yet keep seeing operator
 *  moves. Removed when the last of them moves. */
export const OPERATOR_STAGE_TO_LEGACY_STATUS: Readonly<
  Partial<Record<OperatorStage, string>>
> = {
  new_enquiry: 'inquiry',
  in_conversation: 'inquiry',
  tour_booked: 'tour_scheduled',
  toured: 'tour_completed',
  proposal_out: 'proposal_sent',
  booked: 'booked',
  planning: 'booked',
  this_week: 'booked',
  wedding_done: 'completed',
  gone_quiet: 'lost',
  cancelled: 'cancelled',
}

export function isBoardStage(value: string): value is OperatorStage {
  return (BOARD_STAGES as ReadonlyArray<string>).includes(value)
}

// ---------------------------------------------------------------------------
// 7. The degraded path
// ---------------------------------------------------------------------------

/**
 * Fill in last-activity for cards the ribbon read could not answer for,
 * from the daily-list call both pages already make.
 *
 * Normally `lastActivityAt` comes straight off the couple's newest
 * touchpoint, which is the best answer there is. When the touchpoint read
 * fails or hits its cap, this reaches for the same fact through W40's
 * `withLastActivity` — the one merge that owns "when did this couple last
 * do anything" for a wedding-keyed row — so a degraded board still shows
 * an activity column instead of a wall of dashes.
 *
 * Never overwrites a value the ribbon supplied: the ribbon is the finer
 * read, and a coarser one must not talk over it.
 */
export function fillMissingActivity(
  cards: readonly LeadCard[],
  lastActivityByWedding: Record<string, string>,
): LeadCard[] {
  if (Object.keys(lastActivityByWedding).length === 0) return [...cards]
  const keyed = cards.map((c) => ({ ...c, id: c.weddingId ?? c.coupleId }))
  return withLastActivity(keyed, lastActivityByWedding).map((row) => {
    const { id: _ignored, last_activity_at: overlaid, ...card } = row
    void _ignored
    return {
      ...(card as LeadCard),
      lastActivityAt: card.lastActivityAt ?? overlaid,
    }
  })
}
