/**
 * One lifecycle vocabulary. Wave 5, W37.
 *
 * THE PROBLEM
 * -----------
 * There are two lifecycles in this app and neither owns the other.
 *
 *   1. `couples.lifecycle_state` (six values: channel_scoped, resolved,
 *      booked, completed, ghost, agent). It answers "what IS this record".
 *      Decay, resurrection, the mirror and the post-wedding sweep move it.
 *      A seventh case rides alongside it: a couple with `merged_into_id`
 *      set is not a couple any more, it is a pointer at one.
 *
 *   2. The thirteen-stage per-wedding machine in `state-machine.ts`
 *      (pre_touch .. cancelled, persisted as `weddings.lifecycle_stage`).
 *      It answers "where is the WORK". Tours, proposals, the wedding date
 *      and a judge move it.
 *
 * The couples list read the first, the pipeline read the second, and the
 * couple page read a bit of both. A coordinator saw three vocabularies for
 * one couple. This module writes the mapping down once so every surface
 * says the same word.
 *
 * THE RULE
 * --------
 * The spine is authoritative for identity facts. Whether a record is a
 * ghost, an agent, a finished wedding or a merged-away duplicate is a fact
 * about the record, and the machine does not get a vote.
 *
 * The machine is authoritative for the operator's process. Whether a
 * couple has a tour booked, a proposal out, is deep in planning or is
 * getting married this week is a fact about the work, and the spine is too
 * coarse to hold it.
 *
 * Where they disagree the pill shows the spine state and `because` names
 * the disagreement out loud, so a coordinator staring at "Gone quiet" on a
 * card sitting in the Tour Booked column can see why in one sentence.
 *
 * WHAT THIS IS NOT
 * ----------------
 * A read vocabulary, not a new state machine. Nothing here writes, nothing
 * here changes when either lifecycle moves, and no caller should persist a
 * derived stage. The audit in
 * `src/lib/services/identity/lifecycle-disagreements.ts` reports what this
 * derives; the fix for a real disagreement is always upstream.
 *
 * Anchors: IDENTITY-FIRST-ARCHITECTURE.md §3 (the lifecycle clock),
 * `state-machine.ts` (the thirteen stages and their fast paths),
 * `src/lib/copy/client-terms.ts` (the words).
 */

import type { LifecycleStage } from './state-machine'
import {
  agoPhrase,
  operatorStageLabel,
  OPERATOR_STAGE_ORDER,
  type OperatorStageKey,
} from '@/lib/copy/client-terms'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The six values `couples.lifecycle_state` actually holds. */
export type SpineState =
  | 'channel_scoped'
  | 'resolved'
  | 'booked'
  | 'completed'
  | 'ghost'
  | 'agent'

/**
 * What a caller passes in. `merged` is not a `lifecycle_state` value: it is
 * what a caller passes when the couple row has `merged_into_id` set, which
 * is an identity fact that outranks every other state. Pass null when the
 * record has no state on file.
 */
export type SpineStateInput = SpineState | 'merged' | null

/** The operator-facing stage. One word set, thirteen values, defined in
 *  client-terms so the words and the mapping cannot drift apart. */
export type OperatorStage = OperatorStageKey

export const ALL_OPERATOR_STAGES: ReadonlyArray<OperatorStage> = OPERATOR_STAGE_ORDER

/** How confident the pill is that the two lifecycles are telling the same
 *  story. `agreed` is the normal case. */
export type VocabularyAgreement = 'agreed' | 'disagreed' | 'one_sided'

/** Presentation tone, not a colour. The pill turns a tone into classes;
 *  keeping Tailwind out of this module lets the audit and the readers use
 *  it too. */
export type OperatorStageTone =
  | 'new'
  | 'live'
  | 'warm'
  | 'won'
  | 'done'
  | 'quiet'
  | 'off'

export interface DeriveOperatorStageInput {
  /** `couples.lifecycle_state`, or 'merged' when `merged_into_id` is set.
   *  The column is a plain text column, so a raw string is accepted and
   *  anything unrecognised reads as "no state on file" rather than
   *  throwing. */
  spineState: SpineStateInput | (string & {})
  /** `weddings.lifecycle_stage`. Null when the couple has no mirrored
   *  wedding, or when the machine has not run on it yet. */
  machineStage: LifecycleStage | null
  /** A signed contract or a booked_at on file. A booking is a fact, so a
   *  couple carrying one never reads as a new enquiry. */
  hasBooking: boolean
  /** ISO date. Used only to place a booked couple on the wedding-date arc
   *  when the machine is silent. */
  weddingDate: string | null
  /** ISO timestamp of the last inbound progression. Used only for the
   *  "last heard from them" clause of `because`. */
  lastInboundAt: string | null
  /** "Now", supplied by the caller so this function stays pure. */
  today: string | number | Date
}

export interface OperatorStageResult {
  stage: OperatorStage
  /** The words on the pill, from client-terms. */
  label: string
  /** One or two plain sentences saying why this stage and not another.
   *  Names the disagreement when there is one. Never empty. */
  because: string
  /** Whether the two lifecycles agree. `one_sided` means only one of them
   *  had anything to say. */
  agreement: VocabularyAgreement
  tone: OperatorStageTone
  /** Echoed back so a caller can log or audit without re-deriving. */
  spineState: SpineStateInput
  machineStage: LifecycleStage | null
  /** What `machineStage` projects to on the spine. Null when there is no
   *  machine stage. This is the number the audit compares. */
  projectedSpineState: SpineState | null
}

// ---------------------------------------------------------------------------
// The fixed projection: thirteen stages onto six states
// ---------------------------------------------------------------------------

/**
 * Where each machine stage lands on the spine. Fixed, total, and the same
 * every time: this is the table the reimport gets checked against.
 *
 * The reasoning, stage by stage:
 *   - pre_touch is a notional stage for a couple nobody has acknowledged,
 *     which is exactly what channel_scoped means on the spine.
 *   - first_touch through proposal_active all describe a live conversation
 *     with a known couple, which is `resolved`. The spine has no finer
 *     grain than that and should not grow one.
 *   - booked, planning_active and day_of are all after the signature, so
 *     they are `booked`. The spine does not track planning depth.
 *   - post_event and long_tail are after the day, so they are `completed`.
 *   - lost and cancelled both mean no wedding is coming. The spine has one
 *     word for that and it is `ghost`, which is also what the existing
 *     drift audit derives from a legacy status of lost or cancelled.
 */
export const MACHINE_STAGE_TO_SPINE_STATE: Readonly<
  Record<LifecycleStage, SpineState>
> = {
  pre_touch: 'channel_scoped',
  first_touch: 'resolved',
  nurture: 'resolved',
  tour_scheduled: 'resolved',
  tour_completed: 'resolved',
  proposal_active: 'resolved',
  booked: 'booked',
  planning_active: 'booked',
  day_of: 'booked',
  post_event: 'completed',
  long_tail: 'completed',
  lost: 'ghost',
  cancelled: 'ghost',
}

/** The fixed projection as a function. Total over the thirteen stages;
 *  an unknown value returns null rather than a guess. */
export function machineStageToSpineState(
  stage: LifecycleStage | null | undefined,
): SpineState | null {
  if (!stage) return null
  return MACHINE_STAGE_TO_SPINE_STATE[stage] ?? null
}

/** Every machine stage, derived from the projection table so the two
 *  cannot fall out of step. */
export const ALL_MACHINE_STAGES = Object.keys(
  MACHINE_STAGE_TO_SPINE_STATE,
) as LifecycleStage[]

/** What each machine stage is called in front of a coordinator. */
const MACHINE_STAGE_TO_OPERATOR: Readonly<Record<LifecycleStage, OperatorStage>> = {
  pre_touch: 'new_enquiry',
  first_touch: 'new_enquiry',
  nurture: 'in_conversation',
  tour_scheduled: 'tour_booked',
  tour_completed: 'toured',
  proposal_active: 'proposal_out',
  booked: 'booked',
  planning_active: 'planning',
  day_of: 'this_week',
  post_event: 'wedding_done',
  long_tail: 'wedding_done',
  lost: 'gone_quiet',
  cancelled: 'cancelled',
}

/** What each spine state is called when the machine has nothing to say.
 *  `booked` is refined by the wedding date before it reaches the pill. */
const SPINE_STATE_TO_OPERATOR: Readonly<
  Record<Exclude<SpineStateInput, null>, OperatorStage>
> = {
  channel_scoped: 'new_enquiry',
  resolved: 'in_conversation',
  booked: 'booked',
  completed: 'wedding_done',
  ghost: 'gone_quiet',
  agent: 'not_a_couple',
  merged: 'joined_up',
}

const OPERATOR_STAGE_TONE: Readonly<Record<OperatorStage, OperatorStageTone>> = {
  new_enquiry: 'new',
  in_conversation: 'live',
  tour_booked: 'warm',
  toured: 'warm',
  proposal_out: 'warm',
  booked: 'won',
  planning: 'won',
  this_week: 'won',
  wedding_done: 'done',
  gone_quiet: 'quiet',
  cancelled: 'quiet',
  not_a_couple: 'off',
  joined_up: 'off',
}

export function operatorStageTone(stage: OperatorStage): OperatorStageTone {
  return OPERATOR_STAGE_TONE[stage] ?? 'off'
}

/** The four identity facts the spine owns outright. The machine does not
 *  get to overrule any of them. */
const SPINE_OWNED: ReadonlySet<Exclude<SpineStateInput, null>> = new Set([
  'merged',
  'agent',
  'ghost',
  'completed',
])

// ---------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/** The machine's own day-of window, restated: one day before the wedding
 *  to seven days after. Kept here rather than imported so this module has
 *  no runtime dependency on the state machine. */
const DAY_OF_WINDOW = { beforeDays: 7, afterDays: 1 } as const

function toMs(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

function normaliseSpineState(raw: SpineStateInput | string | null): SpineStateInput {
  if (!raw) return null
  if (Object.prototype.hasOwnProperty.call(SPINE_STATE_TO_OPERATOR, raw)) {
    return raw as Exclude<SpineStateInput, null>
  }
  return null
}

/**
 * Place a booked couple on the wedding-date arc when the machine is silent.
 * Deliberately conservative: with no date on file a booked couple reads as
 * booked, never as planning, because planning depth is evidence this
 * function does not have.
 */
function bookedStageFromDate(
  weddingDate: string | null,
  nowMs: number,
): { stage: OperatorStage; note: string } {
  const eventMs = toMs(weddingDate)
  if (eventMs === null) {
    return { stage: 'booked', note: 'No wedding date on file yet.' }
  }
  const daysUntil = Math.floor((eventMs - nowMs) / DAY_MS)
  if (daysUntil < -DAY_OF_WINDOW.afterDays) {
    return { stage: 'wedding_done', note: 'The wedding date has passed.' }
  }
  if (daysUntil <= DAY_OF_WINDOW.beforeDays) {
    return { stage: 'this_week', note: 'The wedding is within the week.' }
  }
  return { stage: 'booked', note: `The wedding is ${daysUntil} days out.` }
}

function spineSentence(state: Exclude<SpineStateInput, null>): string {
  switch (state) {
    case 'merged':
      return 'This record was joined up with another couple, so their history lives there.'
    case 'agent':
      return 'Marked as not a couple, so they sit outside your funnel.'
    case 'ghost':
      return 'They went quiet: nothing came back from them for long enough that the record stopped counting them as live.'
    case 'completed':
      return 'Their wedding is recorded as done.'
    case 'booked':
      return 'They have booked.'
    case 'resolved':
      return 'You are in conversation with them.'
    case 'channel_scoped':
      return 'A new enquiry nobody has picked up yet.'
  }
}

function machineWords(stage: LifecycleStage): string {
  return operatorStageLabel(MACHINE_STAGE_TO_OPERATOR[stage]).toLowerCase()
}

/** "Last heard from them 3 days ago." Empty when there is nothing on file,
 *  because a missing date should drop the clause rather than print a
 *  guess. */
function lastHeardClause(lastInboundAt: string | null, nowMs: number): string {
  const ago = agoPhrase(lastInboundAt, nowMs)
  return ago ? ` Last heard from them ${ago}.` : ''
}

function join(...parts: Array<string | null | undefined>): string {
  return parts.filter((p) => Boolean(p && p.trim())).join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * One operator-facing stage for one couple, plus the sentence that says
 * why. Pure: every input is passed in, including "now".
 *
 * Order of decision:
 *   1. the four identity facts the spine owns (merged, not a couple,
 *      gone quiet, wedding done) win outright;
 *   2. a booking on file puts the couple on the booked arc, refined by the
 *      machine where the machine has something post-signature to say;
 *   3. otherwise the machine drives, because the rest of the thirteen
 *      stages are all process;
 *   4. with no machine stage, the spine state speaks alone.
 */
export function deriveOperatorStage(
  input: DeriveOperatorStageInput,
): OperatorStageResult {
  const spineState = normaliseSpineState(input.spineState)
  const machineStage = input.machineStage ?? null
  const nowMs = toMs(input.today) ?? 0
  const projectedSpineState = machineStageToSpineState(machineStage)
  const machineOperator = machineStage ? MACHINE_STAGE_TO_OPERATOR[machineStage] : null
  const heard = lastHeardClause(input.lastInboundAt, nowMs)

  const finish = (
    stage: OperatorStage,
    because: string,
    agreement: VocabularyAgreement,
  ): OperatorStageResult => ({
    stage,
    label: operatorStageLabel(stage),
    because: because || 'Nothing on file says where they are yet.',
    agreement,
    tone: operatorStageTone(stage),
    spineState,
    machineStage,
    projectedSpineState,
  })

  // ---- 1. Identity facts the spine owns -----------------------------------
  if (spineState && SPINE_OWNED.has(spineState)) {
    const stage = SPINE_STATE_TO_OPERATOR[spineState]
    const disagrees = machineOperator !== null && machineOperator !== stage
    const because = join(
      spineSentence(spineState),
      disagrees && machineStage
        ? `Your pipeline still has them at ${machineWords(machineStage)}; the record wins on what they are.`
        : null,
      spineState === 'ghost' ? heard : null,
    )
    return finish(
      stage,
      because,
      disagrees ? 'disagreed' : machineOperator ? 'agreed' : 'one_sided',
    )
  }

  // ---- 2. A booking is a fact ---------------------------------------------
  const booked = spineState === 'booked' || input.hasBooking === true
  if (booked) {
    // Cancelled is the one machine stage that overturns a booking, because
    // it is the machine saying the booking ended, not that it never was.
    if (machineStage === 'cancelled') {
      return finish(
        'cancelled',
        join(
          'They booked and then cancelled.',
          spineState === 'booked'
            ? 'The record still reads as booked, so the cancellation has not been swept through yet.'
            : null,
        ),
        spineState === 'booked' ? 'disagreed' : 'agreed',
      )
    }
    // Post-signature stages: the machine refines where inside the booked
    // arc they sit, which is exactly the process it owns.
    if (
      machineStage === 'booked' ||
      machineStage === 'planning_active' ||
      machineStage === 'day_of' ||
      machineStage === 'post_event' ||
      machineStage === 'long_tail'
    ) {
      const stage = MACHINE_STAGE_TO_OPERATOR[machineStage]
      return finish(
        stage,
        join(
          'They have booked.',
          `Your pipeline has them at ${machineWords(machineStage)}.`,
        ),
        'agreed',
      )
    }
    // Machine silent, or still pointing at something pre-signature. The
    // booking is the stronger fact; the wedding date places them.
    const placed = bookedStageFromDate(input.weddingDate, nowMs)
    const contradiction = !machineStage
      ? null
      : machineStage === 'lost'
        ? 'Your pipeline has them as lost, which does not square with a booking on file.'
        : `Your pipeline still has them at ${machineWords(machineStage)}, which is behind the booking.`
    return finish(
      placed.stage,
      join(
        input.hasBooking && spineState !== 'booked'
          ? 'There is a signed booking on file.'
          : 'They have booked.',
        placed.note,
        contradiction,
      ),
      contradiction ? 'disagreed' : machineOperator ? 'agreed' : 'one_sided',
    )
  }

  // ---- 3. The machine drives the process ----------------------------------
  if (machineStage && machineOperator) {
    const disagrees =
      spineState !== null && projectedSpineState !== null && projectedSpineState !== spineState
    const because = join(
      `Your pipeline has them at ${machineWords(machineStage)}.`,
      disagrees && spineState
        ? `The record reads as ${operatorStageLabel(SPINE_STATE_TO_OPERATOR[spineState]).toLowerCase()}, which is a step apart.`
        : null,
      heard,
    )
    return finish(
      machineOperator,
      because,
      disagrees ? 'disagreed' : spineState ? 'agreed' : 'one_sided',
    )
  }

  // ---- 4. The spine speaks alone ------------------------------------------
  if (spineState) {
    return finish(
      SPINE_STATE_TO_OPERATOR[spineState],
      join(spineSentence(spineState), heard),
      'one_sided',
    )
  }

  return finish(
    'new_enquiry',
    join('Nothing on file says where they are yet.', heard),
    'one_sided',
  )
}
