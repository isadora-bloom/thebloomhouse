/**
 * Moving a card on the pipeline board.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * The board used to write `weddings.status` from the browser, with the
 * coordinator's own key, and nothing else: no audit row, no machine
 * stage, no record of who moved it. That worked while the columns WERE
 * `weddings.status`. They are not any more — the columns are the operator
 * stages derived by `deriveOperatorStage`, which reads the thirteen-stage
 * machine and the couple's record together. A write that only touched
 * `status` would put the card back where it started on the next load.
 *
 * So a drop now asserts the machine stage, the same way
 * /api/admin/lifecycle/wedding/[weddingId]/override does, and writes the
 * legacy `status` alongside it so the surfaces that have not moved to the
 * spine yet still see the move. Two columns, one audited transition.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not touch the spine. `couples.lifecycle_state` is moved by the
 * decay sweep, the mirror and `linkSignal`, and a coordinator dragging a
 * card is not any of those. If the record and the board disagree after
 * this write, the pill says so out loud, which is the designed outcome
 * rather than a bug to paper over.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  OPERATOR_STAGE_TO_MACHINE_STAGE,
  OPERATOR_STAGE_TO_LEGACY_STATUS,
  isBoardStage,
  isDroppableStage,
} from '@/lib/intel/adapters/lead-board-view'
import type { LifecycleStage } from '@/lib/services/lifecycle/state-machine'

export interface SetBoardStageInput {
  venueId: string
  weddingId: string
  /** An `OperatorStage` key. Validated here, not trusted. */
  stage: string
  actorId: string | null
  note?: string | null
}

export type SetBoardStageResult =
  | {
      ok: true
      from: LifecycleStage | null
      to: LifecycleStage
      legacyStatus: string | null
      transitionId: string | null
    }
  | { ok: false; error: string; status: number }

export async function setBoardStage(
  supabase: SupabaseClient,
  input: SetBoardStageInput,
): Promise<SetBoardStageResult> {
  if (!input.weddingId || !input.venueId) {
    return { ok: false, error: 'wedding and venue required', status: 400 }
  }
  if (!isBoardStage(input.stage)) {
    return { ok: false, error: 'unknown_stage', status: 400 }
  }
  if (!isDroppableStage(input.stage)) {
    // "Not a couple" and "Joined up" describe what a record IS. Neither
    // is reachable by dragging, because neither is evidence a drag can
    // supply.
    return { ok: false, error: 'stage_is_a_record_fact', status: 400 }
  }
  const toStage = OPERATOR_STAGE_TO_MACHINE_STAGE[input.stage]
  if (!toStage) {
    return { ok: false, error: 'stage_has_no_machine_equivalent', status: 400 }
  }
  const legacyStatus = OPERATOR_STAGE_TO_LEGACY_STATUS[input.stage] ?? null

  const { data: wedding, error: readError } = await supabase
    .from('weddings')
    .select('id, venue_id, lifecycle_stage, lifecycle_transition_count')
    .eq('id', input.weddingId)
    .eq('venue_id', input.venueId)
    .maybeSingle<{
      id: string
      venue_id: string
      lifecycle_stage: string | null
      lifecycle_transition_count: number | null
    }>()
  if (readError) return { ok: false, error: readError.message, status: 500 }
  if (!wedding) return { ok: false, error: 'not_found', status: 404 }

  const fromStage = (wedding.lifecycle_stage as LifecycleStage | null) ?? null
  const now = new Date().toISOString()

  // Audit first, so a failed stage write leaves a record of the attempt
  // rather than a silent no-op. Same shape the admin override endpoint
  // writes, so one query answers "who moved this card".
  let transitionId: string | null = null
  const { data: inserted } = await supabase
    .from('lifecycle_transitions')
    .insert({
      wedding_id: input.weddingId,
      venue_id: input.venueId,
      from_stage: fromStage,
      to_stage: toStage,
      transition_kind: 'operator_override',
      evidence: {
        note: input.note ?? null,
        override_by: input.actorId,
        source: 'pipeline_board_drag',
        operator_stage: input.stage,
      },
      reasoning: input.note ?? 'moved on the pipeline board',
      confidence: 100,
      transitioned_by: input.actorId,
    })
    .select('id')
    .maybeSingle<{ id: string }>()
  transitionId = inserted?.id ?? null

  const update: Record<string, unknown> = {
    lifecycle_stage: toStage,
    lifecycle_stage_set_at: now,
    lifecycle_transition_count: (wedding.lifecycle_transition_count ?? 0) + 1,
    updated_at: now,
  }
  if (legacyStatus) update.status = legacyStatus

  const { error: updateError } = await supabase
    .from('weddings')
    .update(update)
    .eq('id', input.weddingId)
    .eq('venue_id', input.venueId)
  if (updateError) return { ok: false, error: updateError.message, status: 500 }

  return { ok: true, from: fromStage, to: toStage, legacyStatus, transitionId }
}
