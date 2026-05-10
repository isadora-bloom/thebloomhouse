/**
 * Bloom House: Intelligence Engine
 *
 * The core pattern detection brain. Analyzes venue operational data across
 * 14 detectors (8 sales + 6 operational), produces ranked, actionable
 * insights, and stores them in intelligence_insights for surfacing in
 * dashboards and briefings.
 *
 * Design principles:
 *  - DETECTION is pure statistical / heuristic — same numeric pass as
 *    before. Each detector emits structured `narrator_facts` (family +
 *    framing string + numeric allowlist) alongside its template
 *    prose.
 *  - NARRATION runs through `narrateIntelligenceInsight` (Sonnet-tier,
 *    numbers-guarded). Fall back to the deterministic template only
 *    when the cost-ceiling gate is closed, the LLM call fails, or the
 *    numbers-guard rejects the output. Per AI-VS-TEMPLATED-AUDIT.md
 *    finding #1 (2026-05-09) + Isadora directive 2026-05-09.
 *  - Each persisted row carries `narration_source = 'llm' | 'template'`
 *    (migration 251) so a future UI badge can distinguish.
 *  - Each detector is self-contained, defensive, and returns [] on failure.
 *  - Confidence reflects data quality (more data points = higher confidence).
 *  - data_points always contains the raw numbers for transparency.
 */

import { createServiceClient } from '@/lib/supabase/service'
import type { SupabaseClient } from '@supabase/supabase-js'
import { asCents, centsToDollars } from '@/lib/types/monetary'
import {
  narrateIntelligenceInsight,
  BRAIN_INTEL_ENGINE_PROMPT_VERSION,
  INTEL_ENGINE_NARRATION_MODEL,
  type IntelInsightFamily,
  type NarratorFacts,
} from './intelligence-engine-narration'
import { aggregateAutoContextThemes } from '../identity/auto-context-loader'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InsightCandidate {
  insight_type: string
  category: string
  /** Detector-composed template title. Surfaces as the FALLBACK title
   *  when the LLM narrator fails. Replaced by LLM output otherwise. */
  title: string
  /** Detector-composed template body. Same fallback contract as title. */
  body: string
  /** Detector-composed template action. Same fallback contract. */
  action?: string
  priority: 'critical' | 'high' | 'medium' | 'low'
  confidence: number
  impact_score?: number
  data_points: Record<string, unknown>
  compared_to?: string
  expires_at?: string
  /** Family + framing + numeric allowlist for the LLM narrator. When
   *  set, the runner pipes the candidate through
   *  `narrateIntelligenceInsight`; the result replaces title / body /
   *  action and stamps `narration_source='llm'`. When omitted (or the
   *  narrator falls back), title / body / action stay as the
   *  detector-composed template and `narration_source='template'`. */
  narrator_facts?: {
    family: IntelInsightFamily
    framing: string
    numbers: Array<number | string>
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10
}

function ratio(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100) / 100
}

function confidenceFromN(n: number, minGood = 10, minGreat = 30): number {
  if (n < 3) return 0.2
  if (n < minGood) return 0.4
  if (n < minGreat) return 0.65
  return 0.85
}

function daysAgoISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

function expiresInDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

function dayName(dayIndex: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayIndex] ?? `Day ${dayIndex}`
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${Math.round(mins)} minutes`
  if (mins < 1440) return `${(mins / 60).toFixed(1)} hours`
  return `${(mins / 1440).toFixed(1)} days`
}

function formatDollars(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

// ---------------------------------------------------------------------------
// Detector 1: Response Time -> Conversion Correlation
// ---------------------------------------------------------------------------

async function detectResponseTimeConversion(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    const { data: weddings, error } = await supabase
      .from('weddings')
      .select('status, inquiry_date, first_response_at')
      .eq('venue_id', venueId)
      .not('first_response_at', 'is', null)
      .not('inquiry_date', 'is', null)

    if (error || !weddings || weddings.length < 5) return []

    // Bucket by response time
    const buckets: Record<string, { total: number; booked: number }> = {
      '<30min': { total: 0, booked: 0 },
      '30-60min': { total: 0, booked: 0 },
      '1-4hr': { total: 0, booked: 0 },
      '4-24hr': { total: 0, booked: 0 },
      '>24hr': { total: 0, booked: 0 },
    }

    for (const w of weddings) {
      const inquiryTime = new Date(w.inquiry_date as string).getTime()
      const responseTime = new Date(w.first_response_at as string).getTime()
      const diffMinutes = (responseTime - inquiryTime) / 60_000

      // Skip rows where inquiry_date is after first_response_at (data corruption)
      if (diffMinutes < 0) continue

      let bucket: string
      if (diffMinutes < 30) bucket = '<30min'
      else if (diffMinutes < 60) bucket = '30-60min'
      else if (diffMinutes < 240) bucket = '1-4hr'
      else if (diffMinutes < 1440) bucket = '4-24hr'
      else bucket = '>24hr'

      buckets[bucket].total++
      if (['booked', 'completed'].includes(w.status as string)) {
        buckets[bucket].booked++
      }
    }

    // Find buckets with enough data and calculate conversion rates
    const rates: { bucket: string; rate: number; total: number }[] = []
    for (const [bucket, data] of Object.entries(buckets)) {
      if (data.total >= 2) {
        rates.push({ bucket, rate: data.booked / data.total, total: data.total })
      }
    }

    if (rates.length < 2) return []

    // Sort by rate descending
    rates.sort((a, b) => b.rate - a.rate)
    const best = rates[0]
    const worst = rates[rates.length - 1]

    // Check for meaningful difference (>15% delta)
    const delta = best.rate - worst.rate
    if (delta < 0.15) return []

    const multiplier = worst.rate > 0 ? (best.rate / worst.rate).toFixed(1) : 'infinitely more'

    const bestPct = pct(best.rate, 1)
    const worstPct = pct(worst.rate, 1)
    const deltaPct = pct(delta, 1)

    const insights: InsightCandidate[] = [{
      insight_type: 'correlation',
      category: 'response_time',
      title: `${best.bucket} responses convert ${multiplier}x vs ${worst.bucket}`,
      body: `Leads who get a response within ${best.bucket} book at ${bestPct}% compared to ${worstPct}% for those waiting ${worst.bucket}. ` +
        `That is a ${deltaPct} percentage point gap across ${weddings.length} leads with response data. ` +
        `Faster responses don't just feel better, they measurably drive revenue.`,
      action: `Set a team goal to respond to all new inquiries within ${best.bucket}. Consider enabling auto-send for initial responses to hit this window consistently.`,
      priority: delta > 0.3 ? 'high' : 'medium',
      confidence: confidenceFromN(weddings.length),
      impact_score: delta * weddings.length * 5000, // rough estimate: delta * leads * avg value
      data_points: {
        buckets: Object.fromEntries(
          Object.entries(buckets).map(([k, v]) => [k, { total: v.total, booked: v.booked, rate: v.total > 0 ? pct(v.booked, v.total) : 0 }])
        ),
        total_leads_analyzed: weddings.length,
        best_bucket: best.bucket,
        best_rate: bestPct,
        worst_bucket: worst.bucket,
        worst_rate: worstPct,
      },
      compared_to: 'internal_buckets',
      expires_at: expiresInDays(30),
      narrator_facts: {
        family: 'conversion_comparison',
        framing:
          `Leads responded to in the ${best.bucket} bucket converted at the highest ` +
          `rate, and leads waiting until the ${worst.bucket} bucket converted at the ` +
          `lowest rate, across ${weddings.length} leads with response-time data. ` +
          `The faster bucket is roughly ${multiplier} times the slower bucket.`,
        numbers: [
          bestPct, worstPct, deltaPct,
          weddings.length,
          best.total, worst.total,
          Number(multiplier),
          best.bucket, worst.bucket,
          // Numeric thresholds inside the bucket labels ("<30min" /
          // "1-4hr"). The numbers-guard tokenises the LLM output by
          // numeric runs, so a bucket label that gets quoted in the
          // body would be flagged unless the inner numbers are listed.
          30, 60, 1, 4, 24, 240, 1440,
        ],
      },
    }]

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectResponseTimeConversion failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 2: Day-of-Week Patterns
// ---------------------------------------------------------------------------

async function detectDayOfWeekPatterns(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Tours with outcomes
    const { data: tours, error: tourErr } = await supabase
      .from('tours')
      .select('scheduled_at, outcome, wedding_id')
      .eq('venue_id', venueId)
      .not('scheduled_at', 'is', null)

    // Inquiries by day
    const { data: weddings, error: wedErr } = await supabase
      .from('weddings')
      .select('inquiry_date, status')
      .eq('venue_id', venueId)
      .not('inquiry_date', 'is', null)

    const insights: InsightCandidate[] = []

    // --- Tour day-of-week analysis ---
    if (!tourErr && tours && tours.length >= 8) {
      // We need to check which tours led to bookings
      const tourWeddingIds = tours
        .filter(t => t.wedding_id)
        .map(t => t.wedding_id as string)

      let bookedWeddingIds = new Set<string>()
      if (tourWeddingIds.length > 0) {
        const { data: bookedWeddings } = await supabase
          .from('weddings')
          .select('id')
          .in('id', tourWeddingIds)
          .in('status', ['booked', 'completed'])

        if (bookedWeddings) {
          bookedWeddingIds = new Set(bookedWeddings.map(w => w.id as string))
        }
      }

      const dayStats: Record<number, { tours: number; completed: number; booked: number }> = {}
      for (let i = 0; i < 7; i++) dayStats[i] = { tours: 0, completed: 0, booked: 0 }

      for (const tour of tours) {
        const dow = new Date(tour.scheduled_at as string).getDay()
        dayStats[dow].tours++
        if (tour.outcome === 'completed') dayStats[dow].completed++
        if (tour.wedding_id && bookedWeddingIds.has(tour.wedding_id as string)) {
          dayStats[dow].booked++
        }
      }

      // Find days with meaningful conversion data
      const dayRates: { day: number; rate: number; tours: number }[] = []
      for (const [day, stats] of Object.entries(dayStats)) {
        if (stats.completed >= 2) {
          dayRates.push({
            day: Number(day),
            rate: stats.booked / stats.completed,
            tours: stats.completed,
          })
        }
      }

      if (dayRates.length >= 2) {
        dayRates.sort((a, b) => b.rate - a.rate)
        const best = dayRates[0]
        const worst = dayRates[dayRates.length - 1]
        const delta = best.rate - worst.rate

        if (delta > 0.15) {
          const bestPct = pct(best.rate, 1)
          const worstPct = pct(worst.rate, 1)
          const deltaPct = pct(delta, 1)
          insights.push({
            insight_type: 'correlation',
            category: 'lead_conversion',
            title: `${dayName(best.day)} tours convert at ${bestPct}% vs ${worstPct}% on ${dayName(worst.day)}s`,
            body: `Across ${tours.length} tours, ${dayName(best.day)} consistently produces the highest booking rate. ` +
              `${dayName(worst.day)} tours complete but don't convert at the same rate. ` +
              `This could reflect couple readiness, competition for attention, or the tour experience itself on different days.`,
            action: `Prioritize offering ${dayName(best.day)} tour slots to your hottest leads. Consider what makes ${dayName(worst.day)} different. Is it more rushed? Is the venue set up differently?`,
            priority: delta > 0.3 ? 'high' : 'medium',
            confidence: confidenceFromN(tours.length, 15, 40),
            data_points: {
              day_breakdown: Object.fromEntries(
                Object.entries(dayStats).map(([d, s]) => [dayName(Number(d)), s])
              ),
              best_day: dayName(best.day),
              best_rate: bestPct,
              worst_day: dayName(worst.day),
              worst_rate: worstPct,
              total_tours: tours.length,
            },
            compared_to: 'internal_days',
            expires_at: expiresInDays(30),
            narrator_facts: {
              family: 'conversion_comparison',
              framing:
                `${dayName(best.day)} tours convert at the highest rate; ` +
                `${dayName(worst.day)} tours convert at the lowest, across ` +
                `${tours.length} completed tours. The gap is meaningful enough ` +
                `to favour ${dayName(best.day)} slots for the hottest leads.`,
              numbers: [
                bestPct, worstPct, deltaPct,
                tours.length, best.tours, worst.tours,
                dayName(best.day), dayName(worst.day),
              ],
            },
          })
        }
      }
    }

    // --- Inquiry day-of-week analysis ---
    if (!wedErr && weddings && weddings.length >= 10) {
      const dayInquiries: Record<number, { total: number; booked: number }> = {}
      for (let i = 0; i < 7; i++) dayInquiries[i] = { total: 0, booked: 0 }

      for (const w of weddings) {
        const dow = new Date(w.inquiry_date as string).getDay()
        dayInquiries[dow].total++
        if (['booked', 'completed'].includes(w.status as string)) {
          dayInquiries[dow].booked++
        }
      }

      // Find the peak inquiry day
      const peakDay = Object.entries(dayInquiries)
        .filter(([, s]) => s.total >= 2)
        .sort((a, b) => b[1].total - a[1].total)[0]

      const lowDay = Object.entries(dayInquiries)
        .filter(([, s]) => s.total >= 1)
        .sort((a, b) => a[1].total - b[1].total)[0]

      if (peakDay && lowDay && peakDay[1].total > lowDay[1].total * 1.5) {
        const peakName = dayName(Number(peakDay[0]))
        const lowName = dayName(Number(lowDay[0]))
        insights.push({
          insight_type: 'trend',
          category: 'lead_conversion',
          title: `${peakName}s generate the most inquiries (${peakDay[1].total})`,
          body: `${peakName} is your highest-volume inquiry day with ${peakDay[1].total} inquiries, ` +
            `while ${lowName} is the quietest with ${lowDay[1].total}. ` +
            `Knowing when couples are actively searching helps you staff appropriately and ensure fast responses on peak days.`,
          action: `Ensure full staffing and fast response capability on ${peakName}s. Consider scheduling marketing pushes for ${lowName}s to fill the gap.`,
          priority: 'low',
          confidence: confidenceFromN(weddings.length),
          data_points: {
            day_breakdown: Object.fromEntries(
              Object.entries(dayInquiries).map(([d, s]) => [dayName(Number(d)), s])
            ),
            total_inquiries: weddings.length,
          },
          compared_to: 'internal_days',
          expires_at: expiresInDays(30),
          narrator_facts: {
            family: 'volume_comparison',
            framing:
              `${peakName} is the busiest inquiry day with ${peakDay[1].total} ` +
              `inquiries across the analysed window, while ${lowName} is the ` +
              `quietest with ${lowDay[1].total}. Total inquiries analysed: ` +
              `${weddings.length}.`,
            numbers: [
              peakDay[1].total, lowDay[1].total, weddings.length,
              peakName, lowName,
            ],
          },
        })
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectDayOfWeekPatterns failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 3: Source Quality (not just volume)
// ---------------------------------------------------------------------------

async function detectSourceQuality(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    const { data: weddings, error } = await supabase
      .from('weddings')
      .select('source, status, booking_value, inquiry_date, booked_at')
      .eq('venue_id', venueId)
      .not('source', 'is', null)

    if (error || !weddings || weddings.length < 5) return []

    // Group by source
    const sourceStats = new Map<string, {
      inquiries: number
      booked: number
      totalValue: number
      daysToBook: number[]
    }>()

    for (const w of weddings) {
      const src = w.source as string
      const stats = sourceStats.get(src) || { inquiries: 0, booked: 0, totalValue: 0, daysToBook: [] }
      stats.inquiries++

      if (['booked', 'completed'].includes(w.status as string)) {
        stats.booked++
        // booking_value is branded Cents (T5-Rixey-RR fix #5); store dollars in totalValue.
        stats.totalValue += centsToDollars(asCents(Number(w.booking_value) || 0))

        if (w.inquiry_date && w.booked_at) {
          const days = (new Date(w.booked_at as string).getTime() - new Date(w.inquiry_date as string).getTime()) / (1000 * 60 * 60 * 24)
          if (days > 0) stats.daysToBook.push(days)
        }
      }

      sourceStats.set(src, stats)
    }

    // Calculate quality metrics per source
    const sourceRanked: {
      source: string
      inquiries: number
      booked: number
      convRate: number
      avgValue: number
      avgDaysToBook: number
      qualityScore: number // convRate * avgValue (normalized)
    }[] = []

    for (const [source, stats] of sourceStats) {
      if (stats.inquiries < 2) continue

      const convRate = stats.booked / stats.inquiries
      const avgValue = stats.booked > 0 ? stats.totalValue / stats.booked : 0
      const avgDaysToBook = stats.daysToBook.length > 0
        ? stats.daysToBook.reduce((s, v) => s + v, 0) / stats.daysToBook.length
        : 0

      sourceRanked.push({
        source,
        inquiries: stats.inquiries,
        booked: stats.booked,
        convRate,
        avgValue,
        avgDaysToBook,
        qualityScore: convRate * (avgValue || 1), // Quality = conversion * value
      })
    }

    if (sourceRanked.length < 2) return []

    // Sort by quality
    sourceRanked.sort((a, b) => b.qualityScore - a.qualityScore)

    const insights: InsightCandidate[] = []

    // Insight: High volume, low quality source
    const byVolume = [...sourceRanked].sort((a, b) => b.inquiries - a.inquiries)
    const topVolume = byVolume[0]
    const topQuality = sourceRanked[0]

    if (topVolume.source !== topQuality.source && topVolume.inquiries > topQuality.inquiries * 1.5) {
      const volConv = pct(topVolume.convRate, 1)
      const qualConv = pct(topQuality.convRate, 1)
      const avgValRounded = Math.round(topQuality.avgValue)

      insights.push({
        insight_type: 'recommendation',
        category: 'source_attribution',
        title: `${topQuality.source} books at ${qualConv}% vs ${topVolume.source} at ${volConv}%, quality over volume`,
        body: `${topVolume.source} generates the most inquiries (${topVolume.inquiries}) but converts at only ${volConv}%. ` +
          `Meanwhile, ${topQuality.source} sends fewer leads (${topQuality.inquiries}) but converts at ${qualConv}%` +
          (topQuality.avgValue > 0 ? ` with an average booking value of ${formatDollars(topQuality.avgValue)}` : '') +
          `. Dollar for dollar, ${topQuality.source} delivers more revenue per inquiry.`,
        action: `Consider shifting marketing spend toward ${topQuality.source}. If you can't reduce ${topVolume.source} spend, improve the ${topVolume.source} funnel; the leads are there but something is breaking in conversion.`,
        priority: 'high',
        confidence: confidenceFromN(weddings.length),
        impact_score: (topQuality.convRate - topVolume.convRate) * topVolume.inquiries * (topQuality.avgValue || 15000),
        data_points: {
          sources: sourceRanked.map(s => ({
            source: s.source,
            inquiries: s.inquiries,
            conversion_rate: pct(s.convRate, 1),
            avg_booking_value: Math.round(s.avgValue),
            avg_days_to_book: Math.round(s.avgDaysToBook),
            quality_score: Math.round(s.qualityScore),
          })),
          total_inquiries: weddings.length,
        },
        compared_to: 'internal_sources',
        expires_at: expiresInDays(30),
        narrator_facts: {
          family: 'source_quality',
          framing:
            `${topVolume.source} sends the most leads (${topVolume.inquiries}) ` +
            `but converts at ${volConv}%. ${topQuality.source} sends fewer ` +
            `(${topQuality.inquiries}) but converts at ${qualConv}%` +
            (topQuality.avgValue > 0
              ? ` with an average booking value around ${formatDollars(topQuality.avgValue)}`
              : '') +
            `. Across ${weddings.length} leads with source attribution.`,
          numbers: [
            volConv, qualConv,
            topVolume.inquiries, topQuality.inquiries,
            weddings.length,
            avgValRounded,
            topVolume.source, topQuality.source,
          ],
        },
      })
    }

    // Insight: Fastest-closing source
    const withBookingTime = sourceRanked.filter(s => s.avgDaysToBook > 0 && s.booked > 1)
    if (withBookingTime.length >= 2) {
      withBookingTime.sort((a, b) => a.avgDaysToBook - b.avgDaysToBook)
      const fastest = withBookingTime[0]
      const slowest = withBookingTime[withBookingTime.length - 1]

      if (slowest.avgDaysToBook > fastest.avgDaysToBook * 1.5) {
        const fastDays = Math.round(fastest.avgDaysToBook)
        const slowDays = Math.round(slowest.avgDaysToBook)
        insights.push({
          insight_type: 'benchmark',
          category: 'source_attribution',
          title: `${fastest.source} leads book in ${fastDays} days vs ${slowDays} from ${slowest.source}`,
          body: `Leads from ${fastest.source} move through your pipeline fastest, booking in an average of ${fastDays} days. ` +
            `${slowest.source} leads take ${slowDays} days. ` +
            `Faster cycles mean less follow-up work and less risk of losing the lead to a competitor.`,
          action: `Map out what makes ${fastest.source} leads decide faster. Are they further along in planning when they inquire? Use that insight to qualify ${slowest.source} leads earlier.`,
          priority: 'low',
          confidence: confidenceFromN(fastest.inquiries + slowest.inquiries),
          data_points: {
            fastest_source: fastest.source,
            fastest_days: fastDays,
            slowest_source: slowest.source,
            slowest_days: slowDays,
          },
          compared_to: 'internal_sources',
          expires_at: expiresInDays(30),
          narrator_facts: {
            family: 'source_quality',
            framing:
              `${fastest.source} leads close fastest at an average of ${fastDays} ` +
              `days from inquiry to booking, while ${slowest.source} leads ` +
              `take ${slowDays} days on average. Combined sample size is ` +
              `${fastest.booked + slowest.booked} bookings.`,
            numbers: [
              fastDays, slowDays,
              fastest.booked, slowest.booked,
              fastest.inquiries, slowest.inquiries,
              fastest.source, slowest.source,
            ],
          },
        })
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectSourceQuality failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 4: Coordinator Performance Patterns
// ---------------------------------------------------------------------------

async function detectCoordinatorPatterns(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    const { data: metrics, error } = await supabase
      .from('consultant_metrics')
      .select('consultant_id, period_start, period_end, inquiries_handled, tours_booked, bookings_closed, conversion_rate, avg_response_time_minutes, avg_booking_value')
      .eq('venue_id', venueId)
      .order('period_end', { ascending: false })
      .limit(50)

    if (error || !metrics || metrics.length < 2) return []

    // Get consultant names
    const consultantIds = [...new Set(metrics.map(m => m.consultant_id as string))]
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name')
      .in('id', consultantIds)

    const nameMap = new Map<string, string>()
    if (profiles) {
      for (const p of profiles) {
        nameMap.set(p.id as string, (p.first_name as string) || 'Unknown')
      }
    }

    // Group latest metrics per consultant
    const latestByConsultant = new Map<string, typeof metrics[0]>()
    for (const m of metrics) {
      const cid = m.consultant_id as string
      if (!latestByConsultant.has(cid)) {
        latestByConsultant.set(cid, m)
      }
    }

    if (latestByConsultant.size < 2) return []

    const insights: InsightCandidate[] = []

    // Compare response times
    const responseData: { name: string; responseTime: number; convRate: number; avgValue: number }[] = []
    for (const [cid, m] of latestByConsultant) {
      const rt = m.avg_response_time_minutes as number | null
      const cr = m.conversion_rate as number | null
      const av = m.avg_booking_value as number | null
      if (rt != null) {
        responseData.push({
          name: nameMap.get(cid) || cid.substring(0, 8),
          responseTime: rt,
          convRate: cr ?? 0,
          avgValue: av ?? 0,
        })
      }
    }

    if (responseData.length >= 2) {
      responseData.sort((a, b) => a.responseTime - b.responseTime)
      const fastest = responseData[0]
      const slowest = responseData[responseData.length - 1]

      if (slowest.responseTime > fastest.responseTime * 2 && slowest.responseTime > 30) {
        const ratio = Number((slowest.responseTime / fastest.responseTime).toFixed(1))
        const fastestMins = Math.round(fastest.responseTime)
        const slowestMins = Math.round(slowest.responseTime)
        insights.push({
          insight_type: 'risk',
          category: 'team_performance',
          title: `${slowest.name}'s avg response time is ${formatMinutes(slowest.responseTime)}, ${ratio}x slower than ${fastest.name}`,
          body: `${fastest.name} responds in an average of ${formatMinutes(fastest.responseTime)}, while ${slowest.name} takes ${formatMinutes(slowest.responseTime)}. ` +
            `If response time correlates with conversion (check the Response Time insight), this gap could be costing bookings. ` +
            `The difference could indicate workload imbalance, scheduling issues, or process differences.`,
          action: `Check ${slowest.name}'s workload. Are they overloaded on specific days? Consider load-balancing inquiry assignments or enabling auto-send for their initial responses.`,
          priority: slowest.responseTime > 240 ? 'high' : 'medium',
          confidence: confidenceFromN(metrics.length, 5, 20),
          data_points: {
            coordinators: responseData.map(c => ({
              name: c.name,
              avg_response_minutes: Math.round(c.responseTime),
              conversion_rate: pct(c.convRate, 1),
              avg_booking_value: Math.round(c.avgValue),
            })),
          },
          compared_to: 'internal_team',
          expires_at: expiresInDays(14),
          narrator_facts: {
            family: 'entity_outlier',
            framing:
              `${fastest.name} averages ${fastestMins} minutes to first response; ` +
              `${slowest.name} averages ${slowestMins} minutes, roughly ` +
              `${ratio} times slower. Compared across ${responseData.length} ` +
              `coordinators on file.`,
            numbers: [
              fastestMins, slowestMins, ratio,
              responseData.length,
              fastest.name, slowest.name,
            ],
          },
        })
      }

      // Check conversion rate differences
      const convData = responseData.filter(c => c.convRate > 0)
      if (convData.length >= 2) {
        convData.sort((a, b) => b.convRate - a.convRate)
        const bestConv = convData[0]
        const worstConv = convData[convData.length - 1]
        const convDelta = bestConv.convRate - worstConv.convRate

        if (convDelta > 0.15) {
          const bestPct = pct(bestConv.convRate, 1)
          const worstPct = pct(worstConv.convRate, 1)
          const deltaPct = pct(convDelta, 1)
          insights.push({
            insight_type: 'benchmark',
            category: 'team_performance',
            title: `${bestConv.name} converts at ${bestPct}% vs ${worstConv.name} at ${worstPct}%`,
            body: `There is a ${deltaPct} percentage point gap in conversion rates between coordinators. ` +
              `${bestConv.name} is booking more of the leads they work. ` +
              `Understanding what ${bestConv.name} does differently in tour style, follow-up cadence, or communication approach can lift the whole team.`,
            action: `Have ${bestConv.name} share their process with the team. Shadow their tours and compare follow-up sequences to identify what drives the higher conversion.`,
            priority: convDelta > 0.25 ? 'high' : 'medium',
            confidence: confidenceFromN(metrics.length, 5, 20),
            data_points: {
              coordinators: convData.map(c => ({
                name: c.name,
                conversion_rate: pct(c.convRate, 1),
                avg_response_minutes: Math.round(c.responseTime),
              })),
            },
            compared_to: 'internal_team',
            expires_at: expiresInDays(14),
            narrator_facts: {
              family: 'entity_outlier',
              framing:
                `${bestConv.name} converts at ${bestPct}% and ${worstConv.name} ` +
                `converts at ${worstPct}%, a gap of ${deltaPct} percentage ` +
                `points. Compared across ${convData.length} coordinators on file.`,
              numbers: [
                bestPct, worstPct, deltaPct,
                convData.length,
                bestConv.name, worstConv.name,
              ],
            },
          })
        }
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectCoordinatorPatterns failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 5: Couple Behavior -> Booking Predictor
// ---------------------------------------------------------------------------

async function detectCoupleBehaviorPredictors(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Get weddings with their interactions
    const { data: weddings, error: wErr } = await supabase
      .from('weddings')
      .select('id, status')
      .eq('venue_id', venueId)
      .in('status', ['booked', 'completed', 'lost', 'cancelled'])

    if (wErr || !weddings || weddings.length < 8) return []

    const bookedIds = weddings.filter(w => ['booked', 'completed'].includes(w.status as string)).map(w => w.id as string)
    const lostIds = weddings.filter(w => ['lost', 'cancelled'].includes(w.status as string)).map(w => w.id as string)

    if (bookedIds.length < 3 || lostIds.length < 3) return []

    // Get email counts and engagement for booked vs lost
    const [bookedInteractions, lostInteractions, bookedEngagement, lostEngagement] = await Promise.all([
      supabase
        .from('interactions')
        .select('wedding_id, direction, timestamp')
        .eq('venue_id', venueId)
        .in('wedding_id', bookedIds)
        .eq('type', 'email'),
      supabase
        .from('interactions')
        .select('wedding_id, direction, timestamp')
        .eq('venue_id', venueId)
        .in('wedding_id', lostIds)
        .eq('type', 'email'),
      supabase
        .from('engagement_events')
        .select('wedding_id, event_type, points')
        .eq('venue_id', venueId)
        .in('wedding_id', bookedIds),
      supabase
        .from('engagement_events')
        .select('wedding_id, event_type, points')
        .eq('venue_id', venueId)
        .in('wedding_id', lostIds),
    ])

    const insights: InsightCandidate[] = []

    // Analyze email volume patterns
    const calcEmailStats = (data: typeof bookedInteractions.data, ids: string[]) => {
      if (!data) return { avgEmails: 0, avgInbound: 0 }
      const byCoupleCount = new Map<string, number>()
      const byCoupleInbound = new Map<string, number>()

      for (const i of data) {
        const wid = i.wedding_id as string
        byCoupleCount.set(wid, (byCoupleCount.get(wid) || 0) + 1)
        if (i.direction === 'inbound') {
          byCoupleInbound.set(wid, (byCoupleInbound.get(wid) || 0) + 1)
        }
      }

      const counts = ids.map(id => byCoupleCount.get(id) || 0)
      const inbounds = ids.map(id => byCoupleInbound.get(id) || 0)

      return {
        avgEmails: counts.length > 0 ? counts.reduce((s, v) => s + v, 0) / counts.length : 0,
        avgInbound: inbounds.length > 0 ? inbounds.reduce((s, v) => s + v, 0) / inbounds.length : 0,
      }
    }

    const bookedStats = calcEmailStats(bookedInteractions.data, bookedIds)
    const lostStats = calcEmailStats(lostInteractions.data, lostIds)

    if (bookedStats.avgEmails > 0 && lostStats.avgEmails > 0) {
      const emailRatio = bookedStats.avgEmails / lostStats.avgEmails

      if (emailRatio > 1.4 || emailRatio < 0.7) {
        const moreOrFewer = emailRatio > 1 ? 'more' : 'fewer'
        const ratioRounded = Number(emailRatio.toFixed(1))
        const bookedAvg = Number(bookedStats.avgEmails.toFixed(1))
        const bookedInb = Number(bookedStats.avgInbound.toFixed(1))
        const lostAvg = Number(lostStats.avgEmails.toFixed(1))
        const lostInb = Number(lostStats.avgInbound.toFixed(1))
        insights.push({
          insight_type: 'prediction',
          category: 'couple_behavior',
          title: `Couples who book exchange ${ratioRounded}x ${moreOrFewer} emails before signing`,
          body: `Booked couples averaged ${bookedAvg} emails (${bookedInb} inbound), ` +
            `while lost couples averaged ${lostAvg} emails (${lostInb} inbound). ` +
            `Email engagement is a strong predictor of booking intent. ` +
            `Couples who go quiet may need a different approach than more follow-up emails.`,
          action: emailRatio > 1
            ? `Leads with low email engagement after the first 2 touchpoints are at risk. Flag them for a phone call or personal video message instead of another email.`
            : `High email volume from lost leads may indicate confusion or unresolved objections. Look for patterns in what they're asking; it may reveal a gap in your pitch.`,
          priority: 'medium',
          confidence: confidenceFromN(bookedIds.length + lostIds.length),
          data_points: {
            booked_avg_emails: bookedStats.avgEmails.toFixed(1),
            booked_avg_inbound: bookedStats.avgInbound.toFixed(1),
            lost_avg_emails: lostStats.avgEmails.toFixed(1),
            lost_avg_inbound: lostStats.avgInbound.toFixed(1),
            booked_count: bookedIds.length,
            lost_count: lostIds.length,
          },
          compared_to: 'booked_vs_lost',
          expires_at: expiresInDays(30),
          narrator_facts: {
            family: 'conversion_comparison',
            framing:
              `Couples who eventually booked averaged ${bookedAvg} emails ` +
              `(${bookedInb} inbound) before signing; couples who were lost ` +
              `averaged ${lostAvg} emails (${lostInb} inbound). The booked ` +
              `cohort exchanged about ${ratioRounded} times ${moreOrFewer} ` +
              `emails. Compared across ${bookedIds.length} booked and ` +
              `${lostIds.length} lost couples.`,
            numbers: [
              ratioRounded, bookedAvg, bookedInb, lostAvg, lostInb,
              bookedIds.length, lostIds.length,
            ],
          },
        })
      }
    }

    // Analyze engagement event patterns
    const calcEngagementStats = (data: typeof bookedEngagement.data, ids: string[]) => {
      if (!data) return { avgPoints: 0, avgEvents: 0 }
      const byCouple = new Map<string, { points: number; events: number }>()

      for (const e of data) {
        const wid = e.wedding_id as string
        const existing = byCouple.get(wid) || { points: 0, events: 0 }
        existing.points += Number(e.points) || 0
        existing.events++
        byCouple.set(wid, existing)
      }

      const points = ids.map(id => byCouple.get(id)?.points || 0)
      const events = ids.map(id => byCouple.get(id)?.events || 0)

      return {
        avgPoints: points.length > 0 ? points.reduce((s, v) => s + v, 0) / points.length : 0,
        avgEvents: events.length > 0 ? events.reduce((s, v) => s + v, 0) / events.length : 0,
      }
    }

    const bookedEng = calcEngagementStats(bookedEngagement.data, bookedIds)
    const lostEng = calcEngagementStats(lostEngagement.data, lostIds)

    if (bookedEng.avgPoints > 0 && lostEng.avgPoints > 0) {
      const pointsRatio = bookedEng.avgPoints / lostEng.avgPoints

      if (pointsRatio > 1.5) {
        const ratioRounded = Number(pointsRatio.toFixed(1))
        const bookedAvgPoints = Math.round(bookedEng.avgPoints)
        const lostAvgPoints = Math.round(lostEng.avgPoints)
        const bookedAvgEvents = Number(bookedEng.avgEvents.toFixed(1))
        const lostAvgEvents = Number(lostEng.avgEvents.toFixed(1))
        const threshold = Math.round(bookedEng.avgPoints * 0.7)
        insights.push({
          insight_type: 'prediction',
          category: 'couple_behavior',
          title: `Booked couples have ${ratioRounded}x higher engagement scores`,
          body: `Couples who eventually book accumulate an average engagement score of ${bookedAvgPoints} ` +
            `(${bookedAvgEvents} events), compared to ${lostAvgPoints} for lost leads ` +
            `(${lostAvgEvents} events). Heat scores above ${threshold} are strong buying signals.`,
          action: `Set a heat score threshold of ${threshold} to flag "likely to book" leads. Give these leads priority scheduling and personalized attention.`,
          priority: 'medium',
          confidence: confidenceFromN(bookedIds.length + lostIds.length),
          data_points: {
            booked_avg_engagement_score: bookedAvgPoints,
            booked_avg_events: bookedEng.avgEvents.toFixed(1),
            lost_avg_engagement_score: lostAvgPoints,
            lost_avg_events: lostEng.avgEvents.toFixed(1),
          },
          compared_to: 'booked_vs_lost',
          expires_at: expiresInDays(30),
          narrator_facts: {
            family: 'conversion_comparison',
            framing:
              `Booked couples averaged an engagement score of ${bookedAvgPoints} ` +
              `over ${bookedAvgEvents} events; lost couples averaged ` +
              `${lostAvgPoints} over ${lostAvgEvents} events. Booked is ` +
              `roughly ${ratioRounded} times higher. Suggested ` +
              `likely-to-book threshold based on these averages: ${threshold}.`,
            numbers: [
              ratioRounded, bookedAvgPoints, lostAvgPoints,
              bookedAvgEvents, lostAvgEvents,
              threshold,
              bookedIds.length, lostIds.length,
            ],
          },
        })
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectCoupleBehaviorPredictors failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 6: Pipeline Stall Detection
// ---------------------------------------------------------------------------

async function detectPipelineStalls(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Get active pipeline weddings (not terminal states)
    const { data: weddings, error } = await supabase
      .from('weddings')
      .select('id, status, updated_at, booking_value')
      .eq('venue_id', venueId)
      .not('status', 'in', '("booked","completed","lost","cancelled")')

    if (error || !weddings || weddings.length === 0) return []

    const now = Date.now()
    const STALL_THRESHOLD_DAYS = 14

    // Find stalled leads per stage
    const stalledByStage = new Map<string, { count: number; totalValue: number; maxDays: number }>()

    for (const w of weddings) {
      const updatedAt = new Date(w.updated_at as string).getTime()
      const daysSinceUpdate = (now - updatedAt) / (1000 * 60 * 60 * 24)

      if (daysSinceUpdate >= STALL_THRESHOLD_DAYS) {
        const status = w.status as string
        const existing = stalledByStage.get(status) || { count: 0, totalValue: 0, maxDays: 0 }
        existing.count++
        // booking_value is branded Cents (T5-Rixey-RR fix #5); store dollars.
        existing.totalValue += centsToDollars(asCents(Number(w.booking_value) || 0))
        existing.maxDays = Math.max(existing.maxDays, daysSinceUpdate)
        stalledByStage.set(status, existing)
      }
    }

    if (stalledByStage.size === 0) return []

    // Get historical conversion rates after stalls for context
    const { data: historical } = await supabase
      .from('weddings')
      .select('status, updated_at')
      .eq('venue_id', venueId)
      .in('status', ['booked', 'completed', 'lost', 'cancelled'])
      .limit(200)

    // Calculate overall loss rate for context
    let lostCount = 0
    let totalResolved = 0
    if (historical) {
      for (const h of historical) {
        totalResolved++
        if (['lost', 'cancelled'].includes(h.status as string)) lostCount++
      }
    }
    // Guard: fewer than 5 resolved leads makes any baseline unreliable.
    // baselineLossRate = 0 when guard fails; downstream at-risk revenue calc is suppressed.
    const baselineLossRate = totalResolved >= 5
      ? lostCount / totalResolved
      : 0

    const insights: InsightCandidate[] = []

    // Total stalled
    let totalStalled = 0
    let totalStalledValue = 0
    for (const [, data] of stalledByStage) {
      totalStalled += data.count
      totalStalledValue += data.totalValue
    }

    if (totalStalled >= 1) {
      const stageBreakdown = Array.from(stalledByStage.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .map(([stage, data]) => `${data.count} in "${stage}" (oldest: ${Math.round(data.maxDays)} days)`)
        .join(', ')

      // Estimate at-risk revenue (stalled leads lose at higher rate)
      // Only compute when we have a reliable baseline (>= 5 resolved leads)
      const hasReliableLossRate = totalResolved >= 5
      const stalledLossRate = hasReliableLossRate ? Math.min(baselineLossRate * 1.5, 0.85) : 0
      const atRiskRevenue = totalStalledValue * stalledLossRate

      const priority: InsightCandidate['priority'] =
        totalStalled >= 5 ? 'critical' :
          totalStalled >= 3 ? 'high' : 'medium'

      // Title: only show dollar amount when loss-rate baseline is reliable
      const riskLabel = hasReliableLossRate && atRiskRevenue > 0
        ? formatDollars(atRiskRevenue) + ' at risk'
        : 'action needed'

      const atRiskRounded = Math.round(atRiskRevenue)
      const totalStalledValueRounded = Math.round(totalStalledValue)
      const baselineLossPct = hasReliableLossRate ? pct(baselineLossRate, 1) : 0
      insights.push({
        insight_type: 'risk',
        category: 'lead_conversion',
        title: `${totalStalled} lead${totalStalled > 1 ? 's' : ''} stalled for 14+ days, ${riskLabel}`,
        body: `${totalStalled} active leads haven't moved forward in over ${STALL_THRESHOLD_DAYS} days: ${stageBreakdown}. ` +
          (hasReliableLossRate
            ? `Based on your historical data, leads that stall this long convert at a significantly lower rate. `
            : `Stalled leads are at elevated risk of going cold. `) +
          (totalStalledValue > 0 && hasReliableLossRate ? `These leads represent ${formatDollars(totalStalledValue)} in potential revenue. ` : '') +
          `Every additional day of inaction makes recovery less likely.`,
        action: `Review each stalled lead this week. For "proposal_sent" leads, call directly; email hasn't worked. For "tour_scheduled" leads, confirm or reschedule. For "inquiry" leads, try a different channel (text, phone, social).`,
        priority,
        confidence: 0.8, // Pipeline stalls are highly concrete
        impact_score: hasReliableLossRate ? atRiskRevenue : undefined,
        data_points: {
          total_stalled: totalStalled,
          total_stalled_value: totalStalledValue,
          stall_threshold_days: STALL_THRESHOLD_DAYS,
          at_risk_revenue: hasReliableLossRate ? atRiskRounded : null,
          baseline_loss_rate: hasReliableLossRate ? baselineLossPct : null,
          historical_sample_size: totalResolved,
          stages: Object.fromEntries(stalledByStage),
          total_active_pipeline: weddings.length,
        },
        compared_to: 'stall_threshold',
        expires_at: expiresInDays(7), // This is urgent, refresh weekly
        narrator_facts: {
          family: 'count_with_risk',
          framing:
            `${totalStalled} active leads have not moved forward in over ` +
            `${STALL_THRESHOLD_DAYS} days. Stage breakdown: ${stageBreakdown}. ` +
            (hasReliableLossRate
              ? `Historical loss rate at this venue is ${baselineLossPct}%, ` +
                `so the at-risk revenue estimate is roughly ` +
                `${formatDollars(atRiskRevenue)}. `
              : `Historical loss-rate baseline is unreliable on this venue ` +
                `right now; treat the count as the actionable signal. `) +
            `Total pipeline value of stalled leads: ` +
            `${formatDollars(totalStalledValue)}.`,
          numbers: [
            totalStalled, STALL_THRESHOLD_DAYS,
            atRiskRounded, totalStalledValueRounded,
            baselineLossPct,
            totalResolved, weddings.length,
            ...Array.from(stalledByStage.entries()).flatMap(([stage, d]) => [
              d.count, Math.round(d.maxDays), stage,
            ]),
          ],
        },
      })
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectPipelineStalls failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 7: Seasonal Opportunity
// ---------------------------------------------------------------------------

async function detectSeasonalOpportunities(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Get all bookings with wedding dates
    const { data: weddings, error } = await supabase
      .from('weddings')
      .select('wedding_date, status, booking_value, booked_at')
      .eq('venue_id', venueId)
      .not('wedding_date', 'is', null)
      .in('status', ['booked', 'completed'])

    if (error || !weddings || weddings.length < 6) return []

    // Get booked/held dates for the capacity analysis. After migration 073
    // booked_dates was renamed to venue_availability and block_type split
    // into the 5-value `status` enum. Count any row where the date is
    // actually consumed — booked or on hold.
    const { data: bookedDates } = await supabase
      .from('venue_availability')
      .select('date, status')
      .eq('venue_id', venueId)
      .in('status', ['booked', 'hold'])

    // Get venue capacity info
    const { data: config } = await supabase
      .from('venue_config')
      .select('capacity')
      .eq('venue_id', venueId)
      .single()

    const insights: InsightCandidate[] = []

    // Analyze bookings by month
    const currentYear = new Date().getFullYear()
    const currentMonth = new Date().getMonth()

    // Count bookings per month for current year
    const monthBookings: Record<number, { count: number; totalValue: number }> = {}
    for (let m = 0; m < 12; m++) monthBookings[m] = { count: 0, totalValue: 0 }

    for (const w of weddings) {
      const weddingDate = new Date(w.wedding_date as string)
      if (weddingDate.getFullYear() === currentYear) {
        const month = weddingDate.getMonth()
        monthBookings[month].count++
        // booking_value is branded Cents (T5-Rixey-RR fix #5); store dollars.
        monthBookings[month].totalValue += centsToDollars(asCents(Number(w.booking_value) || 0))
      }
    }

    // Count booked dates per month for capacity analysis
    const monthDateCount: Record<number, number> = {}
    for (let m = 0; m < 12; m++) monthDateCount[m] = 0

    if (bookedDates) {
      for (const bd of bookedDates) {
        const d = new Date(bd.date as string)
        if (d.getFullYear() === currentYear) {
          monthDateCount[d.getMonth()]++
        }
      }
    }

    // Estimate capacity per month (assume ~4-5 weekends = ~4-5 possible events)
    const estimatedMonthlyCapacity = 5 // Conservative weekend count per month

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December']

    // Check future months for filling fast or empty
    for (let m = currentMonth + 1; m < 12; m++) {
      const booked = monthBookings[m].count
      const datesBooked = monthDateCount[m]
      const fillRate = datesBooked / estimatedMonthlyCapacity
      const monthsAway = m - currentMonth

      if (fillRate >= 0.7 && monthsAway >= 3) {
        // Month is filling fast
        const fillPct = Math.round(fillRate * 100)
        insights.push({
          insight_type: 'opportunity',
          category: 'seasonal',
          title: `${monthNames[m]} is ${fillPct}% booked with ${monthsAway} months to go`,
          body: `${monthNames[m]} already has ${datesBooked} dates booked out of ~${estimatedMonthlyCapacity} available weekends. ` +
            `With ${monthsAway} months remaining, this month is nearly sold out. ` +
            `Scarcity messaging for ${monthNames[m]} can accelerate remaining bookings and justify premium pricing.`,
          action: `Mention limited ${monthNames[m]} availability in all tour conversations and inquiry responses. Consider a price increase for remaining ${monthNames[m]} dates.`,
          priority: fillRate >= 0.9 ? 'high' : 'medium',
          confidence: 0.75,
          data_points: {
            month: monthNames[m],
            dates_booked: datesBooked,
            estimated_capacity: estimatedMonthlyCapacity,
            fill_rate: pct(fillRate, 1),
            months_away: monthsAway,
            total_booking_value: monthBookings[m].totalValue,
          },
          compared_to: 'capacity',
          expires_at: expiresInDays(14),
          narrator_facts: {
            family: 'capacity_signal',
            framing:
              `${monthNames[m]} has ${datesBooked} dates booked out of an ` +
              `estimated ${estimatedMonthlyCapacity} weekend slots, roughly ` +
              `${fillPct}% full with ${monthsAway} months still to go.`,
            numbers: [
              fillPct, datesBooked, estimatedMonthlyCapacity, monthsAway,
              monthNames[m],
            ],
          },
        })
      } else if (booked === 0 && datesBooked === 0 && monthsAway >= 2 && monthsAway <= 6) {
        // Month is empty and approaching
        insights.push({
          insight_type: 'risk',
          category: 'seasonal',
          title: `${monthNames[m]} has zero bookings, ${monthsAway} months away`,
          body: `${monthNames[m]} is completely open with ${monthsAway} months to go. ` +
            `If this month historically has low demand, consider whether targeted promotions or pricing adjustments could help. ` +
            `If it should be busy, something may be blocking bookings; check if leads are being lost at a specific stage.`,
          action: `Run a targeted promotion for ${monthNames[m]}. Consider a small discount, added value package, or social media campaign highlighting the season. Reach out to any lost leads who had interest in this time period.`,
          priority: monthsAway <= 3 ? 'high' : 'medium',
          confidence: 0.7,
          data_points: {
            month: monthNames[m],
            dates_booked: 0,
            months_away: monthsAway,
          },
          compared_to: 'capacity',
          expires_at: expiresInDays(14),
          narrator_facts: {
            family: 'capacity_signal',
            framing:
              `${monthNames[m]} has zero bookings on the calendar with ` +
              `${monthsAway} months remaining before the month begins.`,
            numbers: [0, monthsAway, monthNames[m]],
          },
        })
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectSeasonalOpportunities failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 8: Lost Deal Pattern Analysis
// ---------------------------------------------------------------------------

async function detectLostDealPatterns(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Get lost deals with structured reasons
    const { data: lostDeals, error: ldErr } = await supabase
      .from('lost_deals')
      .select('reason_category, reason_detail, lost_at_stage, competitor_name, wedding_id')
      .eq('venue_id', venueId)

    // Also get weddings marked as lost (some may not have a lost_deals entry)
    const { data: lostWeddings, error: lwErr } = await supabase
      .from('weddings')
      .select('id, status, lost_reason, booking_value, source')
      .eq('venue_id', venueId)
      .eq('status', 'lost')

    const insights: InsightCandidate[] = []

    // --- Analyze lost_deals table (structured reasons) ---
    if (!ldErr && lostDeals && lostDeals.length >= 3) {
      // Group by reason_category
      const reasonCounts = new Map<string, { count: number; stages: string[]; competitors: string[] }>()

      for (const ld of lostDeals) {
        const reason = (ld.reason_category as string) || 'unknown'
        const existing = reasonCounts.get(reason) || { count: 0, stages: [], competitors: [] }
        existing.count++
        if (ld.lost_at_stage) existing.stages.push(ld.lost_at_stage as string)
        if (ld.competitor_name) existing.competitors.push(ld.competitor_name as string)
        reasonCounts.set(reason, existing)
      }

      // Sort by frequency
      const sortedReasons = [...reasonCounts.entries()].sort((a, b) => b[1].count - a[1].count)

      if (sortedReasons.length > 0) {
        const topReason = sortedReasons[0]
        const topReasonPct = pct(topReason[1].count, lostDeals.length)
        const topReasonName = topReason[0].replace(/_/g, ' ')

        // Check if top reason is disproportionately dominant
        if (topReason[1].count >= 3 && topReason[1].count / lostDeals.length >= 0.3) {
          // Build context about the dominant reason
          const stageDistribution = new Map<string, number>()
          for (const s of topReason[1].stages) {
            stageDistribution.set(s, (stageDistribution.get(s) || 0) + 1)
          }

          const competitorMentions = topReason[1].competitors.filter(c => c.length > 0)
          const uniqueCompetitors = [...new Set(competitorMentions)]

          let bodyExtra = ''
          if (stageDistribution.size > 0) {
            const stageStr = [...stageDistribution.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([s, c]) => `${c} at ${s} stage`)
              .join(', ')
            bodyExtra += ` These losses happen at: ${stageStr}.`
          }

          if (uniqueCompetitors.length > 0) {
            bodyExtra += ` Competitors mentioned: ${uniqueCompetitors.join(', ')}.`
          }

          // Cross-reference with pricing if the reason is pricing
          let actionText = `Dig into the ${topReasonName} losses. `
          if (topReason[0] === 'pricing') {
            // Check actual conversion on higher-budget leads
            if (lostWeddings && lostWeddings.length > 0) {
              // booking_value is branded Cents (T5-Rixey-RR fix #5); convert to dollars.
              const allWeddingValues = lostWeddings
                .filter(w => w.booking_value != null)
                .map(w => centsToDollars(asCents(Number(w.booking_value))))

              if (allWeddingValues.length > 0) {
                const medianValue = allWeddingValues.sort((a, b) => a - b)[Math.floor(allWeddingValues.length / 2)]
                actionText += `The median booking value of lost deals is ${formatDollars(medianValue)}. If your actual bookings are higher, the issue may be lead qualification — not price. Consider adding a budget range question to your inquiry form.`
              }
            } else {
              actionText += `Review whether these leads had realistic budgets for your venue. The problem may be lead qualification rather than actual pricing.`
            }
          } else if (topReason[0] === 'ghosted' || topReason[0] === 'no_response') {
            actionText += `Look at your follow-up timing and cadence. Are you reaching out too late, or too many times via the same channel? Try mixing in phone calls and texts.`
          } else if (topReason[0] === 'competitor') {
            actionText += `Research what ${uniqueCompetitors.length > 0 ? uniqueCompetitors[0] : 'your competitors'} offers that you don't. Is it a real gap or a perception gap you can address in your pitch?`
          } else {
            actionText += `Look for patterns in timing, source, and stage. There may be a fixable process issue.`
          }

          const lostReasonConfidence = confidenceFromN(lostDeals.length, 8, 20)
          // Confidence gate: skip insight entirely when sample is too small to be meaningful
          if (lostReasonConfidence >= 0.3) {
          let lostReasonPriority: InsightCandidate['priority'] = topReason[1].count >= 5 ? 'high' : 'medium'
          // Downgrade priority when confidence is insufficient to support it
          if (lostReasonConfidence < 0.5 && lostReasonPriority === 'high') lostReasonPriority = 'medium'

          insights.push({
            insight_type: 'recommendation',
            category: 'lead_conversion',
            title: `${topReasonPct}% of lost deals cite "${topReasonName}", ${topReason[1].count} of last ${lostDeals.length}`,
            body: `The leading reason for lost deals is "${topReasonName}", accounting for ${topReason[1].count} of your ${lostDeals.length} recorded losses (${topReasonPct}%).${bodyExtra} ` +
              `This concentration in a single reason suggests a systematic issue rather than random loss.`,
            action: actionText,
            priority: lostReasonPriority,
            confidence: lostReasonConfidence,
            data_points: {
              total_lost_deals: lostDeals.length,
              reason_breakdown: Object.fromEntries(
                sortedReasons.map(([r, d]) => [r, { count: d.count, pct: pct(d.count, lostDeals.length) }])
              ),
              top_reason: topReason[0],
              top_reason_count: topReason[1].count,
              top_reason_stages: Object.fromEntries(stageDistribution),
              competitors_mentioned: uniqueCompetitors,
            },
            compared_to: 'internal_losses',
            expires_at: expiresInDays(30),
            narrator_facts: {
              family: 'concentration_pattern',
              framing:
                `"${topReasonName}" is cited in ${topReason[1].count} of the ` +
                `${lostDeals.length} most recent lost deals (${topReasonPct}%). ` +
                (stageDistribution.size > 0
                  ? `Stage distribution: ` +
                    [...stageDistribution.entries()]
                      .sort((a, b) => b[1] - a[1])
                      .map(([s, c]) => `${c} at ${s}`)
                      .join(', ') +
                    '. '
                  : '') +
                (uniqueCompetitors.length > 0
                  ? `Competitors mentioned: ${uniqueCompetitors.join(', ')}.`
                  : ''),
              numbers: [
                topReasonPct, topReason[1].count, lostDeals.length,
                topReasonName,
                ...Array.from(stageDistribution.entries()).flatMap(([s, c]) => [c, s]),
                ...uniqueCompetitors,
              ],
            },
          })
          } // end confidence gate
        }
      }
    }

    // --- Analyze loss by source ---
    if (!lwErr && lostWeddings && lostWeddings.length >= 5) {
      const sourceToLost = new Map<string, number>()
      const sourceToTotal = new Map<string, number>()

      // Get all weddings for comparison
      const { data: allWeddings } = await supabase
        .from('weddings')
        .select('source, status')
        .eq('venue_id', venueId)
        .not('source', 'is', null)

      if (allWeddings) {
        for (const w of allWeddings) {
          const src = w.source as string
          sourceToTotal.set(src, (sourceToTotal.get(src) || 0) + 1)
          if (w.status === 'lost') {
            sourceToLost.set(src, (sourceToLost.get(src) || 0) + 1)
          }
        }
      }

      // Find source with highest loss rate
      const sourceLossRates: { source: string; lossRate: number; total: number; lost: number }[] = []
      for (const [src, total] of sourceToTotal) {
        if (total >= 3) {
          const lost = sourceToLost.get(src) || 0
          sourceLossRates.push({ source: src, lossRate: lost / total, total, lost })
        }
      }

      if (sourceLossRates.length >= 2) {
        sourceLossRates.sort((a, b) => b.lossRate - a.lossRate)
        const worstSource = sourceLossRates[0]
        const bestSource = sourceLossRates[sourceLossRates.length - 1]

        const sourceConfidence = confidenceFromN(worstSource.total)
        if (worstSource.lossRate - bestSource.lossRate > 0.2 && worstSource.lossRate > 0.5 && sourceConfidence >= 0.3) {
          // Determine priority with confidence gate: downgrade 'high' when confidence < 0.5
          let sourcePriority: InsightCandidate['priority'] = worstSource.lossRate > 0.7 ? 'high' : 'medium'
          if (sourceConfidence < 0.5 && sourcePriority === 'high') sourcePriority = 'medium'

          const worstPct = pct(worstSource.lossRate, 1)
          const bestPct = pct(bestSource.lossRate, 1)
          insights.push({
            insight_type: 'risk',
            category: 'source_attribution',
            title: `${worstPct}% of ${worstSource.source} leads are lost, worst among your sources`,
            body: `${worstSource.source} has the highest loss rate at ${worstPct}% (${worstSource.lost} of ${worstSource.total}), ` +
              `compared to ${bestSource.source} at ${bestPct}% (${bestSource.lost} of ${bestSource.total}). ` +
              `This suggests either the leads from ${worstSource.source} aren't a good fit, or the way you handle them needs adjustment.`,
            action: `Review your ${worstSource.source} listing/profile. Are expectations being set correctly? Are you attracting the right budget and style of couple? Consider adding pre-qualifying questions.`,
            priority: sourcePriority,
            confidence: sourceConfidence,
            data_points: {
              source_loss_rates: sourceLossRates.map(s => ({
                source: s.source,
                loss_rate: pct(s.lossRate, 1),
                lost: s.lost,
                total: s.total,
              })),
            },
            compared_to: 'internal_sources',
            expires_at: expiresInDays(30),
            narrator_facts: {
              family: 'concentration_pattern',
              framing:
                `${worstSource.source} loses ${worstPct}% of its leads ` +
                `(${worstSource.lost} of ${worstSource.total}); ${bestSource.source} ` +
                `loses ${bestPct}% (${bestSource.lost} of ${bestSource.total}). ` +
                `Worst-performing source compared against best on ` +
                `${sourceLossRates.length} sources with at least 3 leads each.`,
              numbers: [
                worstPct, bestPct,
                worstSource.lost, worstSource.total,
                bestSource.lost, bestSource.total,
                sourceLossRates.length,
                worstSource.source, bestSource.source,
              ],
            },
          })
        }
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectLostDealPatterns failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 9: Portal Engagement → Quality Predictor (Readiness Score)
// ---------------------------------------------------------------------------

async function detectPortalEngagementQuality(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Get upcoming weddings within 60 days
    const now = new Date()
    const sixtyDaysOut = new Date()
    sixtyDaysOut.setDate(now.getDate() + 60)

    const { data: upcomingWeddings, error: wErr } = await supabase
      .from('weddings')
      .select('id, wedding_date, partner1_name, partner2_name, status')
      .eq('venue_id', venueId)
      .in('status', ['booked', 'confirmed'])
      .gte('wedding_date', now.toISOString().split('T')[0])
      .lte('wedding_date', sixtyDaysOut.toISOString().split('T')[0])

    if (wErr || !upcomingWeddings || upcomingWeddings.length === 0) return []

    const weddingIds = upcomingWeddings.map(w => w.id as string)

    // Fetch all planning data in parallel
    const [checklistRes, finalisationsRes, vendorsRes, contractsRes, budgetRes] = await Promise.all([
      supabase
        .from('checklist_items')
        .select('wedding_id, is_completed')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('section_finalisations')
        .select('wedding_id, couple_signed_off')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('booked_vendors')
        .select('wedding_id, is_booked')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('contracts')
        .select('wedding_id')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('budget_items')
        .select('wedding_id')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
    ])

    // Build per-wedding readiness map
    const checklistByWedding = new Map<string, { total: number; completed: number }>()
    if (checklistRes.data) {
      for (const item of checklistRes.data) {
        const wid = item.wedding_id as string
        const existing = checklistByWedding.get(wid) || { total: 0, completed: 0 }
        existing.total++
        if (item.is_completed) existing.completed++
        checklistByWedding.set(wid, existing)
      }
    }

    const finalisationsByWedding = new Map<string, number>()
    if (finalisationsRes.data) {
      for (const f of finalisationsRes.data) {
        const wid = f.wedding_id as string
        if (f.couple_signed_off) {
          finalisationsByWedding.set(wid, (finalisationsByWedding.get(wid) || 0) + 1)
        }
      }
    }

    const vendorsByWedding = new Map<string, number>()
    if (vendorsRes.data) {
      for (const v of vendorsRes.data) {
        const wid = v.wedding_id as string
        if (v.is_booked) {
          vendorsByWedding.set(wid, (vendorsByWedding.get(wid) || 0) + 1)
        }
      }
    }

    const contractsByWedding = new Map<string, number>()
    if (contractsRes.data) {
      for (const c of contractsRes.data) {
        const wid = c.wedding_id as string
        contractsByWedding.set(wid, (contractsByWedding.get(wid) || 0) + 1)
      }
    }

    const hasBudgetByWedding = new Set<string>()
    if (budgetRes.data) {
      for (const b of budgetRes.data) {
        hasBudgetByWedding.add(b.wedding_id as string)
      }
    }

    // Also get historical averages from all completed/past weddings for benchmarking
    const { data: allFinalisations } = await supabase
      .from('section_finalisations')
      .select('wedding_id, couple_signed_off')
      .eq('venue_id', venueId)

    // Guard: fewer than 5 finalisation rows means no meaningful benchmark exists.
    // Skip the entire readiness detector rather than defaulting to a made-up average.
    if (!allFinalisations || allFinalisations.length < 5) return []

    let avgFinalisations = 7 // will be overwritten below
    const perWeddingFin = new Map<string, number>()
    for (const f of allFinalisations) {
      if (f.couple_signed_off) {
        const wid = f.wedding_id as string
        perWeddingFin.set(wid, (perWeddingFin.get(wid) || 0) + 1)
      }
    }
    if (perWeddingFin.size > 0) {
      const vals = [...perWeddingFin.values()]
      avgFinalisations = vals.reduce((s, v) => s + v, 0) / vals.length
    }

    const insights: InsightCandidate[] = []
    const TOTAL_SECTIONS = 14

    for (const wedding of upcomingWeddings) {
      const wid = wedding.id as string
      const weddingDate = new Date(wedding.wedding_date as string)
      const daysToGo = Math.ceil((weddingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      const weeksToGo = Math.ceil(daysToGo / 7)

      const checklist = checklistByWedding.get(wid)
      const checklistPct = checklist && checklist.total > 0
        ? Math.round((checklist.completed / checklist.total) * 100)
        : 0

      const finalisedCount = finalisationsByWedding.get(wid) || 0
      const vendorCount = vendorsByWedding.get(wid) || 0
      const contractCount = contractsByWedding.get(wid) || 0
      const hasBudget = hasBudgetByWedding.has(wid)

      // Compute readiness score (0-100)
      const readiness = Math.min(100, Math.round(
        (checklistPct * 0.30) +  // 30% weight on checklist
        ((finalisedCount / TOTAL_SECTIONS) * 100 * 0.30) +  // 30% weight on sections
        (Math.min(vendorCount / 5, 1) * 100 * 0.15) + // 15% weight on vendors (capped at 5)
        (Math.min(contractCount / 3, 1) * 100 * 0.15) + // 15% weight on contracts (capped at 3)
        (hasBudget ? 10 : 0) // 10% weight on having a budget
      ))

      const coupleName = [wedding.partner1_name, wedding.partner2_name]
        .filter(Boolean)
        .join(' & ') || 'Unknown couple'

      const dateStr = weddingDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      const avgPct = Math.round((avgFinalisations / TOTAL_SECTIONS) * 100)

      // Generate insight if readiness is low and wedding is close
      if (readiness < 40 && weeksToGo <= 4) {
        insights.push({
          insight_type: 'risk',
          category: 'operational',
          title: `${coupleName}'s readiness score is ${readiness}/100 with ${weeksToGo} week${weeksToGo !== 1 ? 's' : ''} to go`,
          body: `Wedding for ${coupleName} on ${dateStr} has only completed ${checklistPct}% of planning checklist items and finalized ${finalisedCount} of ${TOTAL_SECTIONS} sections. ` +
            `Weddings at this stage typically have ${avgPct}% of sections complete. ` +
            `With ${vendorCount} vendor${vendorCount !== 1 ? 's' : ''} booked and ${contractCount} contract${contractCount !== 1 ? 's' : ''} on file, there are significant gaps to close.`,
          action: `Schedule an urgent coordinator check-in with ${coupleName}. Prioritize vendor confirmations and any unsigned contracts. Focus on the must-have sections first.`,
          priority: weeksToGo <= 2 ? 'critical' : 'high',
          confidence: 0.75,
          impact_score: readiness < 20 ? 90 : 70,
          data_points: {
            wedding_id: wid,
            couple_name: coupleName,
            wedding_date: wedding.wedding_date,
            days_to_go: daysToGo,
            readiness_score: readiness,
            checklist_completion_pct: checklistPct,
            sections_finalised: finalisedCount,
            total_sections: TOTAL_SECTIONS,
            vendors_booked: vendorCount,
            contracts_count: contractCount,
            has_budget: hasBudget,
            avg_finalisations: Math.round(avgFinalisations * 10) / 10,
          },
          compared_to: 'venue_average',
          expires_at: expiresInDays(7),
          narrator_facts: {
            family: 'per_couple_score',
            framing:
              `${coupleName}'s wedding is on ${dateStr}, ${weeksToGo} ` +
              `week${weeksToGo !== 1 ? 's' : ''} away. Their readiness score ` +
              `is ${readiness} out of 100. Checklist is ${checklistPct}% ` +
              `complete; ${finalisedCount} of ${TOTAL_SECTIONS} sections ` +
              `finalised; ${vendorCount} vendor${vendorCount !== 1 ? 's' : ''} ` +
              `booked; ${contractCount} contract${contractCount !== 1 ? 's' : ''} ` +
              `on file. Venue average sections-finalised at this stage: ` +
              `${avgPct}%.`,
            numbers: [
              readiness, weeksToGo, daysToGo,
              checklistPct, finalisedCount, TOTAL_SECTIONS,
              vendorCount, contractCount, avgPct,
              coupleName, dateStr,
            ],
          },
        })
      } else if (readiness < 60 && weeksToGo <= 6) {
        // Medium-priority warning for moderately behind couples
        insights.push({
          insight_type: 'risk',
          category: 'operational',
          title: `${coupleName} may need a planning check-in, readiness at ${readiness}/100`,
          body: `Wedding for ${coupleName} on ${dateStr} has a readiness score of ${readiness}/100 with ${weeksToGo} weeks to go. ` +
            `They've completed ${checklistPct}% of checklist items and finalized ${finalisedCount} of ${TOTAL_SECTIONS} sections. ` +
            `The venue average at this stage is ${avgPct}% of sections finalized.`,
          action: `Consider a gentle check-in with ${coupleName} to see if they need help with any outstanding planning items.`,
          priority: 'medium',
          confidence: 0.65,
          data_points: {
            wedding_id: wid,
            couple_name: coupleName,
            wedding_date: wedding.wedding_date,
            days_to_go: daysToGo,
            readiness_score: readiness,
            checklist_completion_pct: checklistPct,
            sections_finalised: finalisedCount,
            vendors_booked: vendorCount,
          },
          compared_to: 'venue_average',
          expires_at: expiresInDays(7),
          narrator_facts: {
            family: 'per_couple_score',
            framing:
              `${coupleName}'s wedding is on ${dateStr}, ${weeksToGo} weeks ` +
              `away. Readiness score: ${readiness} out of 100. Checklist ` +
              `${checklistPct}% complete; ${finalisedCount} of ${TOTAL_SECTIONS} ` +
              `sections finalised. Venue average at this stage: ${avgPct}%.`,
            numbers: [
              readiness, weeksToGo, checklistPct, finalisedCount,
              TOTAL_SECTIONS, vendorCount, avgPct,
              coupleName, dateStr,
            ],
          },
        })
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectPortalEngagementQuality failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 10: Guest Experience Predictor
// ---------------------------------------------------------------------------

async function detectGuestExperienceRisks(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Get upcoming weddings within 30 days
    const now = new Date()
    const thirtyDaysOut = new Date()
    thirtyDaysOut.setDate(now.getDate() + 30)

    const { data: upcomingWeddings, error: wErr } = await supabase
      .from('weddings')
      .select('id, wedding_date, partner1_name, partner2_name')
      .eq('venue_id', venueId)
      .in('status', ['booked', 'confirmed'])
      .gte('wedding_date', now.toISOString().split('T')[0])
      .lte('wedding_date', thirtyDaysOut.toISOString().split('T')[0])

    if (wErr || !upcomingWeddings || upcomingWeddings.length === 0) return []

    const weddingIds = upcomingWeddings.map(w => w.id as string)

    // Fetch guest, dietary, care, and shuttle data in parallel
    const [guestRes, allergyRes, careRes, shuttleRes] = await Promise.all([
      supabase
        .from('guest_list')
        .select('wedding_id, dietary_restrictions, rsvp_status')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('allergy_registry')
        .select('wedding_id, severity')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('guest_care_notes')
        .select('wedding_id')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('shuttle_schedule')
        .select('wedding_id, capacity')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
    ])

    // Build per-wedding guest data maps
    const guestsByWedding = new Map<string, { total: number; attending: number; hasDietary: number; missingDietary: number }>()
    if (guestRes.data) {
      for (const g of guestRes.data) {
        const wid = g.wedding_id as string
        const existing = guestsByWedding.get(wid) || { total: 0, attending: 0, hasDietary: 0, missingDietary: 0 }
        existing.total++
        if (g.rsvp_status === 'attending') existing.attending++
        if (g.dietary_restrictions && (g.dietary_restrictions as string).trim().length > 0) {
          existing.hasDietary++
        } else if (g.rsvp_status === 'attending') {
          existing.missingDietary++
        }
        guestsByWedding.set(wid, existing)
      }
    }

    const allergyByWedding = new Map<string, { total: number; severe: number }>()
    if (allergyRes.data) {
      for (const a of allergyRes.data) {
        const wid = a.wedding_id as string
        const existing = allergyByWedding.get(wid) || { total: 0, severe: 0 }
        existing.total++
        if (a.severity === 'severe' || a.severity === 'life_threatening') existing.severe++
        allergyByWedding.set(wid, existing)
      }
    }

    const careNotesByWedding = new Map<string, number>()
    if (careRes.data) {
      for (const c of careRes.data) {
        const wid = c.wedding_id as string
        careNotesByWedding.set(wid, (careNotesByWedding.get(wid) || 0) + 1)
      }
    }

    const shuttleByWedding = new Map<string, number>()
    if (shuttleRes.data) {
      for (const s of shuttleRes.data) {
        const wid = s.wedding_id as string
        shuttleByWedding.set(wid, (shuttleByWedding.get(wid) || 0) + (Number(s.capacity) || 0))
      }
    }

    const insights: InsightCandidate[] = []

    for (const wedding of upcomingWeddings) {
      const wid = wedding.id as string
      const weddingDate = new Date(wedding.wedding_date as string)
      const daysToGo = Math.ceil((weddingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      const dateStr = weddingDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
      const coupleName = [wedding.partner1_name, wedding.partner2_name]
        .filter(Boolean)
        .join(' & ') || 'the couple'

      const guests = guestsByWedding.get(wid)
      const allergies = allergyByWedding.get(wid)

      if (!guests || guests.attending === 0) continue

      // Check: dietary info completeness (<80%)
      const dietaryCompletePct = guests.attending > 0
        ? Math.round(((guests.attending - guests.missingDietary) / guests.attending) * 100)
        : 100

      if (dietaryCompletePct < 80 && guests.missingDietary >= 3) {
        insights.push({
          insight_type: 'risk',
          category: 'guest_experience',
          title: `Wedding on ${dateStr}: ${guests.missingDietary} guests missing dietary info`,
          body: `${coupleName}'s wedding on ${dateStr} has ${guests.missingDietary} attending guests without dietary restriction information (${dietaryCompletePct}% complete). ` +
            `Past events with incomplete dietary data had increased catering complaints. ` +
            (allergies && allergies.severe > 0
              ? `There are also ${allergies.severe} guests with severe allergies already registered, so gaps in dietary data are especially risky.`
              : `Completing this data before the event ensures accurate catering orders and a better guest experience.`),
          action: `Send ${coupleName} a reminder to complete dietary information for their remaining guests. The portal's allergy registry makes this easy.`,
          priority: daysToGo <= 7 && guests.missingDietary >= 10 ? 'high' : 'medium',
          confidence: 0.7,
          data_points: {
            wedding_id: wid,
            wedding_date: wedding.wedding_date,
            days_to_go: daysToGo,
            total_guests: guests.total,
            attending_guests: guests.attending,
            missing_dietary: guests.missingDietary,
            dietary_complete_pct: dietaryCompletePct,
            allergy_count: allergies?.total || 0,
            severe_allergies: allergies?.severe || 0,
          },
          compared_to: 'completeness_threshold',
          expires_at: expiresInDays(daysToGo > 0 ? Math.min(daysToGo, 14) : 3),
          narrator_facts: {
            family: 'count_with_risk',
            framing:
              `${coupleName}'s wedding on ${dateStr} has ${guests.missingDietary} ` +
              `attending guests without dietary info on file out of ` +
              `${guests.attending} attending; dietary data is ${dietaryCompletePct}% ` +
              `complete. ${daysToGo} days to go.` +
              (allergies && allergies.severe > 0
                ? ` ${allergies.severe} severe-allergy guests are already ` +
                  `registered.`
                : ''),
            numbers: [
              guests.missingDietary, guests.attending, guests.total,
              dietaryCompletePct, daysToGo,
              allergies?.severe ?? 0, allergies?.total ?? 0,
              coupleName, dateStr,
            ],
          },
        })
      }

      // Check: shuttle schedule missing when there are many guests
      const shuttleCapacity = shuttleByWedding.get(wid) || 0
      if (guests.attending >= 50 && shuttleCapacity === 0) {
        insights.push({
          insight_type: 'risk',
          category: 'guest_experience',
          title: `No shuttle scheduled for ${guests.attending}-guest wedding on ${dateStr}`,
          body: `${coupleName}'s wedding has ${guests.attending} attending guests but no shuttle service scheduled. ` +
            `For events of this size, shuttle coordination helps prevent parking issues and ensures on-time arrivals.`,
          action: `Check with ${coupleName} about guest transportation plans. If guests are staying at nearby hotels, a shuttle service could significantly improve the experience.`,
          priority: daysToGo <= 14 ? 'medium' : 'low',
          confidence: 0.5,
          data_points: {
            wedding_id: wid,
            wedding_date: wedding.wedding_date,
            attending_guests: guests.attending,
            shuttle_capacity: 0,
          },
          compared_to: 'guest_count_threshold',
          expires_at: expiresInDays(daysToGo > 0 ? Math.min(daysToGo, 14) : 3),
          narrator_facts: {
            family: 'count_with_risk',
            framing:
              `${coupleName}'s wedding on ${dateStr} has ${guests.attending} ` +
              `attending guests but no shuttle scheduled. ${daysToGo} days to go.`,
            numbers: [
              guests.attending, daysToGo, 0,
              coupleName, dateStr,
            ],
          },
        })
      }

      // Check: severe allergies flagged but no care notes
      if (allergies && allergies.severe >= 2 && (careNotesByWedding.get(wid) || 0) === 0) {
        insights.push({
          insight_type: 'risk',
          category: 'guest_experience',
          title: `${allergies.severe} severe allergies registered but no care notes for ${dateStr} wedding`,
          body: `${coupleName}'s wedding has ${allergies.severe} guests with severe or life-threatening allergies but no guest care notes documenting accommodation plans. ` +
            `Care notes help your day-of team handle dietary emergencies and ensure these guests are properly accommodated.`,
          action: `Add guest care notes for each guest with severe allergies. Include their table assignment and ensure the catering team has a list.`,
          priority: daysToGo <= 14 ? 'high' : 'medium',
          confidence: 0.8,
          data_points: {
            wedding_id: wid,
            severe_allergies: allergies.severe,
            care_notes_count: 0,
          },
          compared_to: 'safety_threshold',
          expires_at: expiresInDays(daysToGo > 0 ? Math.min(daysToGo, 7) : 3),
          narrator_facts: {
            family: 'count_with_risk',
            framing:
              `${coupleName}'s wedding on ${dateStr} has ${allergies.severe} ` +
              `guests registered with severe or life-threatening allergies, ` +
              `but zero guest care notes are on file. ${daysToGo} days to go.`,
            numbers: [
              allergies.severe, 0, daysToGo,
              coupleName, dateStr,
            ],
          },
        })
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectGuestExperienceRisks failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 11: Couple Readiness Assessment
// ---------------------------------------------------------------------------

async function detectCoupleReadiness(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Get weddings 4-12 weeks out
    const now = new Date()
    const fourWeeksOut = new Date()
    fourWeeksOut.setDate(now.getDate() + 28)
    const twelveWeeksOut = new Date()
    twelveWeeksOut.setDate(now.getDate() + 84)

    const { data: upcomingWeddings, error: wErr } = await supabase
      .from('weddings')
      .select('id, wedding_date, partner1_name, partner2_name')
      .eq('venue_id', venueId)
      .in('status', ['booked', 'confirmed'])
      .gte('wedding_date', fourWeeksOut.toISOString().split('T')[0])
      .lte('wedding_date', twelveWeeksOut.toISOString().split('T')[0])

    if (wErr || !upcomingWeddings || upcomingWeddings.length === 0) return []

    const TOTAL_SECTIONS = 14

    // Get all section finalisations to build baseline average
    const { data: allFinalisations } = await supabase
      .from('section_finalisations')
      .select('wedding_id, couple_signed_off')
      .eq('venue_id', venueId)

    // Build historical per-wedding finalisation counts
    const finByWedding = new Map<string, number>()
    if (allFinalisations) {
      for (const f of allFinalisations) {
        if (f.couple_signed_off) {
          const wid = f.wedding_id as string
          finByWedding.set(wid, (finByWedding.get(wid) || 0) + 1)
        }
      }
    }

    // Calculate overall average across all weddings (need at least 3 for meaningful baseline)
    const allCounts = [...finByWedding.values()]
    if (allCounts.length < 3) {
      // Not enough historical finalisation data to benchmark couples against — skip detector
      return []
    }
    const overallAvg = allCounts.reduce((s, v) => s + v, 0) / allCounts.length

    // Get checklist completion for upcoming weddings
    const weddingIds = upcomingWeddings.map(w => w.id as string)
    const { data: checklistData } = await supabase
      .from('checklist_items')
      .select('wedding_id, is_completed')
      .eq('venue_id', venueId)
      .in('wedding_id', weddingIds)

    const checklistByWedding = new Map<string, { total: number; completed: number }>()
    if (checklistData) {
      for (const item of checklistData) {
        const wid = item.wedding_id as string
        const existing = checklistByWedding.get(wid) || { total: 0, completed: 0 }
        existing.total++
        if (item.is_completed) existing.completed++
        checklistByWedding.set(wid, existing)
      }
    }

    const insights: InsightCandidate[] = []

    for (const wedding of upcomingWeddings) {
      const wid = wedding.id as string
      const weddingDate = new Date(wedding.wedding_date as string)
      const weeksToGo = Math.ceil((weddingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 7))

      const finalisedCount = finByWedding.get(wid) || 0
      const checklist = checklistByWedding.get(wid)
      const checklistPct = checklist && checklist.total > 0
        ? Math.round((checklist.completed / checklist.total) * 100)
        : 0

      const coupleName = [wedding.partner1_name, wedding.partner2_name]
        .filter(Boolean)
        .join(' & ') || 'This couple'

      // Compare to average — flag if significantly behind
      const avgRounded = Math.round(overallAvg * 10) / 10
      const delta = overallAvg - finalisedCount

      if (delta >= 3 && finalisedCount < TOTAL_SECTIONS * 0.5) {
        const deltaRounded = Math.round(delta * 10) / 10
        insights.push({
          insight_type: 'risk',
          category: 'readiness',
          title: `${coupleName}: ${finalisedCount} of ${TOTAL_SECTIONS} sections finalized, behind average`,
          body: `${coupleName} has finalized ${finalisedCount} of ${TOTAL_SECTIONS} sections with ${weeksToGo} weeks to go. ` +
            `The average for couples at this point is ${avgRounded}. ` +
            (checklistPct > 0 ? `Their checklist is ${checklistPct}% complete. ` : '') +
            `Consider a coordinator check-in to help them catch up and avoid last-minute stress.`,
          action: `Schedule a check-in with ${coupleName} to review remaining sections. Prioritize vendor confirmations, timeline, and guest logistics; these have the highest impact on day-of execution.`,
          priority: delta >= 5 ? 'high' : 'medium',
          confidence: confidenceFromN(allCounts.length, 5, 15),
          data_points: {
            wedding_id: wid,
            couple_name: coupleName,
            wedding_date: wedding.wedding_date,
            weeks_to_go: weeksToGo,
            sections_finalised: finalisedCount,
            total_sections: TOTAL_SECTIONS,
            venue_average: avgRounded,
            checklist_completion_pct: checklistPct,
            delta_from_average: deltaRounded,
          },
          compared_to: 'venue_average',
          expires_at: expiresInDays(7),
          narrator_facts: {
            family: 'per_couple_score',
            framing:
              `${coupleName} has finalised ${finalisedCount} of ${TOTAL_SECTIONS} ` +
              `sections with ${weeksToGo} weeks to go. Venue average for ` +
              `couples at this stage is ${avgRounded}. ` +
              (checklistPct > 0
                ? `Their checklist is ${checklistPct}% complete. `
                : '') +
              `Sample-size baseline: ${allCounts.length} historical weddings.`,
            numbers: [
              finalisedCount, TOTAL_SECTIONS, weeksToGo, avgRounded,
              checklistPct, deltaRounded, allCounts.length,
              coupleName,
            ],
          },
        })
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectCoupleReadiness failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 12: Review Prediction (Composite)
// ---------------------------------------------------------------------------

async function detectReviewPrediction(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Get weddings happening in the next 14 days (or just past within 7 days)
    const now = new Date()
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(now.getDate() - 7)
    const fourteenDaysOut = new Date()
    fourteenDaysOut.setDate(now.getDate() + 14)

    const { data: relevantWeddings, error: wErr } = await supabase
      .from('weddings')
      .select('id, wedding_date, partner1_name, partner2_name, status')
      .eq('venue_id', venueId)
      .in('status', ['booked', 'confirmed', 'completed'])
      .gte('wedding_date', sevenDaysAgo.toISOString().split('T')[0])
      .lte('wedding_date', fourteenDaysOut.toISOString().split('T')[0])

    if (wErr || !relevantWeddings || relevantWeddings.length === 0) return []

    const weddingIds = relevantWeddings.map(w => w.id as string)

    // Gather signals in parallel
    const [checklistRes, finalisationsRes, sageRes, vendorsRes, budgetRes, timelineRes] = await Promise.all([
      supabase
        .from('checklist_items')
        .select('wedding_id, is_completed')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('section_finalisations')
        .select('wedding_id, couple_signed_off')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      // Use sage_conversations count as proxy for portal visit frequency
      supabase
        .from('sage_conversations')
        .select('wedding_id')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('booked_vendors')
        .select('wedding_id, is_booked, contract_uploaded')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('budget_items')
        .select('wedding_id')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
      supabase
        .from('timeline')
        .select('wedding_id')
        .eq('venue_id', venueId)
        .in('wedding_id', weddingIds),
    ])

    // Build per-wedding signal maps
    const buildCountMap = (data: { wedding_id: unknown }[] | null): Map<string, number> => {
      const m = new Map<string, number>()
      if (data) {
        for (const row of data) {
          const wid = row.wedding_id as string
          m.set(wid, (m.get(wid) || 0) + 1)
        }
      }
      return m
    }

    const sageCountMap = buildCountMap(sageRes.data)
    const budgetCountMap = buildCountMap(budgetRes.data)
    const timelineCountMap = buildCountMap(timelineRes.data)

    const insights: InsightCandidate[] = []
    const TOTAL_SECTIONS = 14

    for (const wedding of relevantWeddings) {
      const wid = wedding.id as string
      const weddingDate = new Date(wedding.wedding_date as string)
      const isPast = weddingDate.getTime() < now.getTime()

      const coupleName = [wedding.partner1_name, wedding.partner2_name]
        .filter(Boolean)
        .join(' & ') || 'This couple'

      // Calculate composite score (0-100)
      let score = 0
      let signalCount = 0

      // Signal 1: Checklist completion (0-25 points)
      if (checklistRes.data) {
        const items = checklistRes.data.filter(i => (i.wedding_id as string) === wid)
        const completed = items.filter(i => i.is_completed).length
        const total = items.length
        if (total > 0) {
          score += (completed / total) * 25
          signalCount++
        }
      }

      // Signal 2: Section finalisations (0-25 points)
      if (finalisationsRes.data) {
        const finalized = finalisationsRes.data.filter(
          f => (f.wedding_id as string) === wid && f.couple_signed_off
        ).length
        score += (finalized / TOTAL_SECTIONS) * 25
        signalCount++
      }

      // Signal 3: Portal engagement / Sage usage (0-20 points)
      const sageCount = sageCountMap.get(wid) || 0
      score += Math.min(sageCount / 20, 1) * 20 // Cap at 20 conversations
      if (sageCount > 0) signalCount++

      // Signal 4: Vendor + contract completeness (0-15 points)
      if (vendorsRes.data) {
        const vendors = vendorsRes.data.filter(v => (v.wedding_id as string) === wid)
        const bookedVendors = vendors.filter(v => v.is_booked).length
        const withContracts = vendors.filter(v => v.contract_uploaded).length
        score += Math.min(bookedVendors / 5, 1) * 8 + Math.min(withContracts / 3, 1) * 7
        if (vendors.length > 0) signalCount++
      }

      // Signal 5: Timeline + budget tracking (0-15 points)
      const hasTimeline = (timelineCountMap.get(wid) || 0) > 0
      const hasBudget = (budgetCountMap.get(wid) || 0) > 0
      score += (hasTimeline ? 8 : 0) + (hasBudget ? 7 : 0)
      if (hasTimeline || hasBudget) signalCount++

      // Need at least 2 signals to have a meaningful prediction
      if (signalCount < 2) continue

      score = Math.round(Math.min(100, score))

      if (score > 75) {
        const actionTiming = isPast ? 'within 48 hours' : 'shortly after the event'
        const sectionsFinal = finalisationsRes.data?.filter(f => (f.wedding_id as string) === wid && f.couple_signed_off).length || 0
        insights.push({
          insight_type: 'opportunity',
          category: 'review_prediction',
          title: `${coupleName} likely to leave a positive review (score: ${score}/100)`,
          body: `Based on planning engagement, ${coupleName} scored ${score}/100 on review likelihood. ` +
            `They engaged actively with the portal (${sageCount} Sage conversations), ` +
            `${sectionsFinal} sections finalized, ` +
            `and maintained strong vendor coordination. ` +
            `Proactively requesting a review ${actionTiming} significantly increases the chance of getting one.`,
          action: `Send a personalized review request to ${coupleName} ${actionTiming}. Include a direct link to your preferred review platform. A warm, personal ask converts better than an automated email.`,
          priority: isPast ? 'high' : 'medium',
          confidence: 0.6 + (signalCount * 0.05),
          data_points: {
            wedding_id: wid,
            couple_name: coupleName,
            wedding_date: wedding.wedding_date,
            review_score: score,
            sage_conversations: sageCount,
            signal_count: signalCount,
          },
          compared_to: 'engagement_composite',
          expires_at: expiresInDays(isPast ? 7 : 21),
          narrator_facts: {
            family: 'per_couple_score',
            framing:
              `${coupleName}'s composite review-likelihood score is ${score} ` +
              `out of 100, computed across ${signalCount} engagement signals. ` +
              `Sage conversations: ${sageCount}. Sections finalised: ` +
              `${sectionsFinal}. The wedding ` +
              (isPast ? 'has already taken place.' : 'is upcoming.'),
            numbers: [
              score, signalCount, sageCount, sectionsFinal,
              coupleName,
            ],
          },
        })
      } else if (score < 40) {
        insights.push({
          insight_type: 'risk',
          category: 'review_prediction',
          title: `${coupleName}'s planning engagement is below average (score: ${score}/100)`,
          body: `${coupleName}'s portal engagement scored only ${score}/100. ` +
            `Low planning engagement sometimes correlates with less satisfaction or disengagement. ` +
            `This doesn't mean the event won't go well, but it's worth monitoring closely and addressing any issues proactively.`,
          action: `Check in with ${coupleName} to ensure they're feeling supported. After the event, personally follow up rather than relying on automated review requests.`,
          priority: 'medium',
          confidence: 0.5 + (signalCount * 0.05),
          data_points: {
            wedding_id: wid,
            couple_name: coupleName,
            wedding_date: wedding.wedding_date,
            review_score: score,
            sage_conversations: sageCount,
            signal_count: signalCount,
          },
          compared_to: 'engagement_composite',
          expires_at: expiresInDays(isPast ? 7 : 21),
          narrator_facts: {
            family: 'per_couple_score',
            framing:
              `${coupleName}'s composite review-likelihood score is ${score} ` +
              `out of 100, computed across ${signalCount} engagement signals. ` +
              `Sage conversations: ${sageCount}. The wedding ` +
              (isPast ? 'has already taken place.' : 'is upcoming.'),
            numbers: [
              score, signalCount, sageCount,
              coupleName,
            ],
          },
        })
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectReviewPrediction failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 13: Vendor Performance (requires event_feedback tables)
// ---------------------------------------------------------------------------

async function detectVendorPerformance(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Gracefully skip if the event_feedback_vendors table doesn't exist yet
    // (it's being created as migration 044)
    const { data: vendorRatings, error } = await supabase
      .from('event_feedback_vendors')
      .select(`
        vendor_name,
        vendor_type,
        rating,
        would_recommend,
        notes,
        event_feedback_id,
        event_feedback:event_feedback_id (
          venue_id
        )
      `)
      .limit(500)

    // If the table doesn't exist, the query will return an error — that's expected
    if (error) {
      // Check if it's a "relation does not exist" error — expected if migration hasn't run
      if (error.message?.includes('does not exist') || error.code === '42P01') {
        console.log('[intelligence-engine] event_feedback_vendors table not yet available — skipping Detector 13')
        return []
      }
      // Some other error — still return empty gracefully
      console.warn('[intelligence-engine] detectVendorPerformance query error:', error.message)
      return []
    }

    if (!vendorRatings || vendorRatings.length < 3) return []

    // Filter to this venue's ratings
    const venueRatings = vendorRatings.filter(r => {
      const fb = r.event_feedback as { venue_id?: string } | null
      return fb?.venue_id === venueId
    })

    if (venueRatings.length < 3) return []

    // Group by vendor name (normalized)
    const vendorStats = new Map<string, {
      name: string
      type: string
      ratings: number[]
      wouldRecommend: number
      wouldNotRecommend: number
      events: number
    }>()

    for (const rating of venueRatings) {
      const name = ((rating.vendor_name as string) || 'Unknown').trim().toLowerCase()
      const existing = vendorStats.get(name) || {
        name: rating.vendor_name as string,
        type: rating.vendor_type as string,
        ratings: [],
        wouldRecommend: 0,
        wouldNotRecommend: 0,
        events: 0,
      }
      existing.ratings.push(Number(rating.rating) || 0)
      if (rating.would_recommend === true) existing.wouldRecommend++
      if (rating.would_recommend === false) existing.wouldNotRecommend++
      existing.events++
      vendorStats.set(name, existing)
    }

    const insights: InsightCandidate[] = []

    for (const [, stats] of vendorStats) {
      if (stats.events < 2) continue

      const avgRating = stats.ratings.reduce((s, v) => s + v, 0) / stats.ratings.length
      const roundedAvg = Math.round(avgRating * 10) / 10

      // Flag underperforming vendors
      if (avgRating < 3 && stats.events >= 2) {
        insights.push({
          insight_type: 'risk',
          category: 'vendor_quality',
          title: `Vendor "${stats.name}" rated below average on last ${stats.events} events`,
          body: `${stats.name} (${stats.type}) has an average rating of ${roundedAvg}/5 across ${stats.events} events. ` +
            (stats.wouldNotRecommend > 0
              ? `${stats.wouldNotRecommend} coordinator${stats.wouldNotRecommend > 1 ? 's' : ''} would not recommend them. `
              : '') +
            `Consistently low vendor performance affects guest experience and your venue's reputation.`,
          action: `Have a candid conversation with ${stats.name} about the feedback. If performance doesn't improve, consider recommending alternatives to future couples.`,
          priority: avgRating < 2.5 ? 'high' : 'medium',
          confidence: confidenceFromN(stats.events, 3, 5),
          data_points: {
            vendor_name: stats.name,
            vendor_type: stats.type,
            avg_rating: roundedAvg,
            total_events: stats.events,
            individual_ratings: stats.ratings,
            would_recommend: stats.wouldRecommend,
            would_not_recommend: stats.wouldNotRecommend,
          },
          compared_to: 'vendor_rating_threshold',
          expires_at: expiresInDays(30),
          narrator_facts: {
            family: 'entity_outlier',
            framing:
              `Vendor "${stats.name}" (${stats.type}) is averaging ${roundedAvg} ` +
              `out of 5 across ${stats.events} events. ` +
              (stats.wouldNotRecommend > 0
                ? `${stats.wouldNotRecommend} coordinator${stats.wouldNotRecommend > 1 ? 's' : ''} ` +
                  `would not recommend them. `
                : '') +
              (stats.wouldRecommend > 0
                ? `${stats.wouldRecommend} would recommend them.`
                : ''),
            numbers: [
              roundedAvg, stats.events,
              stats.wouldRecommend, stats.wouldNotRecommend,
              5,
              stats.name, stats.type,
            ],
          },
        })
      }

      // Highlight top performers
      if (avgRating >= 4.5 && stats.events >= 3) {
        insights.push({
          insight_type: 'opportunity',
          category: 'vendor_quality',
          title: `Vendor "${stats.name}" is performing excellently, consider featuring them`,
          body: `${stats.name} (${stats.type}) has an average rating of ${roundedAvg}/5 across ${stats.events} events. ` +
            (stats.wouldRecommend > 0
              ? `${stats.wouldRecommend} coordinator${stats.wouldRecommend > 1 ? 's' : ''} would recommend them. `
              : '') +
            `Consistently high-performing vendors strengthen your venue's overall reputation.`,
          action: `Feature ${stats.name} in your vendor recommendations to couples. Consider a preferred vendor partnership if you don't have one already.`,
          priority: 'low',
          confidence: confidenceFromN(stats.events, 3, 5),
          data_points: {
            vendor_name: stats.name,
            vendor_type: stats.type,
            avg_rating: roundedAvg,
            total_events: stats.events,
            would_recommend: stats.wouldRecommend,
          },
          compared_to: 'vendor_rating_threshold',
          expires_at: expiresInDays(60),
          narrator_facts: {
            family: 'entity_outlier',
            framing:
              `Vendor "${stats.name}" (${stats.type}) is averaging ${roundedAvg} ` +
              `out of 5 across ${stats.events} events.` +
              (stats.wouldRecommend > 0
                ? ` ${stats.wouldRecommend} coordinator${stats.wouldRecommend > 1 ? 's' : ''} ` +
                  `would recommend them.`
                : ''),
            numbers: [
              roundedAvg, stats.events, stats.wouldRecommend, 5,
              stats.name, stats.type,
            ],
          },
        })
      }
    }

    return insights
  } catch (err) {
    // Catch-all for any table-not-found or unexpected errors
    console.error('[intelligence-engine] detectVendorPerformance failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 14: Timeline Adherence Patterns (requires event_feedback table)
// ---------------------------------------------------------------------------

async function detectTimelineAdherence(
  supabase: SupabaseClient,
  venueId: string
): Promise<InsightCandidate[]> {
  try {
    // Gracefully skip if event_feedback table doesn't exist yet
    const { data: feedback, error } = await supabase
      .from('event_feedback')
      .select('id, timeline_adherence, delay_phases, delay_notes, overall_rating, wedding_id')
      .eq('venue_id', venueId)
      .not('timeline_adherence', 'is', null)

    if (error) {
      if (error.message?.includes('does not exist') || error.code === '42P01') {
        console.log('[intelligence-engine] event_feedback table not yet available — skipping Detector 14')
        return []
      }
      console.warn('[intelligence-engine] detectTimelineAdherence query error:', error.message)
      return []
    }

    if (!feedback || feedback.length < 3) return []

    // Count delay phases across all events
    const phaseDelayCounts = new Map<string, number>()
    let totalWithDelays = 0
    let totalOnTime = 0
    const delayRatings: number[] = []
    const onTimeRatings: number[] = []

    for (const fb of feedback) {
      if (fb.timeline_adherence === 'on_time') {
        totalOnTime++
        if (fb.overall_rating) onTimeRatings.push(Number(fb.overall_rating))
      } else {
        totalWithDelays++
        if (fb.overall_rating) delayRatings.push(Number(fb.overall_rating))
      }

      const phases = fb.delay_phases as string[] | null
      if (phases && phases.length > 0) {
        for (const phase of phases) {
          phaseDelayCounts.set(phase, (phaseDelayCounts.get(phase) || 0) + 1)
        }
      }
    }

    const insights: InsightCandidate[] = []

    // Find phases that repeatedly cause delays
    const sortedPhases = [...phaseDelayCounts.entries()].sort((a, b) => b[1] - a[1])

    for (const [phase, count] of sortedPhases) {
      if (count < 2) continue

      const phaseName = phase.replace(/_/g, ' ')
      const bufferSuggestion = count >= 3 ? '20-minute' : '15-minute'

      const avgDelayRating = delayRatings.length > 0
        ? Math.round((delayRatings.reduce((s, v) => s + v, 0) / delayRatings.length) * 10) / 10
        : null
      const avgOntimeRating = onTimeRatings.length > 0
        ? Math.round((onTimeRatings.reduce((s, v) => s + v, 0) / onTimeRatings.length) * 10) / 10
        : null

      insights.push({
        insight_type: 'recommendation',
        category: 'operational',
        title: `Last ${count} weddings had delays during ${phaseName}`,
        body: `The "${phaseName}" phase has shown up as a delay on ${count} of your last ${feedback.length} events. ` +
          `This pattern suggests a systemic timing issue rather than a one-off problem. ` +
          (avgDelayRating !== null && avgOntimeRating !== null
            ? `Events with delays averaged a ${avgDelayRating}/5 rating vs ${avgOntimeRating}/5 for on-time events. `
            : '') +
          `Adding buffer time to this transition can prevent cascading delays through the rest of the evening.`,
        action: `Add a ${bufferSuggestion} buffer before or after ${phaseName} in your standard timeline template. Brief your day-of team to manage this transition proactively.`,
        priority: count >= 3 ? 'high' : 'medium',
        confidence: confidenceFromN(feedback.length, 5, 15),
        data_points: {
          delay_phase: phase,
          delay_count: count,
          total_events_analyzed: feedback.length,
          total_with_delays: totalWithDelays,
          total_on_time: totalOnTime,
          all_delay_phases: Object.fromEntries(sortedPhases),
          avg_delay_rating: avgDelayRating,
          avg_ontime_rating: avgOntimeRating,
        },
        compared_to: 'event_history',
        expires_at: expiresInDays(30),
        narrator_facts: {
          family: 'operational_pattern',
          framing:
            `The "${phaseName}" phase shows up as a delay on ${count} of the ` +
            `last ${feedback.length} events analysed. ` +
            (avgDelayRating !== null && avgOntimeRating !== null
              ? `Events with delays averaged ${avgDelayRating} out of 5; ` +
                `on-time events averaged ${avgOntimeRating} out of 5. `
              : '') +
            `Suggested buffer to add to the standard template: ${bufferSuggestion}.`,
          numbers: [
            count, feedback.length,
            totalWithDelays, totalOnTime,
            avgDelayRating ?? 0, avgOntimeRating ?? 0, 5,
            phaseName, bufferSuggestion,
          ],
        },
      })
    }

    // Overall timeline adherence insight
    if (totalWithDelays > 0 && feedback.length >= 5) {
      const delayRate = totalWithDelays / feedback.length
      if (delayRate > 0.5) {
        const delayRatePct = Math.round(delayRate * 100)
        const avgDelayRating = delayRatings.length > 0
          ? Number((delayRatings.reduce((s, v) => s + v, 0) / delayRatings.length).toFixed(1))
          : null
        const avgOntimeRating = onTimeRatings.length > 0
          ? Number((onTimeRatings.reduce((s, v) => s + v, 0) / onTimeRatings.length).toFixed(1))
          : null
        insights.push({
          insight_type: 'risk',
          category: 'operational',
          title: `${delayRatePct}% of recent events had timeline delays`,
          body: `${totalWithDelays} of your last ${feedback.length} events experienced timeline delays. ` +
            `A delay rate above 50% suggests your standard timeline templates may need adjustment. ` +
            (avgDelayRating !== null
              ? `Delayed events averaged ${avgDelayRating}/5 vs on-time events at ${avgOntimeRating ?? 'N/A'}/5.`
              : ''),
          action: `Review your standard timeline template against actual event timings. Consider adding 10-15 minutes of buffer between each major transition.`,
          priority: delayRate > 0.7 ? 'high' : 'medium',
          confidence: confidenceFromN(feedback.length, 5, 15),
          data_points: {
            total_events: feedback.length,
            delayed_events: totalWithDelays,
            on_time_events: totalOnTime,
            delay_rate_pct: delayRatePct,
          },
          compared_to: 'event_history',
          expires_at: expiresInDays(30),
          narrator_facts: {
            family: 'operational_pattern',
            framing:
              `${totalWithDelays} of the last ${feedback.length} events ` +
              `experienced timeline delays, a ${delayRatePct}% delay rate. ` +
              (avgDelayRating !== null && avgOntimeRating !== null
                ? `Delayed events averaged ${avgDelayRating} out of 5; ` +
                  `on-time events averaged ${avgOntimeRating} out of 5.`
                : ''),
            numbers: [
              delayRatePct, totalWithDelays, totalOnTime,
              feedback.length,
              avgDelayRating ?? 0, avgOntimeRating ?? 0, 5,
            ],
          },
        })
      }
    }

    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectTimelineAdherence failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 15 (Wave 1C): Emotional Theme Pulse
// ---------------------------------------------------------------------------
//
// Reads `aggregateAutoContextThemes` for the venue and surfaces
// wedding-industry-relevant themes that show meaningful uptake.
//
// Sensitive handling:
//   - Sensitive categories (health, grief, financial_stress,
//     family_conflict, mental_health) NEVER fire as `priority: 'high'`
//     and the narrator framing carries an explicit "counts only, do
//     not name couples" rule. Numbers-guard validates the theme counts.
//   - Insights from sensitive categories report COUNTS ONLY in the
//     framing string. Exemplar bodies are not surfaced to the LLM at
//     all (they're already redacted upstream by the rollup, and a
//     belt-and-suspenders strip here keeps the brain prompt clean).
//
// Threshold logic:
//   - Trigger when noteCount >= 4 OR weddingCount >= 3 within the
//     30d window AND there's a notable trend delta (>=50% increase OR
//     a fresh category with no prior period activity).
//   - Caps at the top 3 themes so a single run doesn't flood the
//     intelligence dashboard.

async function detectEmotionalThemes(
  supabase: SupabaseClient,
  venueId: string,
): Promise<InsightCandidate[]> {
  const insights: InsightCandidate[] = []
  try {
    const rollups = await aggregateAutoContextThemes(supabase, venueId, 30)

    // Filter to themes worth surfacing.
    const candidates = rollups
      .filter((r) => {
        const meaningful = r.noteCount >= 4 || r.weddingCount >= 3
        const trending =
          r.trendDelta >= 50 || (r.trendDelta === 100 && r.noteCount >= 3)
        return meaningful && trending
      })
      .slice(0, 3)

    for (const r of candidates) {
      const isSensitive = r.containsSensitive
      // Title structure: "8 couples mentioned cultural ceremony asks
      // this month, up 300% vs last month".
      const trendPart =
        r.trendDelta >= 999
          ? 'fresh signal vs last month'
          : r.trendDelta > 0
            ? `up ${r.trendDelta.toFixed(0)}% vs last month`
            : 'flat vs last month'
      const titleTemplate =
        `${r.weddingCount} couple${r.weddingCount === 1 ? '' : 's'} mentioned ` +
        `${r.category.replace(/_/g, ' ')} this month, ${trendPart}`
      const bodyTemplate =
        `${r.noteCount} soft-context note${r.noteCount === 1 ? '' : 's'} ` +
        `landed on ${r.category.replace(/_/g, ' ')} from ${r.weddingCount} ` +
        `distinct couple${r.weddingCount === 1 ? '' : 's'} in the last 30 days. ` +
        (isSensitive
          ? 'This is a sensitive category — review the lead profiles individually rather than acting on the aggregate.'
          : 'A meaningful uptick the venue may want to weave into its positioning.')

      // Framing for the narrator. For sensitive categories, the
      // framing explicitly forbids couple-naming. For non-sensitive
      // categories, the framing includes one short non-redacted
      // exemplar so the prose has color.
      const safeExemplar = !isSensitive
        ? r.exemplars.find((e) => !e.sensitive)?.body ?? ''
        : ''
      const framingParts = [
        `${r.weddingCount} couples mentioned ${r.category.replace(/_/g, ' ')} ` +
          `in ${r.noteCount} soft-context notes over the last 30 days.`,
        `Trend vs the prior 30 days: ${r.trendDelta.toFixed(0)} percent change.`,
      ]
      if (isSensitive) {
        framingParts.push(
          'This category is SENSITIVE. Report counts only. Do NOT name any couple. Do NOT quote any exemplar.',
        )
      } else if (safeExemplar) {
        framingParts.push(
          `One representative observation: "${safeExemplar.slice(0, 140)}".`,
        )
      }

      // Numbers allowlist for the guard.
      const numbers: Array<number | string> = [
        r.noteCount,
        r.weddingCount,
        Math.abs(Math.round(r.trendDelta)),
        30,
        '30 days',
        '30-day',
      ]

      insights.push({
        insight_type: 'emotional_theme',
        category: 'emotional',
        title: titleTemplate,
        body: bodyTemplate,
        action: isSensitive
          ? 'Review the lead profiles individually. Consider quiet outreach via Sage where appropriate. Do not surface this theme in any outbound copy.'
          : `Consider how the venue's marketing copy, vendor mix, or onboarding content reflects ${r.category.replace(/_/g, ' ')}.`,
        // Sensitive themes are never priority high — they're informational,
        // not action-prompting at the venue level.
        priority: isSensitive ? 'low' : r.weddingCount >= 5 ? 'medium' : 'low',
        confidence: confidenceFromN(r.noteCount, 4, 12),
        data_points: {
          category: r.category,
          note_count: r.noteCount,
          wedding_count: r.weddingCount,
          trend_delta_pct: r.trendDelta,
          contains_sensitive: r.containsSensitive,
          // We deliberately do NOT include exemplar bodies in
          // data_points for sensitive themes. This keeps the audit
          // trail clean and prevents downstream surfaces from
          // accidentally rendering them.
          window_days: 30,
        },
        compared_to: 'prior_30d',
        expires_at: expiresInDays(14),
        narrator_facts: {
          family: 'emotional_theme_pulse',
          framing: framingParts.join(' '),
          numbers,
        },
      })
    }
    return insights
  } catch (err) {
    console.error('[intelligence-engine] detectEmotionalThemes failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Detector 16 (Wave 4 Phase 3): Emotional themes from forensic profiles
// ---------------------------------------------------------------------------
//
// Same shape as detectEmotionalThemes but reads from
// `couple_identity_profile.profile.emotional_truths` instead of the
// auto-context theme rollup. The forensic record carries higher-quality
// signals (LLM-judged + verbatim evidence quotes per claim) so this
// aggregator is the preferred source going forward; Phase 4 will retire
// the keyword-driven detectEmotionalThemes loop after a brief A/B
// window.
//
// Runs alongside detectEmotionalThemes during Phase 3 so we can compare
// outputs before retiring the legacy detector. The venue_config
// feature_flags.theme_aggregator_source flag drives which detector(s)
// participate:
//   - 'profiles' : only this aggregator runs
//   - 'extraction' : only the legacy detectEmotionalThemes runs
//   - 'both' (default) : both run; the runner-side title-dedupe collapses
//     duplicate insights so we don't surface the same theme twice
//
// Sensitivity policy mirrors detectEmotionalThemes: sensitive themes
// COUNT only at the venue level, never name couples, never echo
// evidence_quote in the framing.
async function aggregateEmotionalThemesFromProfiles(
  supabase: SupabaseClient,
  venueId: string,
  windowDays: number = 30,
): Promise<InsightCandidate[]> {
  const insights: InsightCandidate[] = []
  try {
    const sinceIso = daysAgoISO(windowDays)
    const priorSinceIso = daysAgoISO(windowDays * 2)

    // Pull profiles whose last_signal_at falls inside the active window.
    // Falling back to last_reconstructed_at when last_signal_at is NULL.
    const { data: rows, error } = await supabase
      .from('couple_identity_profile')
      .select('wedding_id, profile, last_signal_at, last_reconstructed_at')
      .eq('venue_id', venueId)
      .gte('last_reconstructed_at', priorSinceIso)
      .limit(2000)
    if (error) {
      console.error(
        '[intelligence-engine] aggregateEmotionalThemesFromProfiles fetch failed:',
        error.message,
      )
      return []
    }
    if (!rows || rows.length === 0) return []

    type ProfileRow = {
      wedding_id: string
      profile: {
        emotional_truths: Array<{
          theme: string
          evidence_quote: string
          confidence_0_100: number
          sensitive: boolean
        }>
      } | null
      last_signal_at: string | null
      last_reconstructed_at: string | null
    }

    interface ThemeBucket {
      noteCount: number
      weddingIds: Set<string>
      sensitiveSeen: boolean
      safeExemplar: string | null
    }
    const active = new Map<string, ThemeBucket>()
    const prior = new Map<string, ThemeBucket>()

    for (const r of rows as ProfileRow[]) {
      const profile = r.profile
      if (!profile || !Array.isArray(profile.emotional_truths)) continue
      const stamp = r.last_signal_at ?? r.last_reconstructed_at
      if (!stamp) continue
      const stampMs = Date.parse(stamp)
      if (!Number.isFinite(stampMs)) continue
      const sinceMs = Date.parse(sinceIso)
      const priorSinceMs = Date.parse(priorSinceIso)
      const inActive = stampMs >= sinceMs
      const inPrior = stampMs >= priorSinceMs && stampMs < sinceMs
      if (!inActive && !inPrior) continue
      const target = inActive ? active : prior
      for (const t of profile.emotional_truths) {
        if (!t || typeof t.theme !== 'string') continue
        const key = t.theme.trim().toLowerCase()
        if (!key) continue
        let bucket = target.get(key)
        if (!bucket) {
          bucket = {
            noteCount: 0,
            weddingIds: new Set(),
            sensitiveSeen: false,
            safeExemplar: null,
          }
          target.set(key, bucket)
        }
        bucket.noteCount += 1
        bucket.weddingIds.add(r.wedding_id)
        if (t.sensitive) bucket.sensitiveSeen = true
        else if (!bucket.safeExemplar && typeof t.evidence_quote === 'string') {
          bucket.safeExemplar = t.evidence_quote
        }
      }
    }

    for (const [theme, bucket] of active.entries()) {
      const meaningful = bucket.noteCount >= 4 || bucket.weddingIds.size >= 3
      if (!meaningful) continue
      const priorBucket = prior.get(theme)
      const priorCount = priorBucket?.noteCount ?? 0
      const trendDelta =
        priorCount === 0
          ? bucket.noteCount > 0
            ? 100
            : 0
          : ((bucket.noteCount - priorCount) / priorCount) * 100
      const isFresh = priorCount === 0 && bucket.noteCount >= 3
      const trending = trendDelta >= 50 || isFresh
      if (!trending) continue

      const themeLabel = theme.replace(/_/g, ' ')
      const trendPart = isFresh
        ? 'fresh signal vs last month'
        : trendDelta > 0
          ? `up ${trendDelta.toFixed(0)}% vs last month`
          : 'flat vs last month'
      const titleTemplate =
        `${bucket.weddingIds.size} couple${bucket.weddingIds.size === 1 ? '' : 's'} reconstructed ` +
        `${themeLabel} this month, ${trendPart}`
      const bodyTemplate =
        `${bucket.noteCount} forensic emotional-truth observation${bucket.noteCount === 1 ? '' : 's'} ` +
        `landed on ${themeLabel} from ${bucket.weddingIds.size} ` +
        `distinct couple${bucket.weddingIds.size === 1 ? '' : 's'} in the last ${windowDays} days. ` +
        (bucket.sensitiveSeen
          ? 'This is a sensitive category — review the lead profiles individually rather than acting on the aggregate.'
          : 'A meaningful uptick the venue may want to weave into its positioning.')

      const framingParts = [
        `${bucket.weddingIds.size} couples have ${themeLabel} as a forensic ` +
          `emotional truth in their reconstructed identity profile, across ` +
          `${bucket.noteCount} observation${bucket.noteCount === 1 ? '' : 's'} ` +
          `over the last ${windowDays} days.`,
        `Trend vs the prior ${windowDays} days: ${trendDelta.toFixed(0)} percent change.`,
      ]
      if (bucket.sensitiveSeen) {
        framingParts.push(
          'This category is SENSITIVE. Report counts only. Do NOT name any couple. Do NOT quote any exemplar.',
        )
      } else if (bucket.safeExemplar) {
        framingParts.push(
          `One representative observation: "${bucket.safeExemplar.slice(0, 140)}".`,
        )
      }

      const numbers: Array<number | string> = [
        bucket.noteCount,
        bucket.weddingIds.size,
        Math.abs(Math.round(trendDelta)),
        windowDays,
        `${windowDays} days`,
        `${windowDays}-day`,
      ]

      insights.push({
        insight_type: 'emotional_theme',
        category: 'emotional',
        title: titleTemplate,
        body: bodyTemplate,
        action: bucket.sensitiveSeen
          ? 'Review the lead profiles individually. Consider quiet outreach via Sage where appropriate. Do not surface this theme in any outbound copy.'
          : `Consider how the venue's marketing copy, vendor mix, or onboarding content reflects ${themeLabel}.`,
        priority: bucket.sensitiveSeen
          ? 'low'
          : bucket.weddingIds.size >= 5
            ? 'medium'
            : 'low',
        confidence: confidenceFromN(bucket.noteCount, 4, 12),
        data_points: {
          category: theme,
          note_count: bucket.noteCount,
          wedding_count: bucket.weddingIds.size,
          trend_delta_pct: trendDelta,
          contains_sensitive: bucket.sensitiveSeen,
          window_days: windowDays,
          source: 'couple_identity_profile',
        },
        compared_to: `prior_${windowDays}d`,
        expires_at: expiresInDays(14),
        narrator_facts: {
          family: 'emotional_theme_pulse',
          framing: framingParts.join(' '),
          numbers,
        },
      })
    }
    return insights
  } catch (err) {
    console.error(
      '[intelligence-engine] aggregateEmotionalThemesFromProfiles failed:',
      err,
    )
    return []
  }
}

// Wrapper around aggregateEmotionalThemesFromProfiles so the runner
// can include it in the detector array with the same signature
// (supabase, venueId) -> Promise<InsightCandidate[]>.
async function detectEmotionalThemesFromProfiles(
  supabase: SupabaseClient,
  venueId: string,
): Promise<InsightCandidate[]> {
  return aggregateEmotionalThemesFromProfiles(supabase, venueId, 30)
}

// Public re-export so callers can drive the aggregator directly when
// running ad-hoc audits.
export { aggregateEmotionalThemesFromProfiles }

// ---------------------------------------------------------------------------
// Read the venue's theme-aggregator-source flag to decide which detector(s)
// participate this run. Defaults to 'both' — keeps the legacy detector
// firing alongside the new one during Phase 3 so we can A/B before Phase 4
// retires the keyword loop.
// ---------------------------------------------------------------------------
async function loadThemeAggregatorSource(
  supabase: SupabaseClient,
  venueId: string,
): Promise<'profiles' | 'extraction' | 'both'> {
  try {
    const { data } = await supabase
      .from('venue_config')
      .select('feature_flags')
      .eq('venue_id', venueId)
      .maybeSingle()
    const flags = ((data as { feature_flags?: Record<string, unknown> } | null)
      ?.feature_flags ?? {}) as Record<string, unknown>
    const v = flags.theme_aggregator_source
    if (v === 'profiles' || v === 'extraction' || v === 'both') return v
  } catch {
    // Best-effort. Fall through to default.
  }
  return 'both'
}

// ---------------------------------------------------------------------------
// Analysis Runner
// ---------------------------------------------------------------------------

/**
 * Run all intelligence detectors for a venue. Deduplicates against recent
 * insights (same title within last 7 days), inserts new ones, and marks
 * expired ones.
 *
 * Returns the number of new insights generated.
 */
export async function runIntelligenceAnalysis(venueId: string): Promise<number> {
  const supabase = createServiceClient()

  // Wave 4 Phase 3: theme aggregator source is venue-flag-controlled so
  // we can A/B between the legacy keyword detector and the forensic-
  // profile aggregator before Phase 4 retires the keyword loop.
  const themeSource = await loadThemeAggregatorSource(supabase, venueId)

  const detectors: Array<
    (s: SupabaseClient, v: string) => Promise<InsightCandidate[]>
  > = [
    detectResponseTimeConversion,
    detectDayOfWeekPatterns,
    detectSourceQuality,
    detectCoordinatorPatterns,
    detectCoupleBehaviorPredictors,
    detectPipelineStalls,
    detectSeasonalOpportunities,
    detectLostDealPatterns,
    // --- Operational pattern detectors (Phase 2) ---
    detectPortalEngagementQuality,
    detectGuestExperienceRisks,
    detectCoupleReadiness,
    detectReviewPrediction,
    detectVendorPerformance,
    detectTimelineAdherence,
  ]
  if (themeSource === 'extraction' || themeSource === 'both') {
    // --- Emotional theme detector (Wave 1C, 2026-05-09) — keyword-driven
    detectors.push(detectEmotionalThemes)
  }
  if (themeSource === 'profiles' || themeSource === 'both') {
    // --- Emotional theme aggregator (Wave 4 Phase 3, 2026-05-09) — forensic
    detectors.push(detectEmotionalThemesFromProfiles)
  }

  const candidates: InsightCandidate[] = []
  for (const detector of detectors) {
    try {
      const results = await detector(supabase, venueId)
      candidates.push(...results)
    } catch (err) {
      console.error(`[intelligence-engine] Detector ${detector.name} failed:`, err)
    }
  }

  if (candidates.length === 0) {
    // Still mark expired insights
    await markExpiredInsights(supabase, venueId)
    return 0
  }

  // Deduplicate: skip any candidate whose title matches an insight
  // created for this venue within the last 7 days
  const sevenDaysAgo = daysAgoISO(7)
  const { data: recentInsights } = await supabase
    .from('intelligence_insights')
    .select('title')
    .eq('venue_id', venueId)
    .gte('created_at', sevenDaysAgo)

  const recentTitles = new Set(
    (recentInsights ?? []).map(i => (i.title as string).toLowerCase())
  )

  const newCandidates = candidates.filter(
    c => !recentTitles.has(c.title.toLowerCase())
  )

  if (newCandidates.length > 0) {
    // LLM narration pass — for every candidate that exposes
    // narrator_facts, hand the structured facts to Sonnet via
    // narrateIntelligenceInsight; the result replaces title / body /
    // action and stamps narration_source='llm'. When the cost-ceiling
    // gate is closed, the LLM call fails, or numbers-guard rejects the
    // output, the detector's deterministic template surfaces unchanged
    // and narration_source='template'. Per AI-VS-TEMPLATED-AUDIT.md
    // finding #1 (2026-05-09).
    //
    // Sequential rather than parallel: each narration is one Sonnet
    // call gated by the same cost-ceiling. Running in parallel could
    // blow through the ceiling before later iterations get to check
    // it. Worst-case 14 * 1-2s ≈ 30s on a fully-templated cron run;
    // acceptable for a once-daily cron path. Mirrors the same
    // sequential design used in correlation-narration.ts.
    const narratedRows: Array<Record<string, unknown>> = []
    let llmNarrated = 0
    let templateFallback = 0

    for (const c of newCandidates) {
      let title = c.title
      let body = c.body
      let action = c.action ?? null
      let narrationSource: 'llm' | 'template' = 'template'
      let llmModelUsed: string | null = null
      let promptVersionUsed: string | null = null

      if (c.narrator_facts) {
        try {
          const narrated = await narrateIntelligenceInsight({
            venueId,
            facts: {
              family: c.narrator_facts.family,
              framing: c.narrator_facts.framing,
              numbers: c.narrator_facts.numbers,
              category: c.category,
              fallback: { title: c.title, body: c.body, action: c.action ?? null },
            },
          })
          title = narrated.narration.title
          body = narrated.narration.body
          action = narrated.narration.action
          narrationSource = narrated.source
          if (narrated.source === 'llm') {
            llmNarrated++
            llmModelUsed = INTEL_ENGINE_NARRATION_MODEL
            promptVersionUsed = BRAIN_INTEL_ENGINE_PROMPT_VERSION
          } else {
            templateFallback++
          }
        } catch (err) {
          // Defense-in-depth: a thrown error inside the narrator
          // (which already has its own try/catch) shouldn't drop the
          // insight — surface the template instead.
          console.error(
            '[intelligence-engine] narration unexpected throw, surfacing template:',
            err,
          )
          templateFallback++
        }
      } else {
        templateFallback++
      }

      narratedRows.push({
        venue_id: venueId,
        insight_type: c.insight_type,
        category: c.category,
        title,
        body,
        action,
        priority: c.priority,
        confidence: c.confidence,
        impact_score: c.impact_score ?? null,
        data_points: c.data_points,
        compared_to: c.compared_to ?? null,
        status: 'new',
        expires_at: c.expires_at ?? null,
        narration_source: narrationSource,
        llm_model_used: llmModelUsed,
        prompt_version_used: promptVersionUsed,
      })
    }

    const { error } = await supabase
      .from('intelligence_insights')
      .insert(narratedRows)

    if (error) {
      console.error('[intelligence-engine] Failed to insert insights:', error.message)
    } else {
      console.log(
        `[intelligence-engine] Generated ${newCandidates.length} new insights for venue ${venueId} ` +
        `(${candidates.length - newCandidates.length} deduplicated, ` +
        `${llmNarrated} LLM-narrated, ${templateFallback} template-fallback)`
      )
    }
  }

  // Mark expired insights
  await markExpiredInsights(supabase, venueId)

  return newCandidates.length
}

/**
 * Mark insights past their expiry date as expired.
 */
async function markExpiredInsights(supabase: SupabaseClient, venueId: string): Promise<void> {
  try {
    const now = new Date().toISOString()
    const { error } = await supabase
      .from('intelligence_insights')
      .update({ status: 'expired', updated_at: now })
      .eq('venue_id', venueId)
      .lt('expires_at', now)
      .in('status', ['new', 'seen'])

    if (error) {
      console.error('[intelligence-engine] Failed to expire insights:', error.message)
    }
  } catch (err) {
    console.error('[intelligence-engine] markExpiredInsights failed:', err)
  }
}

// ---------------------------------------------------------------------------
// Run for all venues
// ---------------------------------------------------------------------------

/**
 * Run intelligence analysis for every active venue.
 * Returns a map of venueId -> number of insights generated.
 */
export async function runAllVenueIntelligence(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (error || !venues || venues.length === 0) {
    console.warn('[intelligence-engine] No active venues found')
    return {}
  }

  // Cost-ceiling gate: intelligence analysis is the most LLM-heavy
  // cron path (multiple Sonnet calls per venue per run for insight
  // generation). Skip paused venues per Playbook 21.4.3.
  const venueIds = venues.map((v) => v.id as string)
  const { filterActiveVenues } = await import('@/lib/services/cost-ceiling')
  const { active, skipped } = await filterActiveVenues(venueIds, {
    workType: 'intelligence_analysis',
  })
  if (skipped.length > 0) {
    console.log(`[intelligence-engine] Skipping ${skipped.length} paused venue(s); running ${active.length}`)
  }

  const results: Record<string, number> = {}

  for (const id of active) {
    try {
      results[id] = await runIntelligenceAnalysis(id)
    } catch (err) {
      console.error(`[intelligence-engine] Analysis failed for venue ${id}:`, err)
      results[id] = 0
    }
  }

  return results
}
