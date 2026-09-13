/**
 * The one lifecycle vocabulary, pinned. W37.
 *
 * The point of this file is the fixture: every machine stage crossed with
 * every spine state, written down as a literal table. If someone changes
 * the derivation, the diff here says in plain terms which couples will see
 * a different word on their pill, which is the review a mapping change
 * deserves.
 */

import { describe, it, expect } from 'vitest'
import type { LifecycleStage } from '../state-machine'
import {
  ALL_MACHINE_STAGES,
  ALL_OPERATOR_STAGES,
  deriveOperatorStage,
  machineStageToSpineState,
  MACHINE_STAGE_TO_SPINE_STATE,
  operatorStageTone,
  type OperatorStage,
  type SpineStateInput,
} from '../vocabulary'

// A fixed clock. Nothing in the matrix depends on it, but passing a real
// instant keeps the "last heard" clause exercised.
const TODAY = '2026-09-12T12:00:00.000Z'

type MachineKey = LifecycleStage | 'none'

const MACHINE_KEYS: MachineKey[] = [
  'none',
  'pre_touch',
  'first_touch',
  'nurture',
  'tour_scheduled',
  'tour_completed',
  'proposal_active',
  'booked',
  'planning_active',
  'day_of',
  'post_event',
  'long_tail',
  'lost',
  'cancelled',
]

const SPINE_KEYS: Array<Exclude<SpineStateInput, null> | 'none'> = [
  'none',
  'channel_scoped',
  'resolved',
  'booked',
  'completed',
  'ghost',
  'agent',
  'merged',
]

// ---------------------------------------------------------------------------
// THE MAPPING TABLE
// ---------------------------------------------------------------------------
// Read down a column for "what does this spine state do to every machine
// stage", across a row for "what does this machine stage look like under
// every record state". Derived with no booking on file and no wedding date,
// so each cell is the mapping and nothing else.

const TABLE: Record<string, Record<MachineKey, OperatorStage>> = {
  // No state on file. The machine speaks alone.
  none: {
    none: 'new_enquiry',
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
  },
  // An unacknowledged signal. The machine still owns the process.
  channel_scoped: {
    none: 'new_enquiry',
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
  },
  // A live conversation. Same, with a different answer when the machine
  // has nothing to say.
  resolved: {
    none: 'in_conversation',
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
  },
  // A booking is a fact. Nothing pre-signature on the machine can pull the
  // couple back to an enquiry; only a cancellation overturns it, and only
  // the post-signature stages refine it.
  booked: {
    none: 'booked',
    pre_touch: 'booked',
    first_touch: 'booked',
    nurture: 'booked',
    tour_scheduled: 'booked',
    tour_completed: 'booked',
    proposal_active: 'booked',
    booked: 'booked',
    planning_active: 'planning',
    day_of: 'this_week',
    post_event: 'wedding_done',
    long_tail: 'wedding_done',
    lost: 'booked',
    cancelled: 'cancelled',
  },
  // The four identity facts the spine owns outright. Every machine stage
  // gives the same answer, because the machine does not get a vote.
  completed: {
    none: 'wedding_done',
    pre_touch: 'wedding_done',
    first_touch: 'wedding_done',
    nurture: 'wedding_done',
    tour_scheduled: 'wedding_done',
    tour_completed: 'wedding_done',
    proposal_active: 'wedding_done',
    booked: 'wedding_done',
    planning_active: 'wedding_done',
    day_of: 'wedding_done',
    post_event: 'wedding_done',
    long_tail: 'wedding_done',
    lost: 'wedding_done',
    cancelled: 'wedding_done',
  },
  ghost: {
    none: 'gone_quiet',
    pre_touch: 'gone_quiet',
    first_touch: 'gone_quiet',
    nurture: 'gone_quiet',
    tour_scheduled: 'gone_quiet',
    tour_completed: 'gone_quiet',
    proposal_active: 'gone_quiet',
    booked: 'gone_quiet',
    planning_active: 'gone_quiet',
    day_of: 'gone_quiet',
    post_event: 'gone_quiet',
    long_tail: 'gone_quiet',
    lost: 'gone_quiet',
    cancelled: 'gone_quiet',
  },
  agent: {
    none: 'not_a_couple',
    pre_touch: 'not_a_couple',
    first_touch: 'not_a_couple',
    nurture: 'not_a_couple',
    tour_scheduled: 'not_a_couple',
    tour_completed: 'not_a_couple',
    proposal_active: 'not_a_couple',
    booked: 'not_a_couple',
    planning_active: 'not_a_couple',
    day_of: 'not_a_couple',
    post_event: 'not_a_couple',
    long_tail: 'not_a_couple',
    lost: 'not_a_couple',
    cancelled: 'not_a_couple',
  },
  merged: {
    none: 'joined_up',
    pre_touch: 'joined_up',
    first_touch: 'joined_up',
    nurture: 'joined_up',
    tour_scheduled: 'joined_up',
    tour_completed: 'joined_up',
    proposal_active: 'joined_up',
    booked: 'joined_up',
    planning_active: 'joined_up',
    day_of: 'joined_up',
    post_event: 'joined_up',
    long_tail: 'joined_up',
    lost: 'joined_up',
    cancelled: 'joined_up',
  },
}

function derive(spine: string, machine: MachineKey) {
  return deriveOperatorStage({
    spineState: spine === 'none' ? null : (spine as SpineStateInput),
    machineStage: machine === 'none' ? null : (machine as LifecycleStage),
    hasBooking: false,
    weddingDate: null,
    lastInboundAt: null,
    today: TODAY,
  })
}

describe('the mapping table', () => {
  it('covers every spine state crossed with every machine stage', () => {
    // Guard against the table quietly falling behind either lifecycle.
    expect(Object.keys(TABLE).sort()).toEqual([...SPINE_KEYS].sort())
    expect([...ALL_MACHINE_STAGES].sort()).toEqual(
      MACHINE_KEYS.filter((k) => k !== 'none').sort(),
    )
  })

  for (const spine of SPINE_KEYS) {
    for (const machine of MACHINE_KEYS) {
      it(`${spine} + ${machine} reads as ${TABLE[spine][machine]}`, () => {
        expect(derive(spine, machine).stage).toBe(TABLE[spine][machine])
      })
    }
  }

  it('always returns a stage that has a label and a tone', () => {
    for (const spine of SPINE_KEYS) {
      for (const machine of MACHINE_KEYS) {
        const result = derive(spine, machine)
        expect(ALL_OPERATOR_STAGES).toContain(result.stage)
        expect(result.label.length).toBeGreaterThan(0)
        expect(operatorStageTone(result.stage)).toBeTruthy()
        expect(result.because.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('the fixed projection onto the six spine states', () => {
  it('is total over the thirteen stages', () => {
    expect(Object.keys(MACHINE_STAGE_TO_SPINE_STATE)).toHaveLength(13)
    for (const stage of ALL_MACHINE_STAGES) {
      expect(machineStageToSpineState(stage)).toBeTruthy()
    }
  })

  it('projects each stage where the doctrine says it goes', () => {
    expect(machineStageToSpineState('pre_touch')).toBe('channel_scoped')
    expect(machineStageToSpineState('first_touch')).toBe('resolved')
    expect(machineStageToSpineState('nurture')).toBe('resolved')
    expect(machineStageToSpineState('tour_scheduled')).toBe('resolved')
    expect(machineStageToSpineState('tour_completed')).toBe('resolved')
    expect(machineStageToSpineState('proposal_active')).toBe('resolved')
    expect(machineStageToSpineState('booked')).toBe('booked')
    expect(machineStageToSpineState('planning_active')).toBe('booked')
    expect(machineStageToSpineState('day_of')).toBe('booked')
    expect(machineStageToSpineState('post_event')).toBe('completed')
    expect(machineStageToSpineState('long_tail')).toBe('completed')
    expect(machineStageToSpineState('lost')).toBe('ghost')
    expect(machineStageToSpineState('cancelled')).toBe('ghost')
  })

  it('returns null rather than guessing for nothing and for nonsense', () => {
    expect(machineStageToSpineState(null)).toBeNull()
    expect(machineStageToSpineState('made_up' as LifecycleStage)).toBeNull()
  })
})

describe('disagreements', () => {
  it('shows the record when the record says gone quiet and the pipeline does not', () => {
    const result = deriveOperatorStage({
      spineState: 'ghost',
      machineStage: 'nurture',
      hasBooking: false,
      weddingDate: null,
      lastInboundAt: '2026-04-01T00:00:00.000Z',
      today: TODAY,
    })
    expect(result.stage).toBe('gone_quiet')
    expect(result.agreement).toBe('disagreed')
    expect(result.because).toContain('pipeline')
    expect(result.because).toContain('in conversation')
    // The quiet spell is part of the reason, in plain words.
    expect(result.because).toContain('months ago')
  })

  it('flags a record still reading as in conversation once the machine books them', () => {
    const result = deriveOperatorStage({
      spineState: 'resolved',
      machineStage: 'booked',
      hasBooking: false,
      weddingDate: null,
      lastInboundAt: null,
      today: TODAY,
    })
    expect(result.stage).toBe('booked')
    expect(result.agreement).toBe('disagreed')
    expect(result.projectedSpineState).toBe('booked')
  })

  it('keeps a booked couple booked when the pipeline calls them lost', () => {
    const result = deriveOperatorStage({
      spineState: 'booked',
      machineStage: 'lost',
      hasBooking: true,
      weddingDate: '2027-06-05',
      lastInboundAt: null,
      today: TODAY,
    })
    expect(result.stage).toBe('booked')
    expect(result.agreement).toBe('disagreed')
    expect(result.because).toContain('does not square with a booking')
  })

  it('lets a cancellation overturn a booking, and says the sweep is behind', () => {
    const result = deriveOperatorStage({
      spineState: 'booked',
      machineStage: 'cancelled',
      hasBooking: true,
      weddingDate: '2027-06-05',
      lastInboundAt: null,
      today: TODAY,
    })
    expect(result.stage).toBe('cancelled')
    expect(result.agreement).toBe('disagreed')
    expect(result.because).toContain('not been swept through')
  })

  it('calls it agreed when both lifecycles point at the same place', () => {
    const result = deriveOperatorStage({
      spineState: 'resolved',
      machineStage: 'tour_scheduled',
      hasBooking: false,
      weddingDate: null,
      lastInboundAt: null,
      today: TODAY,
    })
    expect(result.stage).toBe('tour_booked')
    expect(result.agreement).toBe('agreed')
  })

  it('calls it one-sided when only one lifecycle has anything to say', () => {
    expect(
      deriveOperatorStage({
        spineState: null,
        machineStage: 'nurture',
        hasBooking: false,
        weddingDate: null,
        lastInboundAt: null,
        today: TODAY,
      }).agreement,
    ).toBe('one_sided')
    expect(
      deriveOperatorStage({
        spineState: 'resolved',
        machineStage: null,
        hasBooking: false,
        weddingDate: null,
        lastInboundAt: null,
        today: TODAY,
      }).agreement,
    ).toBe('one_sided')
  })
})

describe('a booking places the couple on the wedding-date arc', () => {
  const base = {
    spineState: 'booked' as const,
    machineStage: null,
    hasBooking: true,
    lastInboundAt: null,
    today: TODAY,
  }

  it('reads as wedding done once the date is well past', () => {
    expect(deriveOperatorStage({ ...base, weddingDate: '2026-06-06' }).stage).toBe(
      'wedding_done',
    )
  })

  it('reads as this week inside the day-of window', () => {
    expect(deriveOperatorStage({ ...base, weddingDate: '2026-09-14' }).stage).toBe(
      'this_week',
    )
    // One day after the wedding still counts as the day-of window.
    expect(deriveOperatorStage({ ...base, weddingDate: '2026-09-12' }).stage).toBe(
      'this_week',
    )
  })

  it('reads as booked further out, and says how far', () => {
    const result = deriveOperatorStage({ ...base, weddingDate: '2027-06-05' })
    expect(result.stage).toBe('booked')
    expect(result.because).toContain('days out')
  })

  it('reads as booked with no date on file, and says that too', () => {
    const result = deriveOperatorStage({ ...base, weddingDate: null })
    expect(result.stage).toBe('booked')
    expect(result.because).toContain('No wedding date on file')
  })

  it('honours a signed booking even when the record has not caught up', () => {
    const result = deriveOperatorStage({
      spineState: 'resolved',
      machineStage: null,
      hasBooking: true,
      weddingDate: '2027-06-05',
      lastInboundAt: null,
      today: TODAY,
    })
    expect(result.stage).toBe('booked')
    expect(result.because).toContain('signed booking on file')
  })
})

describe('robustness', () => {
  it('treats an unknown state as no state rather than throwing', () => {
    const result = deriveOperatorStage({
      spineState: 'something_new',
      machineStage: null,
      hasBooking: false,
      weddingDate: null,
      lastInboundAt: null,
      today: TODAY,
    })
    expect(result.stage).toBe('new_enquiry')
    expect(result.spineState).toBeNull()
  })

  it('accepts a Date, a number or an ISO string as today', () => {
    const asDate = deriveOperatorStage({
      spineState: 'booked',
      machineStage: null,
      hasBooking: true,
      weddingDate: '2026-09-14',
      lastInboundAt: null,
      today: new Date(TODAY),
    })
    const asNumber = deriveOperatorStage({
      spineState: 'booked',
      machineStage: null,
      hasBooking: true,
      weddingDate: '2026-09-14',
      lastInboundAt: null,
      today: Date.parse(TODAY),
    })
    expect(asDate.stage).toBe('this_week')
    expect(asNumber.stage).toBe('this_week')
  })

  it('drops the last-heard clause when there is nothing on file', () => {
    const result = deriveOperatorStage({
      spineState: 'resolved',
      machineStage: null,
      hasBooking: false,
      weddingDate: null,
      lastInboundAt: null,
      today: TODAY,
    })
    expect(result.because).not.toContain('Last heard')
  })
})
