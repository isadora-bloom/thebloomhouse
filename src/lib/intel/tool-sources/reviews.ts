/**
 * Reviews across every source, with recurring themes and a worse/better
 * trend read. NOVEMBER-PLAN.md wave 2, W14. Battery Q41.
 *
 * There is already a rollup for this at src/lib/services/intel/reviews-
 * analytics.ts (Tier 7b, powers /intel/reviews). Wave 4 W34 gave that
 * helper an injectable client, so this file now calls it for the two
 * numbers that were previously re-derived by hand from the same rows:
 * per-source counts/average rating and theme frequency. What this file
 * still owns, because the rollup does not carry it: quarter-bucketed
 * rating trend (the rollup groups by month), the honest-refusal
 * `n`/`enoughData` wrapping per figure, and the example quotes attached
 * to each theme. It still reads the raw `reviews` table itself (against
 * the same injected deps.supabase passed to the rollup) because the
 * quarter bucketing and the quotes both need the individual rows, not
 * just the rollup's aggregates.
 */
import type { IntelToolSource, ToolSourceDeps } from './types'
import { insufficient } from './types'
import { computeReviewsAnalytics } from '@/lib/services/intel/reviews-analytics'

/** Below this many reviews on record, a trend or theme read is a guess
 *  dressed up as a finding. */
const MIN_REVIEWS_OVERALL = 3
/** A quarter with fewer reviews than this gets its count reported but its
 *  average rating withheld. */
const MIN_REVIEWS_PER_QUARTER = 3
/** Each side of the worse/better comparison needs at least this many
 *  reviews before the trend call is trusted. */
const MIN_REVIEWS_PER_TREND_WINDOW = 3
/** Rating-point drop (recent 6mo avg vs prior 6mo avg) that counts as
 *  "trending worse". Anything smaller is noise, not a trend. */
const TREND_WORSE_DELTA = 0.2
const MAX_THEMES = 6
const MAX_QUOTES_PER_THEME = 2
const QUOTE_MAX_CHARS = 140

const SOURCE_LABELS: Record<string, string> = {
  google: 'Google',
  the_knot: 'The Knot',
  wedding_wire: 'WeddingWire',
  yelp: 'Yelp',
  facebook: 'Facebook',
  other: 'Other',
}

interface ReviewRow {
  source: string | null
  rating: number
  review_date: string
  themes: string[] | null
  body: string | null
}

function quarterKey(dateStr: string): string {
  const d = new Date(dateStr)
  const q = Math.floor(d.getUTCMonth() / 3) + 1
  return `${d.getUTCFullYear()}-Q${q}`
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function truncate(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1).trimEnd() + '…'
}

async function run(
  venueId: string,
  _args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const { data, error } = await deps.supabase
    .from('reviews')
    .select('source, rating, review_date, themes, body')
    .eq('venue_id', venueId)
    .order('review_date', { ascending: false })
    .limit(2000)

  if (error) {
    return { n: 0, enoughData: false, reason: `reviews read failed: ${error.message}` }
  }

  const rows = (data ?? []) as ReviewRow[]
  const n = rows.length

  if (n < MIN_REVIEWS_OVERALL) {
    return {
      ...insufficient(n, `fewer than ${MIN_REVIEWS_OVERALL} reviews on record for this venue`),
      bySource: [],
      ratingTrendByQuarter: [],
      recurringThemes: [],
      trendingWorse: null,
    }
  }

  // ---- per source + theme frequency: from the shared rollup, not re-derived ----
  // Same `reviews` rows, same injected deps.supabase, so the two callers
  // cannot disagree on a count (see the __tests__ "agree with the rollup"
  // case).
  const rollup = await computeReviewsAnalytics(venueId, deps.supabase)

  const bySource = rollup.sources
    .map((s) => ({
      source: SOURCE_LABELS[s.source] ?? s.source,
      n: s.count,
      avgRating: s.avg_rating !== null ? round1(s.avg_rating) : null,
    }))
    .sort((a, b) => b.n - a.n)

  // ---- rating trend by quarter ----
  const quarterMap = new Map<string, { n: number; sum: number }>()
  for (const r of rows) {
    const key = quarterKey(r.review_date)
    const e = quarterMap.get(key) ?? { n: 0, sum: 0 }
    e.n++
    e.sum += r.rating
    quarterMap.set(key, e)
  }
  const ratingTrendByQuarter = Array.from(quarterMap.entries())
    .map(([quarter, e]) => ({
      quarter,
      n: e.n,
      enoughData: e.n >= MIN_REVIEWS_PER_QUARTER,
      avgRating: e.n >= MIN_REVIEWS_PER_QUARTER ? round1(e.sum / e.n) : null,
    }))
    .sort((a, b) => (a.quarter < b.quarter ? -1 : a.quarter > b.quarter ? 1 : 0))

  // ---- example quotes per theme ----
  // Theme counts come from the rollup above; this pass over the same rows
  // only harvests a couple of short quotes per theme, which the rollup
  // does not carry.
  const quotesByTheme = new Map<string, string[]>()
  for (const r of rows) {
    if (!Array.isArray(r.themes)) continue
    for (const raw of r.themes) {
      if (!raw) continue
      const theme = String(raw).toLowerCase().trim()
      if (!theme) continue
      const quotes = quotesByTheme.get(theme) ?? []
      if (quotes.length < MAX_QUOTES_PER_THEME && r.body && r.body.trim()) {
        quotes.push(truncate(r.body, QUOTE_MAX_CHARS))
      }
      quotesByTheme.set(theme, quotes)
    }
  }
  const recurringThemes = rollup.top_themes.slice(0, MAX_THEMES).map((t) => ({
    theme: t.theme,
    n: t.count,
    exampleQuotes: quotesByTheme.get(t.theme) ?? [],
  }))

  // ---- trending worse: last 6 months vs the 6 months before that ----
  const now = new Date()
  const sixMoAgo = new Date(now)
  sixMoAgo.setUTCMonth(sixMoAgo.getUTCMonth() - 6)
  const twelveMoAgo = new Date(now)
  twelveMoAgo.setUTCMonth(twelveMoAgo.getUTCMonth() - 12)

  const recent = rows.filter((r) => new Date(r.review_date) >= sixMoAgo)
  const prior = rows.filter((r) => {
    const d = new Date(r.review_date)
    return d >= twelveMoAgo && d < sixMoAgo
  })

  let trendingWorse: boolean | null = null
  let trendNote: string
  if (recent.length >= MIN_REVIEWS_PER_TREND_WINDOW && prior.length >= MIN_REVIEWS_PER_TREND_WINDOW) {
    const recentAvg = recent.reduce((s, r) => s + r.rating, 0) / recent.length
    const priorAvg = prior.reduce((s, r) => s + r.rating, 0) / prior.length
    trendingWorse = priorAvg - recentAvg > TREND_WORSE_DELTA
    trendNote =
      `Last 6 months averaged ${round1(recentAvg)} across ${recent.length} reviews, ` +
      `versus ${round1(priorAvg)} across ${prior.length} in the 6 months before that.`
  } else {
    trendNote =
      `Not enough reviews in both the last 6 months (${recent.length}) and the 6 months ` +
      `before that (${prior.length}) to call a trend either way.`
  }

  return {
    n,
    enoughData: true,
    bySource,
    ratingTrendByQuarter,
    recurringThemes,
    trendingWorse,
    trendNote,
  }
}

export const reviewsToolSource: IntelToolSource = {
  tool: {
    name: 'get_reviews_summary',
    description:
      'Reviews for this venue across every source (Google, The Knot, WeddingWire, Yelp, Facebook): ' +
      'per-source counts and average rating, the rating trend by quarter, and recurring themes with a ' +
      'couple of short example quotes each. Also says whether the recent trend is worse, better or ' +
      'stable versus six months earlier, with the averages behind that call. ' +
      'Use this for anything about what couples say in reviews, star ratings, review themes, or whether ' +
      'reputation is slipping.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  subjects: ['reviews', 'review ratings', 'review themes', 'reputation trend', 'what couples say about us'],
  batteryQuestions: ['41'],
  run,
}
