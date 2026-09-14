/**
 * Moving a card, pinned. W62.
 *
 * Only the refusals are tested here, because they are the part that runs
 * before anything is written and the part a bad request reaches first. A
 * client that throws on any query proves it: if one of these cases ever
 * touches the database, the test fails loudly rather than quietly
 * mutating a fixture.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { setBoardStage } from '../board-stage'
import {
  BOARD_STAGES,
  OPERATOR_STAGE_TO_MACHINE_STAGE,
  isDroppableStage,
} from '@/lib/intel/adapters/lead-board-view'

const noDatabase = {
  from() {
    throw new Error('setBoardStage reached the database on a request it should have refused')
  },
} as unknown as SupabaseClient

const base = { venueId: 'v1', weddingId: 'w1', actorId: 'u1' }

describe('setBoardStage refusals', () => {
  it('refuses a stage that is not on the board', async () => {
    const result = await setBoardStage(noDatabase, { ...base, stage: 'tour_scheduled' })
    expect(result).toEqual({ ok: false, error: 'unknown_stage', status: 400 })
  })

  it('refuses the two columns that are record facts, not places in a sale', async () => {
    for (const stage of ['not_a_couple', 'joined_up']) {
      const result = await setBoardStage(noDatabase, { ...base, stage })
      expect(result).toEqual({
        ok: false,
        error: 'stage_is_a_record_fact',
        status: 400,
      })
    }
  })

  it('refuses a move with no wedding to address', async () => {
    const result = await setBoardStage(noDatabase, {
      ...base,
      weddingId: '',
      stage: 'tour_booked',
    })
    expect(result).toEqual({
      ok: false,
      error: 'wedding and venue required',
      status: 400,
    })
  })

  it('has a machine stage ready for every column a card can be dropped into', () => {
    for (const stage of BOARD_STAGES) {
      if (!isDroppableStage(stage)) continue
      expect(OPERATOR_STAGE_TO_MACHINE_STAGE[stage], stage).toBeTruthy()
    }
  })
})
