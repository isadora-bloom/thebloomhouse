/**
 * Unit tests for scoreReviewRow / scheduleReviewScoring (NOVEMBER-PLAN.md
 * W46). extractReviewLanguage is mocked — it already has its own AI-call
 * behaviour to trust; these tests only pin the aggregation (mean sentiment,
 * distinct sorted themes) and the write-back onto the reviews row, plus the
 * fire-and-forget contract of scheduleReviewScoring (never throws, never
 * blocks the caller, logs on failure).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const extractReviewLanguageMock = vi.fn()
vi.mock('@/lib/services/intel/review-language', () => ({
  extractReviewLanguage: (...args: unknown[]) => extractReviewLanguageMock(...args),
}))

const logEventMock = vi.fn()
vi.mock('@/lib/observability/logger', () => ({
  logEvent: (...args: unknown[]) => logEventMock(...args),
}))

import { scoreReviewRow, scheduleReviewScoring } from '@/lib/services/reviews/score'

// ---------------------------------------------------------------------------
// Minimal chainable Supabase stub: .from('reviews').update(payload).eq('id', id)
// resolves to { error: null } and records the call for assertions.
// ---------------------------------------------------------------------------

interface UpdateCall {
  table: string
  payload: unknown
  id: string
}

let updateCalls: UpdateCall[]

function makeFakeSupabase() {
  updateCalls = []
  return {
    from: (table: string) => ({
      update: (payload: unknown) => ({
        eq: (_col: string, id: string) => {
          updateCalls.push({ table, payload, id })
          return Promise.resolve({ data: null, error: null })
        },
      }),
    }),
  } as unknown as Parameters<typeof scoreReviewRow>[0]['supabase']
}

beforeEach(() => {
  extractReviewLanguageMock.mockReset()
  logEventMock.mockReset()
})

describe('scoreReviewRow', () => {
  it('is a no-op for a blank body', async () => {
    const supabase = makeFakeSupabase()
    const result = await scoreReviewRow({
      reviewId: 'r1',
      venueId: 'v1',
      body: '   ',
      supabase,
    })
    expect(result).toEqual({ scored: false, sentimentScore: null, themes: [], phraseCount: 0 })
    expect(extractReviewLanguageMock).not.toHaveBeenCalled()
    expect(updateCalls).toHaveLength(0)
  })

  it('is a no-op when extraction finds nothing notable', async () => {
    extractReviewLanguageMock.mockResolvedValue([])
    const supabase = makeFakeSupabase()
    const result = await scoreReviewRow({
      reviewId: 'r1',
      venueId: 'v1',
      body: 'fine.',
      supabase,
    })
    expect(result.scored).toBe(false)
    expect(updateCalls).toHaveLength(0)
  })

  it('aggregates phrase sentiment into a mean and themes into a distinct sorted list', async () => {
    extractReviewLanguageMock.mockResolvedValue([
      { phrase: 'a', theme: 'space', sentiment: 0.9 },
      { phrase: 'b', theme: 'coordinator', sentiment: 0.5 },
      { phrase: 'c', theme: 'space', sentiment: 0.7 },
    ])
    const supabase = makeFakeSupabase()
    const result = await scoreReviewRow({
      reviewId: 'r1',
      venueId: 'v1',
      body: 'The space was beautiful and the coordinator was great.',
      rating: 5,
      supabase,
    })

    // mean(0.9, 0.5, 0.7) = 0.7
    expect(result).toEqual({
      scored: true,
      sentimentScore: 0.7,
      themes: ['coordinator', 'space'],
      phraseCount: 3,
    })
    expect(extractReviewLanguageMock).toHaveBeenCalledWith(
      'v1',
      'The space was beautiful and the coordinator was great.',
      5,
    )
    expect(updateCalls).toEqual([
      {
        table: 'reviews',
        payload: { sentiment_score: 0.7, themes: ['coordinator', 'space'] },
        id: 'r1',
      },
    ])
  })

  it('rounds the mean sentiment to two decimal places', async () => {
    extractReviewLanguageMock.mockResolvedValue([
      { phrase: 'a', theme: 'space', sentiment: 1 },
      { phrase: 'b', theme: 'space', sentiment: 1 },
      { phrase: 'c', theme: 'space', sentiment: 0.9 },
    ])
    const supabase = makeFakeSupabase()
    const result = await scoreReviewRow({ reviewId: 'r1', venueId: 'v1', body: 'x', supabase })
    // mean(1, 1, 0.9) = 0.9666... -> rounds to 0.97
    expect(result.sentimentScore).toBe(0.97)
  })
})

describe('scheduleReviewScoring', () => {
  it('never throws synchronously, even when scoring later rejects', () => {
    extractReviewLanguageMock.mockRejectedValue(new Error('AI call failed'))
    const supabase = makeFakeSupabase()
    expect(() =>
      scheduleReviewScoring({ reviewId: 'r1', venueId: 'v1', body: 'great venue', supabase }),
    ).not.toThrow()
  })

  it('logs a structured failure event when scoring rejects, without throwing', async () => {
    extractReviewLanguageMock.mockRejectedValue(new Error('AI call failed'))
    const supabase = makeFakeSupabase()
    scheduleReviewScoring({ reviewId: 'r1', venueId: 'v1', body: 'great venue', supabase })

    // Fire-and-forget: let the microtask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(logEventMock).toHaveBeenCalledTimes(1)
    const [event] = logEventMock.mock.calls[0]
    expect(event).toMatchObject({
      level: 'error',
      msg: 'reviews.score_failed',
      event_type: 'reviews.sentiment_score',
      outcome: 'fail',
      venueId: 'v1',
      data: { reviewId: 'r1', message: 'AI call failed' },
    })
  })

  it('does not log on a successful background score', async () => {
    extractReviewLanguageMock.mockResolvedValue([
      { phrase: 'a', theme: 'space', sentiment: 0.8 },
    ])
    const supabase = makeFakeSupabase()
    scheduleReviewScoring({ reviewId: 'r1', venueId: 'v1', body: 'lovely space', supabase })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(logEventMock).not.toHaveBeenCalled()
    expect(updateCalls).toHaveLength(1)
  })
})
