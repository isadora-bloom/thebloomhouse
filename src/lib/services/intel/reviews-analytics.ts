/**
 * Reviews analytics rollup (TIER 7b, 2026-05-14).
 *
 * One read surface for the new /intel/reviews dashboard panel. Pulls
 * the venue's reviews and computes:
 *
 *   - totals + average rating
 *   - source-by-source breakdown (count, avg rating, share)
 *   - monthly trend (volume + rolling sentiment) over the last 24 months
 *   - top themes by frequency
 *   - sentiment-trajectory direction (rolling 6m vs prior 6m)
 *
 * Pure DB read. No LLM call. Used by:
 *   - /intel/reviews dashboard panel
 *   - TIER 7d shared review-context helper (briefings + Sage)
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface ReviewsAnalyticsSourceRow {
  source: string
  count: number
  avg_rating: number | null
  share_pct: number
  with_response: number
}

export interface ReviewsAnalyticsMonthly {
  month: string // YYYY-MM
  count: number
  avg_rating: number | null
  avg_sentiment: number | null
}

export interface ReviewsAnalyticsTheme {
  theme: string
  count: number
}

export interface ReviewsAnalyticsRollup {
  venue_id: string
  total: number
  avg_rating: number | null
  five_star_pct: number
  with_response_pct: number
  recent_30d_count: number
  recent_90d_count: number
  sources: ReviewsAnalyticsSourceRow[]
  monthly: ReviewsAnalyticsMonthly[]
  top_themes: ReviewsAnalyticsTheme[]
  sentiment_trend: {
    recent_avg: number | null
    prior_avg: number | null
    direction: 'rising' | 'flat' | 'falling' | 'unknown'
  }
  solicitations: {
    /** Booked weddings 7-30 days post-event with no solicitation row. */
    gap_count: number
    /** All solicitation rows in the last 12 months. */
    total_12mo: number
    received_12mo: number
    no_response_12mo: number
    queued: number
    sent: number
    /** Conversion: received / (sent + received) over the last 12 months. */
    received_rate_pct: number | null
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function computeReviewsAnalytics(
  venueId: string,
): Promise<ReviewsAnalyticsRollup> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('reviews')
    .select('source, rating, sentiment_score, themes, response_text, review_date')
    .eq('venue_id', venueId)
    .order('review_date', { ascending: false })
    .limit(2000)

  type Row = {
    source: string
    rating: number
    sentiment_score: number | null
    themes: string[] | null
    response_text: string | null
    review_date: string
  }
  const rows = (data ?? []) as Row[]

  const total = rows.length
  const sumRating = rows.reduce((s, r) => s + r.rating, 0)
  const avg_rating = total > 0 ? sumRating / total : null
  const fiveStar = rows.filter((r) => r.rating === 5).length
  const withResponse = rows.filter((r) => r.response_text && r.response_text.trim()).length

  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
  const recent30 = rows.filter((r) => new Date(r.review_date) >= thirtyDaysAgo).length
  const recent90 = rows.filter((r) => new Date(r.review_date) >= ninetyDaysAgo).length

  // --------- Sources -----------------------------------------------
  const sourcesMap = new Map<
    string,
    { count: number; ratingSum: number; ratingN: number; withResponse: number }
  >()
  for (const r of rows) {
    const key = r.source || 'other'
    const existing = sourcesMap.get(key) ?? {
      count: 0,
      ratingSum: 0,
      ratingN: 0,
      withResponse: 0,
    }
    existing.count++
    existing.ratingSum += r.rating
    existing.ratingN++
    if (r.response_text && r.response_text.trim()) existing.withResponse++
    sourcesMap.set(key, existing)
  }
  const sources: ReviewsAnalyticsSourceRow[] = Array.from(sourcesMap.entries())
    .map(([source, v]) => ({
      source,
      count: v.count,
      avg_rating: v.ratingN > 0 ? v.ratingSum / v.ratingN : null,
      share_pct: total > 0 ? (v.count / total) * 100 : 0,
      with_response: v.withResponse,
    }))
    .sort((a, b) => b.count - a.count)

  // --------- Monthly trend (last 24 months) ------------------------
  const monthlyMap = new Map<string, { count: number; ratingSum: number; sentSum: number; sentN: number }>()
  const twentyFourMonthsAgo = new Date(now)
  twentyFourMonthsAgo.setUTCMonth(twentyFourMonthsAgo.getUTCMonth() - 23)
  twentyFourMonthsAgo.setUTCDate(1)
  for (const r of rows) {
    const d = new Date(r.review_date)
    if (d < twentyFourMonthsAgo) continue
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const existing = monthlyMap.get(key) ?? { count: 0, ratingSum: 0, sentSum: 0, sentN: 0 }
    existing.count++
    existing.ratingSum += r.rating
    if (typeof r.sentiment_score === 'number') {
      existing.sentSum += r.sentiment_score
      existing.sentN++
    }
    monthlyMap.set(key, existing)
  }
  // Fill in missing months so the chart renders a smooth line
  const monthly: ReviewsAnalyticsMonthly[] = []
  for (let i = 0; i < 24; i++) {
    const d = new Date(twentyFourMonthsAgo)
    d.setUTCMonth(d.getUTCMonth() + i)
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const m = monthlyMap.get(key)
    monthly.push({
      month: key,
      count: m?.count ?? 0,
      avg_rating: m && m.count > 0 ? m.ratingSum / m.count : null,
      avg_sentiment: m && m.sentN > 0 ? m.sentSum / m.sentN : null,
    })
  }

  // --------- Themes ------------------------------------------------
  const themeCounts = new Map<string, number>()
  for (const r of rows) {
    if (!Array.isArray(r.themes)) continue
    for (const t of r.themes) {
      if (!t) continue
      const key = String(t).toLowerCase().trim()
      if (!key) continue
      themeCounts.set(key, (themeCounts.get(key) ?? 0) + 1)
    }
  }
  const top_themes: ReviewsAnalyticsTheme[] = Array.from(themeCounts.entries())
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  // --------- Sentiment trajectory (rolling 6m vs prior 6m) ---------
  const sixMonthsAgo = new Date(now)
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6)
  const twelveMonthsAgo = new Date(now)
  twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 12)
  const recentRange = rows.filter((r) => {
    const d = new Date(r.review_date)
    return d >= sixMonthsAgo && d <= now && typeof r.sentiment_score === 'number'
  })
  const priorRange = rows.filter((r) => {
    const d = new Date(r.review_date)
    return d >= twelveMonthsAgo && d < sixMonthsAgo && typeof r.sentiment_score === 'number'
  })
  const recent_avg =
    recentRange.length > 0
      ? recentRange.reduce((s, r) => s + (r.sentiment_score ?? 0), 0) / recentRange.length
      : null
  const prior_avg =
    priorRange.length > 0
      ? priorRange.reduce((s, r) => s + (r.sentiment_score ?? 0), 0) / priorRange.length
      : null
  let direction: ReviewsAnalyticsRollup['sentiment_trend']['direction'] = 'unknown'
  if (recent_avg !== null && prior_avg !== null) {
    const delta = recent_avg - prior_avg
    if (delta > 0.05) direction = 'rising'
    else if (delta < -0.05) direction = 'falling'
    else direction = 'flat'
  }

  // --------- Solicitations (gap detection + funnel) ----------------
  // Gap = booked weddings whose wedding_date is in [now-30d, now-7d]
  // with NO row in review_solicit_requests. Matches the cron sweep's
  // backfill window so the operator sees the same denominator.
  const todayDate = isoDate(now)
  const sevenDaysAgo = isoDate(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000))
  const thirtyDaysAgo30 = isoDate(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000))
  const twelveMonthsAgoIso = isoDate(
    new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()),
  )
  void todayDate

  const { data: postEventWeddings } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .in('status', ['booked', 'completed'])
    .gte('wedding_date', thirtyDaysAgo30)
    .lte('wedding_date', sevenDaysAgo)

  type WeddingRow = { id: string }
  const postEventIds = (postEventWeddings ?? []).map((w) => (w as WeddingRow).id)
  let gap_count = 0
  if (postEventIds.length > 0) {
    const { data: solicitations } = await supabase
      .from('review_solicit_requests')
      .select('wedding_id')
      .in('wedding_id', postEventIds)
    const solicited = new Set(
      ((solicitations ?? []) as Array<{ wedding_id: string }>).map((s) => s.wedding_id),
    )
    gap_count = postEventIds.filter((id) => !solicited.has(id)).length
  }

  const { data: solicitRows } = await supabase
    .from('review_solicit_requests')
    .select('status, generated_at')
    .eq('venue_id', venueId)
    .gte('generated_at', twelveMonthsAgoIso)

  type SolicitRow = { status: string }
  const solicits = (solicitRows ?? []) as SolicitRow[]
  const total_12mo = solicits.length
  const received_12mo = solicits.filter((s) => s.status === 'review_received').length
  const no_response_12mo = solicits.filter((s) => s.status === 'no_response').length
  const sentInWindow = solicits.filter((s) => s.status === 'sent').length
  const queuedInWindow = solicits.filter((s) => s.status === 'queued').length
  const sentDenom = sentInWindow + received_12mo + no_response_12mo
  const received_rate_pct =
    sentDenom > 0 ? (received_12mo / sentDenom) * 100 : null

  return {
    venue_id: venueId,
    total,
    avg_rating,
    five_star_pct: total > 0 ? (fiveStar / total) * 100 : 0,
    with_response_pct: total > 0 ? (withResponse / total) * 100 : 0,
    recent_30d_count: recent30,
    recent_90d_count: recent90,
    sources,
    monthly,
    top_themes,
    sentiment_trend: { recent_avg, prior_avg, direction },
    solicitations: {
      gap_count,
      total_12mo,
      received_12mo,
      no_response_12mo,
      queued: queuedInWindow,
      sent: sentInWindow,
      received_rate_pct,
    },
  }
}
