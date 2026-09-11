import { describe, it, expect } from 'vitest'
import { reviewsToolSource } from '../reviews'
import { makeFakeSupabase } from './fake-supabase'
import { computeReviewsAnalytics } from '@/lib/services/intel/reviews-analytics'

const VENUE_ID = 'venue-1'

describe('reviews tool source', () => {
  it('is registered against battery Q41 and exposes reviews subjects', () => {
    expect(reviewsToolSource.batteryQuestions).toContain('41')
    expect(reviewsToolSource.subjects.join(' ')).toMatch(/review/i)
    expect(reviewsToolSource.tool.name).toBe('get_reviews_summary')
  })

  it('refuses with insufficient data below the minimum review count', async () => {
    const supabase = makeFakeSupabase((table) => {
      if (table === 'reviews') return { data: [{ source: 'google', rating: 5, review_date: '2026-08-01', themes: [], body: 'lovely' }] }
      return { data: [] }
    })
    const result = (await reviewsToolSource.run(VENUE_ID, {}, {
      supabase,
      today: '2026-09-09',
    })) as { n: number; enoughData: boolean; reason?: string }
    expect(result.enoughData).toBe(false)
    expect(result.n).toBe(1)
    expect(result.reason).toMatch(/fewer than 3 reviews/)
  })

  it('computes per-source counts, quarterly trend and themes with quotes', async () => {
    const rows = [
      { source: 'google', rating: 5, review_date: '2026-08-01', themes: ['communication'], body: 'Isadora was wonderful to work with throughout.' },
      { source: 'google', rating: 4, review_date: '2026-07-15', themes: ['communication', 'venue'], body: 'Great venue, minor delays in replies.' },
      { source: 'the_knot', rating: 5, review_date: '2026-08-20', themes: ['venue'], body: 'Beautiful grounds, would book again.' },
      { source: 'the_knot', rating: 2, review_date: '2026-02-01', themes: ['venue'], body: 'Disappointed with the grounds upkeep this time.' },
    ]
    const supabase = makeFakeSupabase((table) => {
      if (table === 'reviews') return { data: rows }
      return { data: [] }
    })
    const result = (await reviewsToolSource.run(VENUE_ID, {}, {
      supabase,
      today: '2026-09-09',
    })) as {
      n: number
      enoughData: boolean
      bySource: Array<{ source: string; n: number; avgRating: number | null }>
      ratingTrendByQuarter: Array<{ quarter: string; n: number; avgRating: number | null }>
      recurringThemes: Array<{ theme: string; n: number; exampleQuotes: string[] }>
    }

    expect(result.enoughData).toBe(true)
    expect(result.n).toBe(4)

    const google = result.bySource.find((s) => s.source === 'Google')
    expect(google?.n).toBe(2)
    expect(google?.avgRating).toBe(4.5)

    const q3 = result.ratingTrendByQuarter.find((q) => q.quarter === '2026-Q3')
    expect(q3?.n).toBe(3)

    const venueTheme = result.recurringThemes.find((t) => t.theme === 'venue')
    expect(venueTheme?.n).toBe(3)
    expect(venueTheme?.exampleQuotes.length).toBeGreaterThan(0)
  })

  it('agrees with reviews-analytics.ts on source counts and theme counts for the same rows (W34)', async () => {
    const rows = [
      { source: 'google', rating: 5, review_date: '2026-08-01', themes: ['communication'], body: 'Isadora was wonderful to work with throughout.' },
      { source: 'google', rating: 4, review_date: '2026-07-15', themes: ['communication', 'venue'], body: 'Great venue, minor delays in replies.' },
      { source: 'the_knot', rating: 5, review_date: '2026-08-20', themes: ['venue'], body: 'Beautiful grounds, would book again.' },
      { source: 'the_knot', rating: 2, review_date: '2026-02-01', themes: ['venue'], body: 'Disappointed with the grounds upkeep this time.' },
    ]
    const supabase = makeFakeSupabase((table) => {
      if (table === 'reviews') return { data: rows }
      return { data: [] }
    })

    const rollup = await computeReviewsAnalytics(VENUE_ID, supabase)
    const result = (await reviewsToolSource.run(VENUE_ID, {}, {
      supabase,
      today: '2026-09-09',
    })) as {
      n: number
      bySource: Array<{ source: string; n: number; avgRating: number | null }>
      recurringThemes: Array<{ theme: string; n: number }>
    }

    expect(result.n).toBe(rollup.total)

    for (const s of rollup.sources) {
      const match = result.bySource.find((b) => b.source === (s.source === 'google' ? 'Google' : s.source === 'the_knot' ? 'The Knot' : s.source))
      expect(match?.n).toBe(s.count)
    }

    for (const t of rollup.top_themes) {
      const match = result.recurringThemes.find((r) => r.theme === t.theme)
      // recurringThemes is capped at MAX_THEMES=6; every theme in this
      // fixture is within that cap so it must be present with the same count.
      expect(match?.n).toBe(t.count)
    }
  })

  it('reads reviews table read failures as an honest refusal, not a crash', async () => {
    const supabase = makeFakeSupabase(() => ({ data: null, error: { message: 'connection reset' } }))
    const result = (await reviewsToolSource.run(VENUE_ID, {}, {
      supabase,
      today: '2026-09-09',
    })) as { enoughData: boolean; reason?: string }
    expect(result.enoughData).toBe(false)
    expect(result.reason).toMatch(/reviews read failed/)
  })
})
