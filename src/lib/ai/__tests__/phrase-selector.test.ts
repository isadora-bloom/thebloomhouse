/**
 * `selectPhrase` record option (NOVEMBER-PLAN.md wave 4, W34).
 *
 * `propose_follow_ups` (src/lib/intel/tool-sources/follow-ups.ts) composes
 * a draft through the inquiry brain purely to SHOW the operator a
 * proposal. Before this fix that still wrote a `phrase_usage` row, which
 * is a read tool writing a ledger. `record: false` is the escape hatch;
 * every other caller keeps recording because it never passes the option
 * (default true).
 *
 * `createServiceClient` is mocked with a tiny in-memory fake so this test
 * never touches the network. The fake only implements what selectPhrase
 * calls: `.from('venues')...maybeSingle()`, `.from('venues')...` (org
 * scoping), `.from('phrase_usage').select(...)` and
 * `.from('phrase_usage').insert(...)`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreateServiceClient, insertedRows } = vi.hoisted(() => ({
  mockCreateServiceClient: vi.fn(),
  insertedRows: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: mockCreateServiceClient,
}))

import { selectPhrase } from '../phrase-selector'

function makeFakeClient() {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gte: () => chain,
        insert: (row: Record<string, unknown>) => {
          if (table === 'phrase_usage') insertedRows.push(row)
          return Promise.resolve({ error: null })
        },
        maybeSingle: () => {
          if (table === 'venues') return Promise.resolve({ data: { org_id: null } })
          return Promise.resolve({ data: null })
        },
        then: (onFulfilled: (v: unknown) => unknown) => {
          // venues (org lookup) and phrase_usage (used-recently read) both
          // resolve here when awaited directly rather than via .maybeSingle().
          if (table === 'venues') return Promise.resolve({ data: [] }).then(onFulfilled)
          return Promise.resolve({ data: [], error: null }).then(onFulfilled)
        },
      }
      return chain
    },
  }
}

beforeEach(() => {
  insertedRows.length = 0
  mockCreateServiceClient.mockReset()
  mockCreateServiceClient.mockReturnValue(makeFakeClient())
})

describe('selectPhrase record option', () => {
  it('records a phrase_usage row by default (every existing caller unchanged)', async () => {
    const phrase = await selectPhrase({
      venueId: 'venue-1',
      contactEmail: 'anya@example.com',
      category: 'follow_up_opener',
      style: 'warm',
    })
    expect(phrase.length).toBeGreaterThan(0)
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0]).toMatchObject({
      contact_email: 'anya@example.com',
      phrase_category: 'follow_up_opener',
      venue_id: 'venue-1',
    })
  })

  it('records nothing when record: false', async () => {
    const phrase = await selectPhrase({
      venueId: 'venue-1',
      contactEmail: 'anya@example.com',
      category: 'follow_up_opener',
      style: 'warm',
      record: false,
    })
    expect(phrase.length).toBeGreaterThan(0)
    expect(insertedRows).toHaveLength(0)
  })
})
