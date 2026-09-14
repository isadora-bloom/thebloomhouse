/**
 * The lead board, pinned. W62.
 *
 * The question this file exists to answer is narrow and it is the only
 * one that matters about the change: for the same couple, does the spine
 * put the card in the column the old `weddings.status` query put it in?
 *
 * The fixture below is that comparison written out. Each row carries the
 * legacy status the old board grouped by, and the spine facts the same
 * couple has on file. The test derives the stage from the spine facts
 * alone and checks it lands where `LEGACY_STATUS_TO_OPERATOR_STAGE` says
 * the old status belongs. A derivation change that moves couples between
 * columns shows up here as a diff a reviewer can read, which is the same
 * shape W37's own 131-case fixture takes.
 */

import { describe, it, expect } from 'vitest'
import {
  BOARD_STAGES,
  HEAT_BUCKETS,
  LEAD_LIST_STAGES,
  LEGACY_STATUS_TO_OPERATOR_STAGE,
  OPERATOR_STAGE_TO_MACHINE_STAGE,
  buildBoardColumns,
  fillMissingActivity,
  filterLeadCards,
  heatDistribution,
  isDroppableStage,
  machineStageFromProgression,
  selectLeadList,
  sortLeadCards,
  toLeadCard,
  toLeadCards,
} from '../lead-board-view'
import type { LeadBoardRow, ProgressionAnchors } from '@/lib/intel/readers/lead-board'
import type { LifecycleStage } from '@/lib/services/lifecycle/state-machine'
import { ALL_OPERATOR_STAGES } from '@/lib/services/lifecycle/vocabulary'

// A fixed clock. Every date below is chosen relative to it.
const NOW = Date.parse('2026-09-14T12:00:00.000Z')
const DAY = 86_400_000

const EMPTY_PROGRESSION: ProgressionAnchors = {
  tourBookedAt: null,
  tourAttendedAt: null,
  contractSignedAt: null,
  lastEventType: null,
  lastEventAt: null,
  count: 0,
}

function row(overrides: Partial<LeadBoardRow> = {}): LeadBoardRow {
  return {
    coupleId: 'c1',
    venueId: 'v1',
    venueName: 'Rixey Manor',
    weddingId: 'w1',
    names: 'Ashley & Ryan',
    primaryName: 'Ashley',
    partnerName: 'Ryan',
    lifecycleState: 'resolved',
    channelScope: null,
    weddingDate: null,
    lastProgressionAt: null,
    decayWindowDays: 120,
    firstSeenAt: new Date(NOW - 30 * DAY).toISOString(),
    pointZeroAt: null,
    firstChannel: 'gmail',
    lastSignal: null,
    touchpointCount: 0,
    progression: { ...EMPTY_PROGRESSION },
    heat: null,
    clientCode: null,
    machineStage: null,
    machineStageSetAt: null,
    hasBooking: false,
    codeExtension: null,
    confidenceFlag: null,
    importWarnings: null,
    guestCountEstimate: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// THE FIXTURE
// ---------------------------------------------------------------------------
// One entry per value `weddings.status` could hold on the old board, with
// the spine facts a couple in that state actually carries. `note` says why
// the spine reads the way it does, because a fixture nobody can argue with
// is a fixture nobody checked.

interface Fixture {
  legacyStatus: string
  note: string
  spine: Partial<LeadBoardRow>
}

const FIXTURES: Fixture[] = [
  {
    legacyStatus: 'inquiry',
    note: 'Nobody has picked them up. The record is still scoped to the channel they arrived on.',
    spine: {
      coupleId: 'f-inquiry',
      lifecycleState: 'channel_scoped',
      machineStage: 'pre_touch',
      channelScope: 'knot',
      firstChannel: 'knot',
    },
  },
  {
    legacyStatus: 'tour_scheduled',
    note: 'A tour is on the books. Inbound, so the spine has the progression event too.',
    spine: {
      coupleId: 'f-tour-scheduled',
      lifecycleState: 'resolved',
      machineStage: 'tour_scheduled',
      progression: {
        ...EMPTY_PROGRESSION,
        tourBookedAt: new Date(NOW - 3 * DAY).toISOString(),
        lastEventType: 'tour_booked',
        lastEventAt: new Date(NOW - 3 * DAY).toISOString(),
        count: 1,
      },
    },
  },
  {
    legacyStatus: 'tour_completed',
    note: 'They came and saw it.',
    spine: {
      coupleId: 'f-tour-completed',
      lifecycleState: 'resolved',
      machineStage: 'tour_completed',
      progression: {
        ...EMPTY_PROGRESSION,
        tourBookedAt: new Date(NOW - 12 * DAY).toISOString(),
        tourAttendedAt: new Date(NOW - 5 * DAY).toISOString(),
        lastEventType: 'tour_attended',
        lastEventAt: new Date(NOW - 5 * DAY).toISOString(),
        count: 2,
      },
    },
  },
  {
    legacyStatus: 'proposal_sent',
    note: 'A proposal went out. Outbound, so only the machine knows: the spine is inbound-only by doctrine.',
    spine: {
      coupleId: 'f-proposal',
      lifecycleState: 'resolved',
      machineStage: 'proposal_active',
    },
  },
  {
    legacyStatus: 'contracted',
    note: 'Contract signed. The old board drew this as its own column; a signature and a booking were never two different facts.',
    spine: {
      coupleId: 'f-contracted',
      lifecycleState: 'booked',
      machineStage: 'booked',
      hasBooking: true,
      weddingDate: '2027-06-05',
      progression: {
        ...EMPTY_PROGRESSION,
        contractSignedAt: new Date(NOW - 20 * DAY).toISOString(),
        lastEventType: 'contract_signed',
        lastEventAt: new Date(NOW - 20 * DAY).toISOString(),
        count: 1,
      },
    },
  },
  {
    legacyStatus: 'booked',
    note: 'Booked, wedding well out.',
    spine: {
      coupleId: 'f-booked',
      lifecycleState: 'booked',
      machineStage: 'booked',
      hasBooking: true,
      weddingDate: '2027-09-11',
    },
  },
  {
    legacyStatus: 'lost',
    note: 'They stopped answering and the decay sweep ghosted the record.',
    spine: {
      coupleId: 'f-lost',
      lifecycleState: 'ghost',
      machineStage: 'lost',
      lastProgressionAt: new Date(NOW - 200 * DAY).toISOString(),
    },
  },
  {
    legacyStatus: 'cancelled',
    note: 'Cancelled on the pipeline; the record has not been swept to ghost yet, which is the usual gap of a few days.',
    spine: {
      coupleId: 'f-cancelled',
      lifecycleState: 'resolved',
      machineStage: 'cancelled',
    },
  },
  {
    legacyStatus: 'completed',
    note: 'The wedding happened. An identity fact, so the record wins outright.',
    spine: {
      coupleId: 'f-completed',
      lifecycleState: 'completed',
      machineStage: 'post_event',
      hasBooking: true,
      weddingDate: '2026-06-06',
    },
  },
]

const FIXTURE_ROWS = FIXTURES.map((f) => row(f.spine))

// ---------------------------------------------------------------------------

describe('the legacy bridge', () => {
  it('covers every status the old board could hold', () => {
    const inFixture = FIXTURES.map((f) => f.legacyStatus).sort()
    const inTable = Object.keys(LEGACY_STATUS_TO_OPERATOR_STAGE).sort()
    expect(inFixture).toEqual(inTable)
  })

  it('maps every legacy status onto a real operator stage', () => {
    for (const stage of Object.values(LEGACY_STATUS_TO_OPERATOR_STAGE)) {
      expect(ALL_OPERATOR_STAGES).toContain(stage)
    }
  })

  for (const fixture of FIXTURES) {
    const expected = LEGACY_STATUS_TO_OPERATOR_STAGE[fixture.legacyStatus]
    it(`a couple the old board called "${fixture.legacyStatus}" lands in "${expected}" — ${fixture.note}`, () => {
      const card = toLeadCard(row(fixture.spine), NOW)
      expect(card.stage.stage).toBe(expected)
    })
  }
})

describe('the board columns', () => {
  it('is the thirteen operator stages, in the one order', () => {
    expect([...BOARD_STAGES]).toEqual([...ALL_OPERATOR_STAGES])
    expect(BOARD_STAGES.length).toBe(13)
  })

  it('puts every fixture couple in the column its old status implies', () => {
    const columns = buildBoardColumns(toLeadCards(FIXTURE_ROWS, NOW))
    for (const fixture of FIXTURES) {
      const expected = LEGACY_STATUS_TO_OPERATOR_STAGE[fixture.legacyStatus]
      const column = columns.find((c) => c.key === expected)
      expect(column).toBeDefined()
      expect(column?.cards.map((c) => c.coupleId)).toContain(fixture.spine.coupleId)
    }
  })

  it('loses nobody: every card is in exactly one column', () => {
    const cards = toLeadCards(FIXTURE_ROWS, NOW)
    const columns = buildBoardColumns(cards)
    const placed = columns.flatMap((c) => c.cards.map((card) => card.coupleId))
    expect(placed.sort()).toEqual(cards.map((c) => c.coupleId).sort())
  })

  it('counts add up to the row count', () => {
    const cards = toLeadCards(FIXTURE_ROWS, NOW)
    const total = buildBoardColumns(cards).reduce((sum, c) => sum + c.cards.length, 0)
    expect(total).toBe(cards.length)
  })

  it('refuses a drop into the two columns that are record facts', () => {
    expect(isDroppableStage('not_a_couple')).toBe(false)
    expect(isDroppableStage('joined_up')).toBe(false)
    expect(isDroppableStage('tour_booked')).toBe(true)
    // And neither has a machine stage to write, so a drag could not be
    // honoured even if the column accepted it.
    expect(OPERATOR_STAGE_TO_MACHINE_STAGE.not_a_couple).toBeUndefined()
    expect(OPERATOR_STAGE_TO_MACHINE_STAGE.joined_up).toBeUndefined()
  })

  it('gives every droppable stage a machine stage to write', () => {
    for (const stage of BOARD_STAGES) {
      if (!isDroppableStage(stage)) continue
      expect(OPERATOR_STAGE_TO_MACHINE_STAGE[stage]).toBeTruthy()
    }
  })
})

describe('the lead list', () => {
  it('holds every stage the old status filter held', () => {
    // The old /agent/leads query was
    // status IN (inquiry, tour_scheduled, tour_completed, proposal_sent).
    const oldStatuses = ['inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent']
    for (const status of oldStatuses) {
      expect(LEAD_LIST_STAGES).toContain(LEGACY_STATUS_TO_OPERATOR_STAGE[status])
    }
    // It also holds `in_conversation`, which the old vocabulary had no
    // word for: those couples were filed as `inquiry` whether anyone had
    // spoken to them or not.
    expect(LEAD_LIST_STAGES).toContain('in_conversation')
  })

  it('drops the couples the old query dropped', () => {
    const list = selectLeadList(toLeadCards(FIXTURE_ROWS, NOW))
    const ids = list.map((c) => c.coupleId)
    expect(ids).not.toContain('f-booked')
    expect(ids).not.toContain('f-contracted')
    expect(ids).not.toContain('f-lost')
    expect(ids).not.toContain('f-cancelled')
    expect(ids).not.toContain('f-completed')
    expect(ids).toContain('f-inquiry')
    expect(ids).toContain('f-proposal')
  })
})

describe('machineStageFromProgression', () => {
  it('reads a signed contract as booked', () => {
    expect(
      machineStageFromProgression({
        ...EMPTY_PROGRESSION,
        contractSignedAt: '2026-08-01T00:00:00.000Z',
        count: 1,
      }),
    ).toBe('booked')
  })

  it('prefers an attended tour over a booked one', () => {
    expect(
      machineStageFromProgression({
        ...EMPTY_PROGRESSION,
        tourBookedAt: '2026-08-01T00:00:00.000Z',
        tourAttendedAt: '2026-08-08T00:00:00.000Z',
        count: 2,
      }),
    ).toBe('tour_completed')
  })

  it('separates one inbound from a conversation', () => {
    expect(machineStageFromProgression({ ...EMPTY_PROGRESSION, count: 1 })).toBe(
      'first_touch',
    )
    expect(machineStageFromProgression({ ...EMPTY_PROGRESSION, count: 4 })).toBe('nurture')
  })

  it('never claims a proposal, because the spine cannot evidence one', () => {
    const stages: Array<LifecycleStage | null> = []
    for (let count = 0; count <= 6; count++) {
      stages.push(machineStageFromProgression({ ...EMPTY_PROGRESSION, count }))
    }
    expect(stages).not.toContain('proposal_active')
  })

  it('says nothing when there is nothing on file', () => {
    expect(machineStageFromProgression(EMPTY_PROGRESSION)).toBeNull()
    expect(
      machineStageFromProgression(EMPTY_PROGRESSION, { touchpointCount: 3 }),
    ).toBe('first_touch')
  })

  it('places a couple with no mirrored wedding on its inbound history alone', () => {
    const card = toLeadCard(
      row({
        coupleId: 'fragment-promoted',
        weddingId: null,
        machineStage: null,
        lifecycleState: 'resolved',
        progression: {
          ...EMPTY_PROGRESSION,
          tourBookedAt: new Date(NOW - 2 * DAY).toISOString(),
          lastEventType: 'tour_booked',
          lastEventAt: new Date(NOW - 2 * DAY).toISOString(),
          count: 1,
        },
      }),
      NOW,
    )
    expect(card.stage.stage).toBe('tour_booked')
  })
})

describe('heat', () => {
  const withHeat = (score: number, bucket: 'cool' | 'warm' | 'hot' | 'on_fire') =>
    row({
      coupleId: `h-${bucket}-${score}`,
      heat: {
        score,
        displayScore: score,
        bucket,
        label: bucket,
        evidence: [],
        reasoning: 'test',
        contributingCount: 1,
      },
    })

  it('counts an unreadable heat as unknown, never as the coldest bucket', () => {
    const cards = toLeadCards([withHeat(200, 'on_fire'), row({ coupleId: 'no-heat' })], NOW)
    const dist = heatDistribution(cards)
    expect(dist.on_fire).toBe(1)
    expect(dist.cool).toBe(0)
    expect(dist.unknown).toBe(1)
  })

  it('has four buckets, hottest first', () => {
    expect([...HEAT_BUCKETS]).toEqual(['on_fire', 'hot', 'warm', 'cool'])
  })

  it('leaves unknown heat out of a bucket filter rather than guessing', () => {
    const cards = toLeadCards([withHeat(100, 'hot'), row({ coupleId: 'no-heat' })], NOW)
    expect(filterLeadCards(cards, { bucket: 'hot' }).map((c) => c.coupleId)).toEqual([
      'h-hot-100',
    ])
    expect(filterLeadCards(cards, { bucket: 'cool' })).toHaveLength(0)
  })

  it('sorts unknown heat below a known zero', () => {
    const cards = toLeadCards([row({ coupleId: 'unknown' }), withHeat(0, 'cool')], NOW)
    const sorted = sortLeadCards(cards, 'heat', 'desc')
    expect(sorted.map((c) => c.coupleId)).toEqual(['h-cool-0', 'unknown'])
  })
})

describe('filters and sorts', () => {
  const cards = toLeadCards(
    [
      row({ coupleId: 'a', names: 'Ashley & Ryan', firstChannel: 'knot' }),
      row({ coupleId: 'b', names: 'Doug Loxtercamp', firstChannel: 'gmail' }),
    ],
    NOW,
  )

  it('searches names and arrival channel', () => {
    expect(filterLeadCards(cards, { query: 'doug' }).map((c) => c.coupleId)).toEqual(['b'])
    expect(filterLeadCards(cards, { query: 'knot' }).map((c) => c.coupleId)).toEqual(['a'])
    expect(filterLeadCards(cards, { query: '   ' })).toHaveLength(2)
  })

  it('sorts by last activity in both directions', () => {
    const withActivity = toLeadCards(
      [
        row({
          coupleId: 'older',
          lastSignal: {
            at: new Date(NOW - 10 * DAY).toISOString(),
            channel: 'gmail',
            actionType: 'reply',
          },
        }),
        row({
          coupleId: 'newer',
          lastSignal: {
            at: new Date(NOW - 1 * DAY).toISOString(),
            channel: 'gmail',
            actionType: 'reply',
          },
        }),
      ],
      NOW,
    )
    expect(sortLeadCards(withActivity, 'last_activity', 'desc').map((c) => c.coupleId)).toEqual([
      'newer',
      'older',
    ])
    expect(sortLeadCards(withActivity, 'last_activity', 'asc').map((c) => c.coupleId)).toEqual([
      'older',
      'newer',
    ])
  })

  it('does not mutate the list it was handed', () => {
    const before = cards.map((c) => c.coupleId)
    sortLeadCards(cards, 'heat', 'asc')
    expect(cards.map((c) => c.coupleId)).toEqual(before)
  })
})

describe('fillMissingActivity', () => {
  it('fills a card the ribbon could not answer for', () => {
    const cards = toLeadCards([row({ coupleId: 'c1', weddingId: 'w1' })], NOW)
    const filled = fillMissingActivity(cards, { w1: '2026-09-01T00:00:00.000Z' })
    expect(filled[0].lastActivityAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('never talks over the ribbon', () => {
    const ribbon = new Date(NOW - DAY).toISOString()
    const cards = toLeadCards(
      [
        row({
          coupleId: 'c1',
          weddingId: 'w1',
          lastSignal: { at: ribbon, channel: 'gmail', actionType: 'reply' },
        }),
      ],
      NOW,
    )
    const filled = fillMissingActivity(cards, { w1: '2020-01-01T00:00:00.000Z' })
    expect(filled[0].lastActivityAt).toBe(ribbon)
  })

  it('leaves the card shape intact', () => {
    const cards = toLeadCards([row({ coupleId: 'c1', weddingId: 'w1' })], NOW)
    const filled = fillMissingActivity(cards, { w1: '2026-09-01T00:00:00.000Z' })
    expect(filled[0]).not.toHaveProperty('id')
    expect(filled[0]).not.toHaveProperty('last_activity_at')
    expect(filled[0].coupleId).toBe('c1')
    expect(filled[0].stage.stage).toBe(cards[0].stage.stage)
  })
})

describe('days counters', () => {
  it('counts days in stage from the stage clock, not the row clock', () => {
    const card = toLeadCard(
      row({ machineStageSetAt: new Date(NOW - 9 * DAY).toISOString() }),
      NOW,
    )
    expect(card.daysInStage).toBe(9)
  })

  it('shows no days-in-stage rather than a confident zero when the stage never moved', () => {
    expect(toLeadCard(row({ machineStageSetAt: null }), NOW).daysInStage).toBeNull()
  })

  it('counts days known from the first signal of any kind', () => {
    expect(toLeadCard(row(), NOW).daysSinceFirstSeen).toBe(30)
    expect(toLeadCard(row({ firstSeenAt: null }), NOW).daysSinceFirstSeen).toBeNull()
  })
})
