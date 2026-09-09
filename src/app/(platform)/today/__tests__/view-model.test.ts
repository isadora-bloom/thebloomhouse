import { describe, it, expect } from 'vitest'
import type { DailyList, VenueOverview } from '@/lib/intel/canonical'
import {
  MATURITY_THRESHOLD_COUPLES,
  ROWS_PER_BLOCK,
  buildBriefing,
  buildTodayViewModel,
  displayName,
  goingQuietWhy,
  needsReplyWhy,
  openThreadAction,
  readyToBookWhy,
  tourWhy,
  type PulseLike,
} from '../view-model'

const NOW = Date.parse('2026-09-08T09:00:00.000Z')

// ─────────────────────────────────────────────────────────────────────
// Fixtures — hand-built reader output. No database anywhere in here.
// ─────────────────────────────────────────────────────────────────────

function emptyDaily(over: Partial<DailyList> = {}): DailyList {
  return {
    needsReply: [],
    goingCold: [],
    toursThisWeek: [],
    highIntent: [],
    nextTourAt: null,
    generatedAt: '2026-09-08T09:00:00.000Z',
    ...over,
  }
}

function emptyOverview(over: Partial<VenueOverview> = {}): VenueOverview {
  return {
    couples: {
      total: 0,
      byLifecycle: {
        channel_scoped: 0,
        resolved: 0,
        booked: 0,
        completed: 0,
        ghost: 0,
        agent: 0,
      },
    },
    recentActivity: [],
    dataMaturity: { backfillStatus: 'empty', oldestTouchpoint: null, n: 0 },
    generatedAt: '2026-09-08T09:00:00.000Z',
    ...over,
  }
}

function populatedOverview(): VenueOverview {
  return emptyOverview({
    couples: {
      total: 38,
      byLifecycle: {
        channel_scoped: 8,
        resolved: 12,
        booked: 3,
        completed: 0,
        ghost: 15,
        agent: 2,
      },
    },
    dataMaturity: {
      backfillStatus: 'populated',
      oldestTouchpoint: '2025-01-04T10:00:00.000Z',
      n: 2411,
    },
  })
}

// ─────────────────────────────────────────────────────────────────────
// Why lines
// ─────────────────────────────────────────────────────────────────────

describe('why lines', () => {
  it('says who wrote in, how, and when', () => {
    expect(
      needsReplyWhy(
        {
          id: 'c1',
          names: 'Chloe & Ryan',
          lastTouchpointAt: '2026-09-05T09:00:00.000Z',
          lastChannel: 'gmail',
        },
        NOW,
      ),
    ).toBe('They wrote in by email 3 days ago, and nothing has gone back yet.')
  })

  it('drops the clause it cannot fill rather than inventing it', () => {
    expect(needsReplyWhy({ id: 'c1', names: 'A', lastTouchpointAt: null }, NOW)).toBe(
      'Their message is the last one in the thread. Nothing has gone back yet.',
    )
    expect(
      needsReplyWhy(
        { id: 'c1', names: 'A', lastTouchpointAt: '2026-09-07T09:00:00.000Z', lastChannel: null },
        NOW,
      ),
    ).toBe('They wrote in yesterday, and nothing has gone back yet.')
  })

  it('names the listing site rather than its slug', () => {
    expect(
      needsReplyWhy(
        { id: 'c1', names: 'A', lastTouchpointAt: '2026-09-07T09:00:00.000Z', lastChannel: 'knot' },
        NOW,
      ),
    ).toContain('by The Knot')
  })

  it('states the quiet days against the window they are measured on', () => {
    expect(goingQuietWhy({ id: 'c1', names: 'A', quietDays: 94, windowDays: 120 })).toBe(
      'Quiet for 94 days. At 120 they drop off your active list.',
    )
    expect(goingQuietWhy({ id: 'c1', names: 'A', quietDays: 1, windowDays: 120 })).toBe(
      'Quiet for 1 day. At 120 they drop off your active list.',
    )
    expect(goingQuietWhy({ id: 'c1', names: 'A', quietDays: null })).toBe(
      'Nothing has moved on this one for a while, and they are drifting off your active list.',
    )
  })

  it('says when the tour is in words, not in a timestamp', () => {
    expect(
      tourWhy({ id: 't1', coupleId: 'c1', scheduledAt: '2026-09-09T13:30:00.000Z' }, NOW, 'UTC'),
    ).toBe('Tour tomorrow, 1:30pm.')
    expect(
      tourWhy({ id: 't1', coupleId: 'c1', scheduledAt: '2026-09-12T15:00:00.000Z' }, NOW, 'UTC'),
    ).toBe('Tour on Sat 12 Sep, 3:00pm.')
  })

  it('reads a tour time in the venue timezone, not the server one', () => {
    const late = { id: 't1', coupleId: 'c1', scheduledAt: '2026-09-13T00:30:00.000Z' }
    expect(tourWhy(late, NOW, 'UTC')).toBe('Tour on Sun 13 Sep, 12:30am.')
    expect(tourWhy(late, NOW, 'America/New_York')).toBe('Tour on Sat 12 Sep, 8:30pm.')
  })

  it('drops the time when the tour has a date but no time', () => {
    expect(
      tourWhy({ id: 't1', coupleId: 'c1', scheduledAt: '2026-09-12T00:00:00.000Z' }, NOW, 'UTC'),
    ).toBe('Tour on Sat 12 Sep.')
  })

  it('never prints the heat score', () => {
    const why = readyToBookWhy(
      { id: 'c1', names: 'A', heat: 87, lastTouchpointAt: '2026-09-07T09:00:00.000Z' },
      NOW,
    )
    expect(why).toBe('One of the most active couples you have right now. Last heard from them yesterday.')
    expect(why).not.toMatch(/\d/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Names and actions
// ─────────────────────────────────────────────────────────────────────

describe('names and actions', () => {
  it('never prints a blank name or a raw id', () => {
    expect(displayName('Chloe & Ryan')).toBe('Chloe & Ryan')
    expect(displayName('  ')).toBe('Name not captured yet')
    expect(displayName(null)).toBe('Name not captured yet')
  })

  it('sends a named couple to their emails and an unnamed one to the couple page', () => {
    expect(openThreadAction({ id: 'c1', names: 'Chloe & Ryan' })).toEqual({
      label: 'Open their emails',
      href: '/agent/inbox?q=Chloe%20%26%20Ryan',
    })
    expect(openThreadAction({ id: 'c1', names: null })).toEqual({
      label: 'Open the couple',
      href: '/intel/couples/c1',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Briefing
// ─────────────────────────────────────────────────────────────────────

describe('briefing', () => {
  it('says the counts in plain words and leaves out the empty states', () => {
    const b = buildBriefing(populatedOverview())
    expect(b.isReason).toBe(false)
    expect(b.text).toBe(
      'You have 38 couples on file: 12 in conversation, 8 new enquiries, 3 booked, 15 gone quiet.',
    )
    expect(b.text).not.toContain('not a couple')
    expect(b.text).not.toContain('wedding done')
  })

  it('gives the reason instead of counts when nothing has come in', () => {
    const b = buildBriefing(emptyOverview())
    expect(b.isReason).toBe(true)
    expect(b.text).toBe(
      'Nothing has come in yet, so there is nothing to say about your couples this morning.',
    )
  })

  it('uses no internal vocabulary', () => {
    const banned = ['lifecycle', 'ghost', 'resolved', 'channel_scoped', 'touchpoint', 'heat']
    const text = buildBriefing(populatedOverview()).text.toLowerCase()
    for (const word of banned) expect(text).not.toContain(word)
  })
})

// ─────────────────────────────────────────────────────────────────────
// The whole model
// ─────────────────────────────────────────────────────────────────────

describe('buildTodayViewModel', () => {
  const pulse: PulseLike[] = [
    {
      id: 'p1',
      priority: 'critical',
      title: 'Gmail sync failed',
      body: 'Reconnect the mailbox.',
      href: '/settings/integrations',
      createdAt: '2026-09-08T07:00:00.000Z',
    },
    {
      id: 'p2',
      priority: 'medium',
      title: 'Tour volume is down',
      body: null,
      href: null,
      createdAt: '2026-09-06T07:00:00.000Z',
    },
    {
      id: 'p3',
      priority: 'low',
      title: 'Weekly digest ready',
      body: null,
      href: '/intel/dashboard',
      createdAt: '2026-09-05T07:00:00.000Z',
    },
    {
      id: 'p4',
      priority: 'low',
      title: 'Should not appear',
      body: null,
      href: null,
      createdAt: '2026-09-05T07:00:00.000Z',
    },
  ]

  it('builds the four blocks in the order a coordinator reads them', () => {
    const vm = buildTodayViewModel({
      daily: emptyDaily(),
      overview: emptyOverview(),
      pulse: [],
      now: NOW,
    })
    expect(vm.blocks.map((b) => b.key)).toEqual([
      'needs-reply',
      'going-quiet',
      'tours',
      'ready-to-book',
    ])
    expect(vm.blocks.map((b) => b.title)).toEqual([
      'Needs a reply',
      'Going quiet',
      'Tours this week',
      'Ready to book',
    ])
  })

  it('gives every block a blurb saying what its count counts', () => {
    const vm = buildTodayViewModel({
      daily: emptyDaily(),
      overview: emptyOverview(),
      pulse: [],
      now: NOW,
    })
    for (const b of vm.blocks) expect(b.blurb.length).toBeGreaterThan(20)
  })

  it('names the next tour when this week is empty', () => {
    const vm = buildTodayViewModel({
      daily: emptyDaily({ nextTourAt: '2026-09-19T14:00:00.000Z' }),
      overview: emptyOverview(),
      pulse: [],
      now: NOW,
      timeZone: 'UTC',
    })
    const tours = vm.blocks.find((b) => b.key === 'tours')!
    expect(tours.empty).toBe('No tours this week. The next one is Sat 19 Sep.')
  })

  it('says so honestly when there is no next tour either', () => {
    const vm = buildTodayViewModel({
      daily: emptyDaily(),
      overview: emptyOverview(),
      pulse: [],
      now: NOW,
    })
    const tours = vm.blocks.find((b) => b.key === 'tours')!
    expect(tours.empty).toBe('No tours this week, and none on the books after it either.')
  })

  it('keeps the full count while capping the rows shown', () => {
    const many = Array.from({ length: ROWS_PER_BLOCK + 4 }, (_, i) => ({
      id: `c${i}`,
      names: `Couple ${i}`,
      lastTouchpointAt: '2026-09-07T09:00:00.000Z',
      lastChannel: 'gmail',
    }))
    const vm = buildTodayViewModel({
      daily: emptyDaily({ needsReply: many }),
      overview: populatedOverview(),
      pulse: [],
      now: NOW,
    })
    const block = vm.blocks.find((b) => b.key === 'needs-reply')!
    expect(block.count).toBe(ROWS_PER_BLOCK + 4)
    expect(block.rows).toHaveLength(ROWS_PER_BLOCK)
    expect(block.hidden).toBe(4)
  })

  it('carries the tour couple name and the couple id through to the row', () => {
    const vm = buildTodayViewModel({
      daily: emptyDaily({
        toursThisWeek: [
          {
            id: 't1',
            coupleId: 'c9',
            scheduledAt: '2026-09-12T15:00:00.000Z',
            names: 'Priya & Sam',
          },
        ],
      }),
      overview: populatedOverview(),
      pulse: [],
      now: NOW,
    })
    const row = vm.blocks.find((b) => b.key === 'tours')!.rows[0]
    expect(row.name).toBe('Priya & Sam')
    expect(row.key).toBe('t1')
    expect(row.action).toEqual({ label: 'Open the couple', href: '/intel/couples/c9' })
  })

  it('takes only the top three flagged items and translates the priority', () => {
    const vm = buildTodayViewModel({
      daily: emptyDaily(),
      overview: populatedOverview(),
      pulse,
      now: NOW,
    })
    expect(vm.pulse).toHaveLength(3)
    expect(vm.pulse.map((p) => p.urgency)).toEqual([
      'Needs a look now',
      'Worth a look',
      'For information',
    ])
    expect(vm.pulse[0].when).toBe('today')
    expect(vm.pulse.map((p) => p.id)).not.toContain('p4')
  })

  it('shows the data-maturity count-up only below the threshold', () => {
    const thin = buildTodayViewModel({
      daily: emptyDaily(),
      overview: emptyOverview({
        couples: {
          total: 4,
          byLifecycle: {
            channel_scoped: 0,
            resolved: 4,
            booked: 0,
            completed: 0,
            ghost: 0,
            agent: 0,
          },
        },
        dataMaturity: { backfillStatus: 'populated', oldestTouchpoint: null, n: 30 },
      }),
      pulse: [],
      now: NOW,
    })
    expect(thin.maturity).toEqual({
      current: 4,
      threshold: MATURITY_THRESHOLD_COUPLES,
      unit: 'couples',
      unlocks: 'patterns across your enquiries, like which listing sites send couples who book',
    })

    const thick = buildTodayViewModel({
      daily: emptyDaily(),
      overview: populatedOverview(),
      pulse: [],
      now: NOW,
    })
    expect(thick.maturity).toBe(null)
  })

  it('flags an all-clear morning', () => {
    const vm = buildTodayViewModel({
      daily: emptyDaily(),
      overview: populatedOverview(),
      pulse: [],
      now: NOW,
    })
    expect(vm.allClear).toBe(true)

    const busy = buildTodayViewModel({
      daily: emptyDaily({ needsReply: [{ id: 'c1', names: 'A' }] }),
      overview: populatedOverview(),
      pulse: [],
      now: NOW,
    })
    expect(busy.allClear).toBe(false)
  })

  it('puts no internal vocabulary anywhere on the page', () => {
    const banned = [
      'touchpoint',
      'lifecycle',
      'cascade',
      'spine',
      'cohort',
      'heat',
      'decay',
      'ghost',
      'channel_scoped',
      'first-touch',
      'attribution',
      'enoughdata',
      'signal tier',
    ]
    const vm = buildTodayViewModel({
      daily: emptyDaily({
        needsReply: [
          {
            id: 'c1',
            names: 'Chloe & Ryan',
            lastTouchpointAt: '2026-09-05T09:00:00.000Z',
            lastChannel: 'knot',
          },
        ],
        goingCold: [{ id: 'c2', names: 'Dev & Mo', quietDays: 94, windowDays: 120 }],
        toursThisWeek: [
          { id: 't1', coupleId: 'c3', scheduledAt: '2026-09-12T15:00:00.000Z', names: 'Ana & Jo' },
        ],
        highIntent: [
          { id: 'c4', names: 'Kit & Lou', heat: 91, lastTouchpointAt: '2026-09-08T08:00:00.000Z' },
        ],
        nextTourAt: '2026-09-12T15:00:00.000Z',
      }),
      overview: populatedOverview(),
      pulse: [],
      now: NOW,
    })

    const surface = [
      vm.briefing,
      ...vm.blocks.flatMap((b) => [
        b.title,
        b.blurb,
        b.empty,
        ...b.rows.flatMap((r) => [r.name, r.why, r.action.label]),
      ]),
    ]
      .join(' | ')
      .toLowerCase()

    for (const word of banned) {
      expect(surface.includes(word), `"${word}" leaked onto /today`).toBe(false)
    }
  })
})
