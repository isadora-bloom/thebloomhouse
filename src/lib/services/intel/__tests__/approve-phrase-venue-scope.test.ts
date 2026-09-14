/**
 * Approving a review phrase is a venue-scoped write.
 * 2026-09-14 security review, item 8.
 *
 * `approved_for_sage` is not an inert flag: `getReviewVocabulary` reads it
 * and feeds the phrase into that venue's Sage prompt as language to weave
 * into replies. The update used to match on the phrase id alone, so any
 * signed-in coordinator holding an id could put words in another venue's
 * assistant's mouth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Recorded {
  table: string
  payload: Record<string, unknown>
  filters: Array<[string, unknown]>
}

let recorded: Recorded | null = null
let matchedRows: Array<{ id: string }> = []

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => {
        recorded = { table, payload, filters: [] }
        const builder: Record<string, unknown> = {}
        builder.eq = (col: string, val: unknown) => {
          recorded!.filters.push([col, val])
          return builder
        }
        builder.select = async () => ({ data: matchedRows, error: null })
        return builder
      },
    }),
  }),
}))

import {
  approvePhraseForSage,
  approvePhraseForMarketing,
} from '@/lib/services/intel/review-language'

const VENUE = '99999999-9999-4999-8999-999999999999'
const OTHER_VENUE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PHRASE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

beforeEach(() => {
  recorded = null
  matchedRows = [{ id: PHRASE }]
})

describe('approvePhraseForSage', () => {
  it('filters on the venue as well as the phrase id', async () => {
    await approvePhraseForSage(VENUE, PHRASE)
    expect(recorded?.table).toBe('review_language')
    expect(recorded?.payload).toEqual({ approved_for_sage: true })
    expect(recorded?.filters).toEqual([
      ['id', PHRASE],
      ['venue_id', VENUE],
    ])
  })

  it('throws when the phrase belongs to another venue, instead of reporting success', async () => {
    // A PostgREST update that matches nothing returns success with no rows,
    // which is why the no-match case needs its own error: without it a
    // cross-venue attempt and a real approval look identical to the caller.
    matchedRows = []
    await expect(approvePhraseForSage(OTHER_VENUE, PHRASE)).rejects.toThrow(
      /not found for this venue/i,
    )
  })
})

describe('approvePhraseForMarketing', () => {
  it('is scoped the same way', async () => {
    await approvePhraseForMarketing(VENUE, PHRASE)
    expect(recorded?.payload).toEqual({ approved_for_marketing: true })
    expect(recorded?.filters).toEqual([
      ['id', PHRASE],
      ['venue_id', VENUE],
    ])
  })
})
