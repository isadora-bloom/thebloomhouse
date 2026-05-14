/**
 * Reviews context provider (TIER 7d, 2026-05-14).
 *
 * Mirror of climate-context.ts but for reviews. One read surface that
 * every AI consumer calls to fetch the venue's review profile + active
 * trend signals in a prompt-ready shape. Used by:
 *
 *   - Weekly + monthly briefings
 *   - Tour-prep brief (so coordinator references real positive themes
 *     during the tour)
 *   - Sage email drafts via intel-brain
 *   - Sage chat (couple-facing) for "what do other couples say about you"
 *
 * Sources from reviews-analytics for the rollup numbers + reviews +
 * review_language for representative phrases.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { computeReviewsAnalytics } from './reviews-analytics'

export interface ReviewsContext {
  venueId: string
  available: boolean
  /** Prompt-ready plain-English block. Null when venue has no reviews. */
  promptBlock: string | null
  rollup: {
    total: number
    avg_rating: number | null
    five_star_pct: number
    recent_30d: number
    trend: 'rising' | 'flat' | 'falling' | 'unknown'
    top_sources: Array<{ source: string; count: number; avg_rating: number | null }>
    top_themes: Array<{ theme: string; count: number }>
  }
  /** Representative positive phrases the brain can weave in naturally. */
  representativePhrases: string[]
}

const SOURCE_LABELS: Record<string, string> = {
  google: 'Google',
  the_knot: 'The Knot',
  wedding_wire: 'WeddingWire',
  zola: 'Zola',
  yelp: 'Yelp',
  facebook: 'Facebook',
  other: 'Other',
}

export async function getVenueReviewsContext(venueId: string): Promise<ReviewsContext> {
  const rollup = await computeReviewsAnalytics(venueId).catch(() => null)
  if (!rollup || rollup.total === 0) {
    return {
      venueId,
      available: false,
      promptBlock: null,
      rollup: {
        total: 0,
        avg_rating: null,
        five_star_pct: 0,
        recent_30d: 0,
        trend: 'unknown',
        top_sources: [],
        top_themes: [],
      },
      representativePhrases: [],
    }
  }

  // Pull a small set of approved Sage phrases. The voice-training
  // surface already curates these; we surface them to brain consumers
  // so they can weave couple language without quoting raw reviews.
  const supabase = createServiceClient()
  const { data: phraseRows } = await supabase
    .from('review_language')
    .select('phrase, theme, sentiment_score, frequency, approved_for_sage')
    .eq('venue_id', venueId)
    .eq('approved_for_sage', true)
    .order('frequency', { ascending: false })
    .limit(12)

  type PhraseRow = {
    phrase: string
    theme: string | null
    sentiment_score: number | null
    frequency: number | null
  }
  const phrases = (phraseRows ?? []) as PhraseRow[]
  const representativePhrases = phrases
    .filter((p) => (p.sentiment_score ?? 0) >= 0.5 && p.phrase.length < 140)
    .slice(0, 8)
    .map((p) => p.phrase)

  // ---------------------------------------------------------------
  // Compose prompt block. Coordinator voice; numbers-typed.
  // ---------------------------------------------------------------
  const lines: string[] = []
  lines.push(
    `${rollup.total} reviews ingested across all sources${
      rollup.avg_rating !== null ? `, averaging ${rollup.avg_rating.toFixed(2)}★` : ''
    } (${Math.round(rollup.five_star_pct)}% five-star).`,
  )
  if (rollup.recent_30d_count > 0) {
    lines.push(`${rollup.recent_30d_count} new in the last 30 days.`)
  }
  if (rollup.sentiment_trend.direction !== 'unknown' && rollup.sentiment_trend.direction !== 'flat') {
    lines.push(
      `Sentiment is ${rollup.sentiment_trend.direction} vs the prior 6 months.`,
    )
  }

  if (rollup.sources.length > 0) {
    const topSources = rollup.sources.slice(0, 3)
    const sourceLine = topSources
      .map(
        (s) =>
          `${SOURCE_LABELS[s.source] ?? s.source}: ${s.count}${
            s.avg_rating !== null ? ` @ ${s.avg_rating.toFixed(1)}★` : ''
          }`,
      )
      .join(' · ')
    lines.push(`Top sources: ${sourceLine}.`)
  }

  if (rollup.top_themes.length > 0) {
    const themes = rollup.top_themes
      .slice(0, 5)
      .map((t) => `${t.theme} (${t.count})`)
      .join(', ')
    lines.push(`Couples most often mention: ${themes}.`)
  }

  if (representativePhrases.length > 0) {
    lines.push(``)
    lines.push(
      'Approved couple-language phrases you may weave in naturally (do not quote verbatim; just match the register):',
    )
    for (const p of representativePhrases.slice(0, 6)) {
      lines.push(`  - "${p}"`)
    }
  }

  return {
    venueId,
    available: true,
    promptBlock: lines.join('\n'),
    rollup: {
      total: rollup.total,
      avg_rating: rollup.avg_rating,
      five_star_pct: rollup.five_star_pct,
      recent_30d: rollup.recent_30d_count,
      trend: rollup.sentiment_trend.direction,
      top_sources: rollup.sources.slice(0, 3).map((s) => ({
        source: s.source,
        count: s.count,
        avg_rating: s.avg_rating,
      })),
      top_themes: rollup.top_themes.slice(0, 5),
    },
    representativePhrases,
  }
}
