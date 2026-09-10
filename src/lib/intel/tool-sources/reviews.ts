/**
 * Reviews across every source, with recurring themes and a worse/better
 * trend read. NOVEMBER-PLAN.md wave 2, W14. Battery Q41.
 *
 * There is already a rollup for this at src/lib/services/intel/reviews-
 * analytics.ts (Tier 7b, powers /intel/reviews). This does not call it:
 * that helper opens its own service-role client via createServiceClient()
 * with no way to inject a fake for a unit test, and it groups by month
 * rather than quarter and does not carry example quotes. This file reads
 * the same `reviews` table (migration 031) directly against the injected
 * deps.supabase so the tool stays testable without the network, and
 * shapes the numbers the way Q41 actually asks for them.
 */
import type { IntelToolSource, ToolSourceDeps } from './types'
import { insufficient } from './types'

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

  // ---- per source: count + average rating ----
  const sourceMap = new Map<string, { n: number; sum: number }>()
  for (const r of rows) {
    const key = r.source || 'other'
    const e = sourceMap.get(key) ?? { n: 0, sum: 0 }
    e.n++
    e.sum += r.rating
    sourceMap.set(key, e)
  }
  const bySource = Array.from(sourceMap.entries())
    .map(([source, e]) => ({
      source: SOURCE_LABELS[source] ?? source,
      n: e.n,
      avgRating: e.n > 0 ? round1(e.sum / e.n) : null,
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

  // ---- recurring themes with a couple of short example quotes each ----
  const themeMap = new Map<string, { n: number; quotes: string[] }>()
  for (const r of rows) {
    if (!Array.isArray(r.themes)) continue
    for (const raw of r.themes) {
      if (!raw) continue
      const theme = String(raw).toLowerCase().trim()
      if (!theme) continue
      const e = themeMap.get(theme) ?? { n: 0, quotes: [] }
      e.n++
      if (e.quotes.length < MAX_QUOTES_PER_THEME && r.body && r.body.trim()) {
        e.quotes.push(truncate(r.body, QUOTE_MAX_CHARS))
      }
      themeMap.set(theme, e)
    }
  }
  const recurringThemes = Array.from(themeMap.entries())
    .map(([theme, e]) => ({ theme, n: e.n, exampleQuotes: e.quotes }))
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_THEMES)

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
