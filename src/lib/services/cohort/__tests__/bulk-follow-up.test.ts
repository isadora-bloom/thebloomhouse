/**
 * composeFollowUpDraft / bulkDraftFollowUps: recordPhraseUsage threading
 * (NOVEMBER-PLAN.md wave 4, W34).
 *
 * `selectPhrase` (src/lib/ai/__tests__/phrase-selector.test.ts) proves the
 * `record` flag itself controls the `phrase_usage` insert. This file
 * proves the flag actually reaches selectPhrase from both callers of
 * composeFollowUpDraft:
 *
 *   - propose_follow_ups (the tool source) passes recordPhraseUsage: false
 *     and that must reach generateFollowUp.
 *   - bulkDraftFollowUps (the write path, drafts get saved for real) does
 *     not pass it at all, and must still resolve to true — unchanged
 *     behaviour, the ledger keeps being written.
 *
 * The inquiry brain and the Supabase client are both mocked; this is a
 * wiring test, not an end-to-end brain test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeFollowUpOptions {
  venueId: string
  weddingId: string
  contactEmail: string
  daysSinceLastContact: number
  recordPhraseUsage?: boolean
}

const { mockGenerateFollowUp, mockCreateServiceClient } = vi.hoisted(() => ({
  mockGenerateFollowUp: vi.fn(),
  mockCreateServiceClient: vi.fn(),
}))

vi.mock('@/lib/services/brain/inquiry', () => ({
  generateFollowUp: mockGenerateFollowUp,
  BRAIN_PROMPT_VERSION: 'inquiry.test.v1',
}))

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: mockCreateServiceClient,
}))

import { composeFollowUpDraft, bulkDraftFollowUps } from '../bulk-follow-up'

type Row = Record<string, unknown>

/** Same predicate-filtering fake shape as the tool-source tests, plus an
 *  `insert` that records into the given sink so bulkDraftFollowUps' draft
 *  write can be asserted on. */
function makeFakeClient(fixtures: Record<string, Row[]>, insertedDrafts: Row[]) {
  return {
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      chain.select = () => chain
      chain.eq = (c: string, v: unknown) => {
        preds.push((r) => r[c] === v)
        return chain
      }
      chain.in = (c: string, vs: unknown[]) => {
        preds.push((r) => vs.includes(r[c]))
        return chain
      }
      chain.not = () => chain
      chain.gte = () => chain
      chain.order = () => chain
      chain.insert = (row: Row) => {
        const inserted = { id: `draft-${insertedDrafts.length + 1}`, ...row }
        insertedDrafts.push(inserted)
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: inserted.id }, error: null }),
          }),
        }
      }
      chain.then = (onFulfilled: (v: unknown) => unknown) => {
        const rows = (fixtures[table] ?? []).filter((r) => preds.every((p) => p(r)))
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled)
      }
      return chain
    },
  }
}

const VENUE = 'venue-1'
const WEDDING = 'wedding-clear'

function baseFixtures(): Record<string, Row[]> {
  return {
    weddings: [{ id: WEDDING, venue_id: VENUE, status: 'inquiry', ai_opted_out: null, lost_locked_by_operator: null }],
    drafts: [],
    post_tour_sequence: [],
    interactions: [
      { wedding_id: WEDDING, venue_id: VENUE, direction: 'inbound', timestamp: '2026-09-05T00:00:00.000Z', from_email: 'anya@example.com' },
    ],
    people: [{ wedding_id: WEDDING, email: 'anya@example.com', first_name: 'Anya', last_name: 'Petrov' }],
  }
}

beforeEach(() => {
  mockGenerateFollowUp.mockReset()
  mockGenerateFollowUp.mockImplementation(async (_opts: FakeFollowUpOptions) => ({
    draft: 'Hi there, following up.',
    confidence: 0.8,
    tokensUsed: 400,
    cost: 0.003,
  }))
  mockCreateServiceClient.mockReset()
})

describe('composeFollowUpDraft recordPhraseUsage', () => {
  it('defaults to true when the caller does not pass it', async () => {
    await composeFollowUpDraft({
      venueId: VENUE,
      weddingId: WEDDING,
      contactEmail: 'anya@example.com',
      daysSinceLastContact: 3,
    })
    expect(mockGenerateFollowUp).toHaveBeenCalledTimes(1)
    expect(mockGenerateFollowUp.mock.calls[0][0].recordPhraseUsage).toBe(true)
  })

  it('forwards recordPhraseUsage: false through to generateFollowUp', async () => {
    await composeFollowUpDraft({
      venueId: VENUE,
      weddingId: WEDDING,
      contactEmail: 'anya@example.com',
      daysSinceLastContact: 3,
      recordPhraseUsage: false,
    })
    expect(mockGenerateFollowUp).toHaveBeenCalledTimes(1)
    expect(mockGenerateFollowUp.mock.calls[0][0].recordPhraseUsage).toBe(false)
  })
})

describe('bulkDraftFollowUps (write path)', () => {
  it('drafts a wedding and calls the brain with recordPhraseUsage true, unchanged from before W34', async () => {
    const insertedDrafts: Row[] = []
    const fixtures = baseFixtures()
    mockCreateServiceClient.mockReturnValue(makeFakeClient(fixtures, insertedDrafts))

    const result = await bulkDraftFollowUps({ venueId: VENUE, weddingIds: [WEDDING] })

    expect(result.drafted).toHaveLength(1)
    expect(result.drafted[0].weddingId).toBe(WEDDING)
    expect(insertedDrafts).toHaveLength(1)

    expect(mockGenerateFollowUp).toHaveBeenCalledTimes(1)
    expect(mockGenerateFollowUp.mock.calls[0][0].recordPhraseUsage).toBe(true)
  })
})
