/**
 * W15 tool source: follow-up state + follow-up proposals.
 *
 * Supabase is a predicate-filtering fake and the inquiry brain is mocked,
 * so nothing here touches a database or the Anthropic API. The fake has
 * no `insert` at all, which is the point: if either tool ever tried to
 * write a draft the call would throw rather than pass quietly.
 *
 * What is locked:
 *   - a couple already followed up with is reported as such, with the
 *     path and the date, and is skipped by the proposer;
 *   - an in-flight post-tour sequence blocks a fresh draft and names the
 *     step the cron will send next;
 *   - proposals carry the couple name in the text and the ids alongside;
 *   - the list is capped and says when it was capped;
 *   - the brain is called once per drafted couple and never for a
 *     suppressed one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolSourceDeps } from '../types'

// --- mocked inquiry brain ---------------------------------------------------
// The only AI call on this path. bulk-follow-up.ts imports exactly these
// two names from the module, so the factory can be this small. Hoisted
// because the static imports below load the mocked module before any
// plain top-level const would have been assigned.
interface FakeFollowUpOptions {
  venueId: string
  weddingId: string
  contactEmail: string
  daysSinceLastContact: number
  recordPhraseUsage?: boolean
}
interface FakeDraftResult {
  draft: string
  confidence: number
  tokensUsed: number
  cost: number
}

const { mockGenerateFollowUp } = vi.hoisted(() => ({
  mockGenerateFollowUp: vi.fn<(opts: FakeFollowUpOptions) => Promise<FakeDraftResult>>(),
}))

vi.mock('@/lib/services/brain/inquiry', () => ({
  generateFollowUp: mockGenerateFollowUp,
  BRAIN_PROMPT_VERSION: 'inquiry.test.v1',
}))

import {
  followUpStateSource,
  proposeFollowUpsSource,
  FOLLOW_UP_COUPLE_CAP,
  TOOL_GET_FOLLOW_UP_STATE,
  TOOL_PROPOSE_FOLLOW_UPS,
} from '../follow-ups'
import { TOOL_SOURCES } from '../index'
import { loadFollowUpState } from '@/lib/services/cohort/bulk-follow-up'

// ---------------------------------------------------------------------------
// Fake Supabase: predicates only, no writes
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function makeMockClient(fixtures: Record<string, Row[]>) {
  return {
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      let orderCol: string | null = null
      let orderAsc = true
      let lim: number | null = null

      function resolve() {
        let rows = (fixtures[table] ?? []).filter((r) => preds.every((p) => p(r)))
        if (orderCol) {
          const col = orderCol
          rows = [...rows].sort((a, b) => {
            const av = String(a[col] ?? '')
            const bv = String(b[col] ?? '')
            if (av === bv) return 0
            return orderAsc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1
          })
        }
        if (lim !== null) rows = rows.slice(0, lim)
        return { data: rows, error: null }
      }

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => {
          preds.push((r) => r[c] === v)
          return builder
        },
        in: (c: string, vs: unknown[]) => {
          preds.push((r) => vs.includes(r[c]))
          return builder
        },
        is: (c: string, v: unknown) => {
          preds.push((r) => (r[c] ?? null) === v)
          return builder
        },
        not: (c: string, _op: string, v: unknown) => {
          preds.push((r) => (r[c] ?? null) !== v)
          return builder
        },
        gte: (c: string, v: unknown) => {
          preds.push((r) => String(r[c] ?? '') >= String(v))
          return builder
        },
        order: (c: string, opts?: { ascending?: boolean }) => {
          orderCol = c
          orderAsc = opts?.ascending !== false
          return builder
        },
        limit: (n: number) => {
          lim = n
          return builder
        },
        then: (onResolve: (v: unknown) => unknown, onReject?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(onResolve, onReject),
      }
      return builder
    },
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VENUE = 'venue-1'
const TODAY = '2026-09-09'

/** Anya & Brian: toured, nothing sent, clear to draft. */
const COUPLE_A = 'couple-a'
const WEDDING_A = 'wedding-a'
/** Caitlin & Caleb: Sage already sent a follow-up three days ago. */
const COUPLE_B = 'couple-b'
const WEDDING_B = 'wedding-b'
/** Tara & Brent: post-tour sequence still running. */
const COUPLE_C = 'couple-c'
const WEDDING_C = 'wedding-c'

function baseFixtures(): Record<string, Row[]> {
  return {
    couples: [
      {
        id: COUPLE_A,
        venue_id: VENUE,
        merged_into_id: null,
        primary_contact_name: 'Anya',
        partner_contact_name: 'Brian',
        primary_contact_email: 'anya@example.com',
        partner_contact_email: null,
        lifecycle_state: 'resolved',
        source_wedding_id: WEDDING_A,
      },
      {
        id: COUPLE_B,
        venue_id: VENUE,
        merged_into_id: null,
        primary_contact_name: 'Caitlin',
        partner_contact_name: 'Caleb',
        primary_contact_email: 'caitlin@example.com',
        partner_contact_email: null,
        lifecycle_state: 'resolved',
        source_wedding_id: WEDDING_B,
      },
      {
        id: COUPLE_C,
        venue_id: VENUE,
        merged_into_id: null,
        primary_contact_name: 'Tara',
        partner_contact_name: 'Brent',
        primary_contact_email: 'tara@example.com',
        partner_contact_email: null,
        lifecycle_state: 'resolved',
        source_wedding_id: WEDDING_C,
      },
    ],
    touchpoints: [
      {
        couple_id: COUPLE_A,
        venue_id: VENUE,
        channel: 'gmail',
        action_type: 'reply',
        direction: 'inbound',
        occurred_at: '2026-09-05T14:00:00.000Z',
      },
      {
        couple_id: COUPLE_A,
        venue_id: VENUE,
        channel: 'calendly',
        action_type: 'tour_attended',
        direction: 'inbound',
        occurred_at: '2026-09-01T14:00:00.000Z',
      },
      {
        couple_id: COUPLE_B,
        venue_id: VENUE,
        channel: 'gmail',
        action_type: 'reply',
        direction: 'inbound',
        occurred_at: '2026-09-04T09:00:00.000Z',
      },
      {
        couple_id: COUPLE_C,
        venue_id: VENUE,
        channel: 'knot',
        action_type: 'inquiry',
        direction: null, // written before migration 381 stamped direction
        occurred_at: '2026-08-20T09:00:00.000Z',
      },
    ],
    weddings: [
      { id: WEDDING_A, venue_id: VENUE, status: 'inquiry', ai_opted_out: null, lost_locked_by_operator: null },
      { id: WEDDING_B, venue_id: VENUE, status: 'inquiry', ai_opted_out: null, lost_locked_by_operator: null },
      { id: WEDDING_C, venue_id: VENUE, status: 'inquiry', ai_opted_out: null, lost_locked_by_operator: null },
    ],
    drafts: [
      {
        wedding_id: WEDDING_B,
        venue_id: VENUE,
        status: 'sent',
        follow_up_step: 'operator_initiated_cohort',
        sent_at: '2026-09-06T15:00:00.000Z',
      },
    ],
    // venue_id is NOT NULL on both of these tables (migrations 001 and 376),
    // and loadFollowUpState now filters on it. The fixtures carried only a
    // wedding_id, which made them the one shape the real database cannot
    // hold. 2026-09-14 review, item 8.
    post_tour_sequence: [
      {
        venue_id: VENUE,
        wedding_id: WEDDING_C,
        paused_at: null,
        sequence_completed_at: null,
        email_1_sent_at: '2026-09-07T12:00:00.000Z',
        email_2_sent_at: null,
        email_3_sent_at: null,
      },
    ],
    interactions: [],
    people: [
      { venue_id: VENUE, wedding_id: WEDDING_A, email: 'anya@example.com', first_name: 'Anya', last_name: 'Petrov' },
      { venue_id: VENUE, wedding_id: WEDDING_B, email: 'caitlin@example.com', first_name: 'Caitlin', last_name: 'Reed' },
      { venue_id: VENUE, wedding_id: WEDDING_C, email: 'tara@example.com', first_name: 'Tara', last_name: 'Hill' },
    ],
  }
}

function depsFor(fixtures: Record<string, Row[]>): ToolSourceDeps {
  return {
    supabase: makeMockClient(fixtures) as unknown as SupabaseClient,
    today: TODAY,
  }
}

// Shapes the tools return. Narrow enough to assert against without
// pretending the whole payload is typed.
interface StateResult {
  requested: number
  returned: number
  capped: boolean
  capNote?: string
  notFound: string[]
  couples: Array<{
    coupleId: string
    names: string | null
    weddingId: string | null
    followUpAlreadySent: boolean
    followUpPath: string | null
    followUpSentAt: string | null
    sequenceRunning: boolean
    sequenceNextStep: string | null
    lastInbound: { at: string; channel: string | null } | null
    lastInboundNote: string | null
    clearToDraft: boolean
    blockedBy: { reason: string; detail: string } | null
  }>
}

interface ProposeResult {
  requested: number
  proposed: number
  skipped: number
  failed: number
  capped: boolean
  writes: string
  summary: string
  proposals: Array<{
    label: string
    coupleId: string
    weddingId: string
    names: string | null
    toEmail: string
    subject: string
    body: string
    daysSinceLastContact: number
    daysSinceLastContactSource: string
  }>
  skippedCouples: Array<{ coupleId: string; names: string | null; reason: string; detail: string }>
  failedCouples: Array<{ coupleId: string; reason: string }>
  confirmRoute: { method: string; path: string }
}

beforeEach(() => {
  mockGenerateFollowUp.mockReset()
  mockGenerateFollowUp.mockImplementation(async (opts: FakeFollowUpOptions) => ({
    draft: `Hi there, following up after ${opts.daysSinceLastContact} days (${opts.contactEmail}).`,
    confidence: 0.82,
    tokensUsed: 500,
    cost: 0.004,
  }))
})

// ---------------------------------------------------------------------------
// Registration + schema discipline
// ---------------------------------------------------------------------------

describe('registration', () => {
  it('registers both tools in TOOL_SOURCES', () => {
    const names = TOOL_SOURCES.map((s) => s.tool.name)
    expect(names).toContain(TOOL_GET_FOLLOW_UP_STATE)
    expect(names).toContain(TOOL_PROPOSE_FOLLOW_UPS)
  })

  it('never puts venue_id in a tool schema', () => {
    for (const source of [followUpStateSource, proposeFollowUpsSource]) {
      const props = source.tool.input_schema.properties as Record<string, unknown>
      expect(Object.keys(props)).toEqual(['couple_ids'])
    }
  })

  it('claims the two battery questions it is meant to answer', () => {
    expect(followUpStateSource.batteryQuestions).toContain('Q37')
    expect(proposeFollowUpsSource.batteryQuestions).toContain('Q34')
  })
})

// ---------------------------------------------------------------------------
// get_follow_up_state
// ---------------------------------------------------------------------------

describe('get_follow_up_state', () => {
  it('reports who has already been followed up with, when and by which path', async () => {
    const result = (await followUpStateSource.run(
      VENUE,
      { couple_ids: [COUPLE_A, COUPLE_B, COUPLE_C] },
      depsFor(baseFixtures()),
    )) as StateResult

    expect(result.returned).toBe(3)
    const byId = new Map(result.couples.map((c) => [c.coupleId, c]))

    const anya = byId.get(COUPLE_A)!
    expect(anya.names).toBe('Anya & Brian')
    expect(anya.followUpAlreadySent).toBe(false)
    expect(anya.clearToDraft).toBe(true)
    expect(anya.blockedBy).toBeNull()
    expect(anya.lastInbound?.at).toBe('2026-09-05T14:00:00.000Z')

    const caitlin = byId.get(COUPLE_B)!
    expect(caitlin.followUpAlreadySent).toBe(true)
    expect(caitlin.followUpPath).toBe('sage_follow_up_draft')
    expect(caitlin.followUpSentAt).toBe('2026-09-06T15:00:00.000Z')
    expect(caitlin.clearToDraft).toBe(false)
    expect(caitlin.blockedBy?.reason).toBe('recent_follow_up_sent')

    const tara = byId.get(COUPLE_C)!
    expect(tara.sequenceRunning).toBe(true)
    expect(tara.sequenceNextStep).toContain('email_2')
    expect(tara.followUpPath).toBe('post_tour_sequence')
    expect(tara.clearToDraft).toBe(false)
  })

  it('says the direction was never stamped rather than guessing an inbound', async () => {
    const result = (await followUpStateSource.run(
      VENUE,
      { couple_ids: [COUPLE_C] },
      depsFor(baseFixtures()),
    )) as StateResult
    expect(result.couples[0].lastInbound).toBeNull()
    expect(result.couples[0].lastInboundNote).toContain('direction=inbound')
  })

  it('caps the list and says so', async () => {
    const fixtures = baseFixtures()
    const ids: string[] = []
    for (let i = 0; i < FOLLOW_UP_COUPLE_CAP + 2; i += 1) {
      const id = `bulk-${i}`
      ids.push(id)
      fixtures.couples.push({
        id,
        venue_id: VENUE,
        merged_into_id: null,
        primary_contact_name: `Couple ${i}`,
        partner_contact_name: null,
        primary_contact_email: `c${i}@example.com`,
        partner_contact_email: null,
        lifecycle_state: 'resolved',
        source_wedding_id: `w-${i}`,
      })
      fixtures.weddings.push({
        id: `w-${i}`,
        venue_id: VENUE,
        status: 'inquiry',
        ai_opted_out: null,
        lost_locked_by_operator: null,
      })
    }

    const result = (await followUpStateSource.run(
      VENUE,
      { couple_ids: ids },
      depsFor(fixtures),
    )) as StateResult

    expect(result.requested).toBe(FOLLOW_UP_COUPLE_CAP + 2)
    expect(result.returned).toBe(FOLLOW_UP_COUPLE_CAP)
    expect(result.capped).toBe(true)
    expect(result.capNote).toContain(String(FOLLOW_UP_COUPLE_CAP))
  })

  it('names ids it could not find instead of dropping them', async () => {
    const result = (await followUpStateSource.run(
      VENUE,
      { couple_ids: [COUPLE_A, 'nobody'] },
      depsFor(baseFixtures()),
    )) as StateResult
    expect(result.notFound).toEqual(['nobody'])
    expect(result.returned).toBe(1)
  })

  it('refuses an empty id list rather than answering about the whole venue', async () => {
    const result = (await followUpStateSource.run(VENUE, { couple_ids: [] }, depsFor(baseFixtures()))) as {
      error?: string
    }
    expect(result.error).toContain('couple_ids is required')
  })

  it('does not reach another venue for a couple id it was handed', async () => {
    const fixtures = baseFixtures()
    fixtures.couples.push({
      id: 'other-venue-couple',
      venue_id: 'venue-2',
      merged_into_id: null,
      primary_contact_name: 'Someone',
      partner_contact_name: 'Else',
      primary_contact_email: 'someone@example.com',
      partner_contact_email: null,
      lifecycle_state: 'resolved',
      source_wedding_id: 'wedding-other',
    })
    const result = (await followUpStateSource.run(
      VENUE,
      { couple_ids: ['other-venue-couple'] },
      depsFor(fixtures),
    )) as StateResult
    expect(result.returned).toBe(0)
    expect(result.notFound).toEqual(['other-venue-couple'])
  })
})

// ---------------------------------------------------------------------------
// propose_follow_ups
// ---------------------------------------------------------------------------

describe('propose_follow_ups', () => {
  it('drafts for the clear couple, skips the two already handled, and writes nothing', async () => {
    const fixtures = baseFixtures()
    const result = (await proposeFollowUpsSource.run(
      VENUE,
      { couple_ids: [COUPLE_A, COUPLE_B, COUPLE_C] },
      depsFor(fixtures),
    )) as ProposeResult

    expect(result.proposed).toBe(1)
    expect(result.skipped).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.writes).toBe('none')

    // One brain call, for the one couple that was clear.
    expect(mockGenerateFollowUp).toHaveBeenCalledTimes(1)
    expect(mockGenerateFollowUp.mock.calls[0][0].weddingId).toBe(WEDDING_A)
    expect(mockGenerateFollowUp.mock.calls[0][0].daysSinceLastContact).toBe(3)

    // W34: a read tool must not write a ledger. propose_follow_ups composes
    // through the same brain call as the write path, so the only thing
    // that can stop the phrase_usage row is the flag threaded down to
    // selectPhrase via composeFollowUpDraft -> generateFollowUp.
    expect(mockGenerateFollowUp.mock.calls[0][0].recordPhraseUsage).toBe(false)

    // No draft row was created. The fake has no insert, so the only way
    // this count could change is a write the tool is not allowed to make.
    expect(fixtures.drafts).toHaveLength(1)

    const reasons = result.skippedCouples.map((s) => s.reason).sort()
    expect(reasons).toEqual(['in_post_tour_sequence', 'recent_follow_up_sent'])
  })

  it('puts the couple name in the text and the ids alongside', async () => {
    const result = (await proposeFollowUpsSource.run(
      VENUE,
      { couple_ids: [COUPLE_A] },
      depsFor(baseFixtures()),
    )) as ProposeResult

    const proposal = result.proposals[0]
    expect(proposal.label).toBe('Anya & Brian')
    expect(proposal.coupleId).toBe(COUPLE_A)
    expect(proposal.weddingId).toBe(WEDDING_A)
    expect(proposal.toEmail).toBe('anya@example.com')
    expect(proposal.subject).toBe('Following up on your inquiry')
    expect(proposal.body).toContain('following up after 3 days')
    expect(proposal.daysSinceLastContactSource).toBe('last_inbound_touchpoint')
    expect(result.summary).toContain('Anya & Brian')
    expect(result.summary).not.toContain(COUPLE_A)
  })

  it('hands back the route the operator confirmation would call', async () => {
    const result = (await proposeFollowUpsSource.run(
      VENUE,
      { couple_ids: [COUPLE_A] },
      depsFor(baseFixtures()),
    )) as ProposeResult
    expect(result.confirmRoute.method).toBe('POST')
    expect(result.confirmRoute.path).toBe('/api/agent/cohort')
  })

  it('skips a couple with no address instead of drafting to nobody', async () => {
    const fixtures = baseFixtures()
    ;(fixtures.couples[0] as Row).primary_contact_email = null
    fixtures.people = fixtures.people.filter((p) => p.wedding_id !== WEDDING_A)

    const result = (await proposeFollowUpsSource.run(
      VENUE,
      { couple_ids: [COUPLE_A] },
      depsFor(fixtures),
    )) as ProposeResult

    expect(result.proposed).toBe(0)
    expect(result.skippedCouples[0].reason).toBe('no_contact_email')
    expect(result.skippedCouples[0].detail).toContain('Anya & Brian')
    expect(mockGenerateFollowUp).not.toHaveBeenCalled()
  })

  it('skips a couple with no wedding record behind them', async () => {
    const fixtures = baseFixtures()
    ;(fixtures.couples[0] as Row).source_wedding_id = null

    const result = (await proposeFollowUpsSource.run(
      VENUE,
      { couple_ids: [COUPLE_A] },
      depsFor(fixtures),
    )) as ProposeResult

    expect(result.proposed).toBe(0)
    expect(result.skippedCouples[0].reason).toBe('no_wedding_record')
    expect(mockGenerateFollowUp).not.toHaveBeenCalled()
  })

  it('reports a brain failure as a failure rather than a silent drop', async () => {
    mockGenerateFollowUp.mockRejectedValueOnce(new Error('anthropic 529'))
    const result = (await proposeFollowUpsSource.run(
      VENUE,
      { couple_ids: [COUPLE_A] },
      depsFor(baseFixtures()),
    )) as ProposeResult
    expect(result.proposed).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.failedCouples[0].reason).toContain('529')
  })

  it('treats an empty draft as a failure, not as a draft', async () => {
    mockGenerateFollowUp.mockResolvedValueOnce({
      draft: '   ',
      confidence: 0.1,
      tokensUsed: 10,
      cost: 0,
    })
    const result = (await proposeFollowUpsSource.run(
      VENUE,
      { couple_ids: [COUPLE_A] },
      depsFor(baseFixtures()),
    )) as ProposeResult
    expect(result.proposed).toBe(0)
    expect(result.failedCouples[0].reason).toBe('brain returned empty draft')
  })
})

// ---------------------------------------------------------------------------
// loadFollowUpState: the half split out of the write path
// ---------------------------------------------------------------------------

describe('loadFollowUpState', () => {
  const NOW = Date.parse('2026-09-09T00:00:00.000Z')

  it('reports the first blocking reason in the drafter order', async () => {
    const fixtures = baseFixtures()
    // Caitlin has a recent follow-up AND an AI opt-out. The opt-out is
    // checked first, so that is the reason the operator is shown.
    ;(fixtures.weddings[1] as Row).ai_opted_out = true

    const client = makeMockClient(fixtures) as unknown as SupabaseClient
    const state = await loadFollowUpState(client, VENUE, [WEDDING_A, WEDDING_B], NOW)

    expect(state.get(WEDDING_A)?.suppression).toBeNull()
    expect(state.get(WEDDING_B)?.suppression?.reason).toBe('ai_opted_out')
    // The underlying facts are still there for a caller that wants them.
    expect(state.get(WEDDING_B)?.lastFollowUpSentAt).toBe('2026-09-06T15:00:00.000Z')
  })

  it('marks a wedding id with no row as not found rather than clear to draft', async () => {
    const client = makeMockClient(baseFixtures()) as unknown as SupabaseClient
    const state = await loadFollowUpState(client, VENUE, ['ghost-wedding'], NOW)
    expect(state.get('ghost-wedding')?.found).toBe(false)
  })

  it('blocks on an operator-authored outbound inside the window', async () => {
    const fixtures = baseFixtures()
    fixtures.interactions = [
      {
        wedding_id: WEDDING_A,
        venue_id: VENUE,
        direction: 'outbound',
        author_class: 'operator',
        timestamp: '2026-09-08T10:00:00.000Z',
      },
    ]
    const client = makeMockClient(fixtures) as unknown as SupabaseClient
    const state = await loadFollowUpState(client, VENUE, [WEDDING_A], NOW)
    expect(state.get(WEDDING_A)?.suppression?.reason).toBe('recent_operator_outbound')
  })
})
