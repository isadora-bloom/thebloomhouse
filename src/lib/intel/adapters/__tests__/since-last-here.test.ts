/**
 * "Since you were last here" — the window rule and the four counts
 * (NOVEMBER-PLAN.md wave 6, W42).
 *
 * Three things worth pinning:
 *   1. The window's Monday special-case, and that it does NOT get
 *      clever about public holidays (that would be an invented fact —
 *      see the file header on ./since-last-here.ts).
 *   2. The reader counts the right rows and nothing else, against a
 *      fake Supabase client (same fixture-filtering shape used by
 *      src/lib/services/cohort/__tests__/bulk-follow-up.test.ts).
 *   3. The pure strip builder gives every count a rule, a source and a
 *      link — the same guard daily-list-view.test.ts runs for the
 *      triage rail.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSinceLastHereStrip,
  computeSinceLastHereWindow,
  loadSinceLastHere,
  type SinceLastHereCounts,
} from '../since-last-here'

// ─────────────────────────────────────────────────────────────────────
// 1. computeSinceLastHereWindow
// ─────────────────────────────────────────────────────────────────────

const ZONE = 'America/New_York'

/** Build a fake "now" for a given ET wall-clock date + time, well clear
 *  of any DST transition so the maths is easy to hand-check. Returns
 *  epoch ms. EDT (UTC-4) covers every date used below. */
function etMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour + 4, minute)
}

describe('computeSinceLastHereWindow', () => {
  it('Monday: window starts Friday 18:00 venue time, three calendar days back', () => {
    // Monday 14 September 2026, 09:00 ET.
    const now = etMs(2026, 9, 14, 9)
    const window = computeSinceLastHereWindow(now, ZONE)
    expect(window.fromIso).toBe(new Date(etMs(2026, 9, 11, 18)).toISOString())
    expect(window.toMs).toBe(now)
    expect(window.label).toContain('Fri')
    expect(window.label).toContain('6:00pm')
  })

  it('Tuesday: window starts the previous day, 18:00', () => {
    // Tuesday 15 September 2026, 09:00 ET.
    const now = etMs(2026, 9, 15, 9)
    const window = computeSinceLastHereWindow(now, ZONE)
    expect(window.fromIso).toBe(new Date(etMs(2026, 9, 14, 18)).toISOString())
    expect(window.label).toContain('Mon')
  })

  it('after a public holiday: still just "the previous day", not holiday-aware', () => {
    // Thursday 3 September 2026 — the day after Wednesday 2 September,
    // stood in here for a mid-week holiday closure. The venue may well
    // have been shut all Wednesday, but nothing in the spine records
    // that, so the window still opens Wednesday 18:00 rather than
    // reaching back further to the last day someone was actually in.
    const now = etMs(2026, 9, 3, 9)
    const window = computeSinceLastHereWindow(now, ZONE)
    expect(window.fromIso).toBe(new Date(etMs(2026, 9, 2, 18)).toISOString())
  })

  it('Sunday and Saturday fall under the same "previous day" rule as any other non-Monday', () => {
    const sunday = etMs(2026, 9, 13, 9) // Sunday 13 Sep 2026
    const saturday = etMs(2026, 9, 12, 9) // Saturday 12 Sep 2026
    expect(computeSinceLastHereWindow(sunday, ZONE).fromIso).toBe(
      new Date(etMs(2026, 9, 12, 18)).toISOString(),
    )
    expect(computeSinceLastHereWindow(saturday, ZONE).fromIso).toBe(
      new Date(etMs(2026, 9, 11, 18)).toISOString(),
    )
  })

  it('the window always ends at the "now" passed in', () => {
    const now = etMs(2026, 9, 15, 11, 30)
    expect(computeSinceLastHereWindow(now, ZONE).toMs).toBe(now)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. loadSinceLastHere — fake Supabase reader
// ─────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

/** Same predicate-filtering fake shape as
 *  src/lib/services/cohort/__tests__/bulk-follow-up.test.ts: `.from()`
 *  returns a chain that records `.eq/.is/.gte/.lte` as predicates and
 *  resolves (via `.then`, so it can be awaited directly like a real
 *  Supabase query) to the fixture rows that pass every predicate. */
function fakeSupabase(fixtures: Record<string, Row[]>) {
  return {
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      const chain: any = {}
      chain.select = () => chain
      chain.eq = (c: string, v: unknown) => {
        preds.push((r) => r[c] === v)
        return chain
      }
      chain.is = (c: string, v: unknown) => {
        preds.push((r) => (r[c] ?? null) === v)
        return chain
      }
      chain.gte = (c: string, v: string) => {
        preds.push((r) => typeof r[c] === 'string' && (r[c] as string) >= v)
        return chain
      }
      chain.lte = (c: string, v: string) => {
        preds.push((r) => typeof r[c] === 'string' && (r[c] as string) <= v)
        return chain
      }
      chain.order = () => chain
      chain.limit = () => chain
      chain.then = (onFulfilled: (v: unknown) => unknown) => {
        const rows = (fixtures[table] ?? []).filter((r) => preds.every((p) => p(r)))
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled)
      }
      return chain
    },
  } as any
}

const VENUE = 'venue-1'
const WINDOW = computeSinceLastHereWindow(etMs(2026, 9, 14, 9), ZONE) // Monday; Fri 18:00 -> Mon 09:00

describe('loadSinceLastHere', () => {
  it('counts a couple whose first-ever message is inbound and lands in the window as arrived', async () => {
    const supabase = fakeSupabase({
      couples: [{ id: 'c1', venue_id: VENUE, merged_into_id: null }],
      touchpoints: [
        {
          couple_id: 'c1',
          venue_id: VENUE,
          channel: 'gmail',
          action_type: 'inquiry',
          occurred_at: new Date(etMs(2026, 9, 12, 10)).toISOString(), // Saturday, inside the window
        },
      ],
      drafts: [],
      admin_notifications: [],
    })
    const counts = await loadSinceLastHere(supabase, VENUE, WINDOW)
    expect(counts.arrived).toBe(1)
    expect(counts.waiting).toBe(1) // also their latest, and still inbound
  })

  it('does not count a couple whose first-ever message was before the window, even if they wrote in again inside it', async () => {
    const supabase = fakeSupabase({
      couples: [{ id: 'c1', venue_id: VENUE, merged_into_id: null }],
      touchpoints: [
        {
          couple_id: 'c1',
          venue_id: VENUE,
          channel: 'gmail',
          action_type: 'inquiry',
          occurred_at: new Date(etMs(2026, 8, 1, 10)).toISOString(), // long before the window
        },
        {
          couple_id: 'c1',
          venue_id: VENUE,
          channel: 'gmail',
          action_type: 'reply',
          occurred_at: new Date(etMs(2026, 9, 12, 10)).toISOString(), // inside the window, inbound
        },
      ],
      drafts: [],
      admin_notifications: [],
    })
    const counts = await loadSinceLastHere(supabase, VENUE, WINDOW)
    expect(counts.arrived).toBe(0) // not their first-ever message
    expect(counts.waiting).toBe(1) // but their latest is inbound and in-window
  })

  it('does not count a couple as waiting once an outbound message follows their inbound one', async () => {
    const supabase = fakeSupabase({
      couples: [{ id: 'c1', venue_id: VENUE, merged_into_id: null }],
      touchpoints: [
        {
          couple_id: 'c1',
          venue_id: VENUE,
          channel: 'gmail',
          action_type: 'inquiry',
          occurred_at: new Date(etMs(2026, 9, 12, 10)).toISOString(),
        },
        {
          couple_id: 'c1',
          venue_id: VENUE,
          channel: 'gmail',
          action_type: 'sent', // not in the inbound set -> treated as outbound
          occurred_at: new Date(etMs(2026, 9, 12, 11)).toISOString(),
        },
      ],
      drafts: [],
      admin_notifications: [],
    })
    const counts = await loadSinceLastHere(supabase, VENUE, WINDOW)
    expect(counts.arrived).toBe(1) // first message still landed in the window
    expect(counts.waiting).toBe(0) // but something has gone back since
  })

  it('excludes a couple merged away, even if their old touchpoints are in the window', async () => {
    const supabase = fakeSupabase({
      couples: [{ id: 'c2', venue_id: VENUE, merged_into_id: 'c1' }], // merged away
      touchpoints: [
        {
          couple_id: 'c2',
          venue_id: VENUE,
          channel: 'gmail',
          action_type: 'inquiry',
          occurred_at: new Date(etMs(2026, 9, 12, 10)).toISOString(),
        },
      ],
      drafts: [],
      admin_notifications: [],
    })
    const counts = await loadSinceLastHere(supabase, VENUE, WINDOW)
    expect(counts.arrived).toBe(0)
    expect(counts.waiting).toBe(0)
  })

  it('counts auto-sent drafts by status + provenance + sent_at in the window, not created_at', async () => {
    const supabase = fakeSupabase({
      couples: [],
      touchpoints: [],
      drafts: [
        {
          id: 'd1',
          venue_id: VENUE,
          status: 'sent',
          auto_sent: true,
          sent_at: new Date(etMs(2026, 9, 12, 10)).toISOString(), // in window
        },
        {
          id: 'd2',
          venue_id: VENUE,
          status: 'sent',
          auto_sent: false, // a coordinator's own send — not counted
          sent_at: new Date(etMs(2026, 9, 12, 10)).toISOString(),
        },
        {
          id: 'd3',
          venue_id: VENUE,
          status: 'approved', // never sent
          auto_sent: true,
          sent_at: null,
        },
        {
          id: 'd4',
          venue_id: VENUE,
          status: 'sent',
          auto_sent: true,
          sent_at: new Date(etMs(2026, 8, 1, 10)).toISOString(), // sent well before the window
        },
      ],
      admin_notifications: [],
    })
    const counts = await loadSinceLastHere(supabase, VENUE, WINDOW)
    expect(counts.autoSent).toBe(1)
  })

  it('counts send failures from admin_notifications, windowed on created_at', async () => {
    const supabase = fakeSupabase({
      couples: [],
      touchpoints: [],
      drafts: [],
      admin_notifications: [
        {
          id: 'n1',
          venue_id: VENUE,
          type: 'auto_send_failed',
          created_at: new Date(etMs(2026, 9, 12, 10)).toISOString(),
        },
        {
          id: 'n2',
          venue_id: VENUE,
          type: 'other_type', // not a send failure
          created_at: new Date(etMs(2026, 9, 12, 10)).toISOString(),
        },
        {
          id: 'n3',
          venue_id: VENUE,
          type: 'auto_send_failed',
          created_at: new Date(etMs(2026, 8, 1, 10)).toISOString(), // outside the window
        },
      ],
    })
    const counts = await loadSinceLastHere(supabase, VENUE, WINDOW)
    expect(counts.failed).toBe(1)
  })

  it('is honest-empty for a missing venueId, with no query at all', async () => {
    const counts = await loadSinceLastHere(fakeSupabase({}), '', WINDOW)
    expect(counts).toMatchObject({ arrived: 0, autoSent: 0, waiting: 0, failed: 0 })
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3. buildSinceLastHereStrip — pure display layer
// ─────────────────────────────────────────────────────────────────────

function makeCounts(overrides: Partial<SinceLastHereCounts> = {}): SinceLastHereCounts {
  return {
    arrived: 0,
    autoSent: 0,
    waiting: 0,
    failed: 0,
    window: WINDOW,
    generatedAt: '2026-09-14T13:00:00.000Z',
    ...overrides,
  }
}

describe('buildSinceLastHereStrip', () => {
  it('gives every item a rule, a source and a link, so no count is unexplained', () => {
    const strip = buildSinceLastHereStrip(makeCounts({ arrived: 12, autoSent: 9, waiting: 3, failed: 0 }))
    expect(strip.items).toHaveLength(4)
    for (const item of strip.items) {
      expect(item.rule.length).toBeGreaterThan(10)
      expect(item.source.length).toBeGreaterThan(10)
      expect(item.href.startsWith('/')).toBe(true)
    }
  })

  it('carries the counts straight from the reader, not a local recompute', () => {
    const strip = buildSinceLastHereStrip(makeCounts({ arrived: 12, autoSent: 9, waiting: 3, failed: 0 }))
    const byKey = Object.fromEntries(strip.items.map((i) => [i.key, i.count]))
    expect(byKey).toEqual({ arrived: 12, autoSent: 9, waiting: 3, failed: 0 })
  })

  it('flags an all-zero window so the strip can say something rather than draw four zeroes', () => {
    expect(buildSinceLastHereStrip(makeCounts()).allZero).toBe(true)
    expect(buildSinceLastHereStrip(makeCounts({ failed: 1 })).allZero).toBe(false)
  })

  it('passes the window label straight through for the strip header', () => {
    const strip = buildSinceLastHereStrip(makeCounts())
    expect(strip.windowLabel).toBe(WINDOW.label)
  })
})
