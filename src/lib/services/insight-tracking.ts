/**
 * Bloom House: Insight-Action-Result Tracking
 *
 * Implements the feedback loop that measures whether acting on
 * intelligence insights actually improved outcomes.
 *
 * Flow:
 *   1. Coordinator acts on an insight -> captureBaseline records current metric
 *   2. After measurement_window_days -> measureOutcome re-measures metric
 *   3. Verdict is set: improved | no_change | declined | insufficient_data
 *
 * Metric sources vary by insight category:
 *   - response_time    -> avg response time from weddings
 *   - lead_conversion  -> booking rate from weddings
 *   - team_performance -> consultant_metrics
 *   - source_attribution -> source_attribution table
 *   - seasonal          -> booking count from weddings
 *   - couple_behavior   -> engagement points from engagement_events
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InsightOutcome {
  id: string
  insight_id: string
  venue_id: string
  action_taken: string
  acted_at: string
  baseline_metric: string
  baseline_value: number
  baseline_period_start: string
  baseline_period_end: string
  outcome_value: number | null
  outcome_period_start: string | null
  outcome_period_end: string | null
  outcome_measured_at: string | null
  improvement_pct: number | null
  verdict: 'improved' | 'unchanged' | 'declined' | 'pending' | null
  created_at: string
}

// Category -> measurement window in days
const MEASUREMENT_WINDOWS: Record<string, number> = {
  response_time: 14,
  lead_conversion: 30,
  team_performance: 14,
  source_attribution: 30,
  seasonal: 30,
  couple_behavior: 30,
  pricing: 30,
  capacity: 30,
  competitive: 30,
  weather: 14,
  market: 30,
}

// Category -> metric name for display
const METRIC_NAMES: Record<string, string> = {
  response_time: 'avg_response_time_minutes',
  lead_conversion: 'conversion_rate',
  team_performance: 'team_metric',
  source_attribution: 'source_roi',
  seasonal: 'monthly_bookings',
  couple_behavior: 'engagement_score',
  pricing: 'avg_booking_value',
  capacity: 'capacity_utilization',
  competitive: 'market_position',
  weather: 'weather_impact',
  market: 'market_metric',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgoDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}

function todayDate(): string {
  return new Date().toISOString().split('T')[0]
}

// ---------------------------------------------------------------------------
// Metric capture by category
// ---------------------------------------------------------------------------

/**
 * Measure the current value of a metric for a given category and venue.
 * Returns the metric value and the period it was measured over.
 */
async function measureMetric(
  venueId: string,
  category: string,
  windowDays: number = 30
): Promise<{ value: number; periodStart: string; periodEnd: string }> {
  const supabase = createServiceClient()
  const periodStart = daysAgoDate(windowDays)
  const periodEnd = todayDate()

  switch (category) {
    case 'response_time': {
      // Average response time in minutes
      const { data } = await supabase
        .from('weddings')
        .select('inquiry_date, first_response_at')
        .eq('venue_id', venueId)
        .not('first_response_at', 'is', null)
        .not('inquiry_date', 'is', null)
        .gte('inquiry_date', periodStart)
        .lte('inquiry_date', periodEnd)

      if (!data || data.length === 0) {
        return { value: 0, periodStart, periodEnd }
      }

      const totalMinutes = data.reduce((sum, w) => {
        const diff =
          (new Date(w.first_response_at as string).getTime() -
            new Date(w.inquiry_date as string).getTime()) /
          60_000
        return sum + Math.max(0, diff)
      }, 0)

      return {
        value: totalMinutes / data.length,
        periodStart,
        periodEnd,
      }
    }

    case 'lead_conversion': {
      // Conversion rate: booked / total inquiries
      const { count: totalCount } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('created_at', periodStart)
        .lte('created_at', periodEnd)

      const { count: bookedCount } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .in('status', ['booked', 'completed'])
        .gte('created_at', periodStart)
        .lte('created_at', periodEnd)

      const total = totalCount ?? 0
      const booked = bookedCount ?? 0
      const rate = total > 0 ? booked / total : 0

      return { value: rate, periodStart, periodEnd }
    }

    case 'team_performance': {
      // Average from consultant_metrics (if exists), fallback to response time
      const { data: metrics } = await supabase
        .from('consultant_metrics')
        .select('response_time_avg, conversion_rate')
        .eq('venue_id', venueId)
        .order('calculated_at', { ascending: false })
        .limit(1)

      if (metrics && metrics.length > 0) {
        // Use conversion rate as the team metric
        return {
          value: Number(metrics[0].conversion_rate) || 0,
          periodStart,
          periodEnd,
        }
      }

      // Fallback: use response time
      return measureMetric(venueId, 'response_time', windowDays)
    }

    case 'source_attribution': {
      // Overall ROI from source_attribution
      const { data: sources } = await supabase
        .from('source_attribution')
        .select('roi')
        .eq('venue_id', venueId)
        .order('calculated_at', { ascending: false })
        .limit(10)

      if (!sources || sources.length === 0) {
        return { value: 0, periodStart, periodEnd }
      }

      const avgRoi =
        sources.reduce((sum, s) => sum + (Number(s.roi) || 0), 0) / sources.length

      return { value: avgRoi, periodStart, periodEnd }
    }

    case 'seasonal':
    case 'capacity': {
      // Monthly booking count
      const { count } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('status', 'booked')
        .gte('booked_at', periodStart)
        .lte('booked_at', periodEnd)

      return { value: count ?? 0, periodStart, periodEnd }
    }

    case 'couple_behavior': {
      // Average engagement score
      const { data: events } = await supabase
        .from('engagement_events')
        .select('points')
        .eq('venue_id', venueId)
        .gte('created_at', periodStart)
        .lte('created_at', periodEnd)

      if (!events || events.length === 0) {
        return { value: 0, periodStart, periodEnd }
      }

      const avgPoints =
        events.reduce((sum, e) => sum + (Number(e.points) || 0), 0) / events.length

      return { value: avgPoints, periodStart, periodEnd }
    }

    case 'pricing': {
      // Average booking value
      const { data: bookings } = await supabase
        .from('weddings')
        .select('booking_value')
        .eq('venue_id', venueId)
        .in('status', ['booked', 'completed'])
        .gte('booked_at', periodStart)
        .lte('booked_at', periodEnd)

      if (!bookings || bookings.length === 0) {
        return { value: 0, periodStart, periodEnd }
      }

      const avgValue =
        bookings.reduce((sum, b) => sum + (Number(b.booking_value) || 0), 0) / bookings.length

      return { value: avgValue, periodStart, periodEnd }
    }

    default: {
      // Fallback: use lead conversion rate
      return measureMetric(venueId, 'lead_conversion', windowDays)
    }
  }
}

// ---------------------------------------------------------------------------
// recordInsightAction — called when coordinator acts on an insight
// ---------------------------------------------------------------------------

/**
 * Record that a coordinator has acted on an insight. Captures the current
 * baseline metric value and creates an insight_outcomes row for tracking.
 */
export async function recordInsightAction(
  insightId: string,
  venueId: string,
  actionTaken: string
): Promise<InsightOutcome | null> {
  const supabase = createServiceClient()

  // 1. Read the insight to determine its category
  const { data: insight, error: insightError } = await supabase
    .from('intelligence_insights')
    .select('id, category, data_points')
    .eq('id', insightId)
    .eq('venue_id', venueId)
    .single()

  if (insightError || !insight) {
    console.error('[insight-tracking] Insight not found:', insightId, insightError?.message)
    return null
  }

  const category = insight.category as string
  const windowDays = MEASUREMENT_WINDOWS[category] ?? 30
  const metricName = METRIC_NAMES[category] ?? 'metric'

  // 2. Capture the current baseline metric
  const baseline = await measureMetric(venueId, category, windowDays)

  // 3. Insert insight_outcomes row
  const { data: outcome, error: insertError } = await supabase
    .from('insight_outcomes')
    .insert({
      insight_id: insightId,
      venue_id: venueId,
      action_taken: actionTaken,
      acted_at: new Date().toISOString(),
      baseline_metric: metricName,
      baseline_value: baseline.value,
      baseline_period_start: baseline.periodStart,
      baseline_period_end: baseline.periodEnd,
      verdict: 'pending',
    })
    .select()
    .single()

  if (insertError) {
    console.error('[insight-tracking] Failed to insert outcome:', insertError.message)
    return null
  }

  // 4. Mark the insight as acted_on
  await supabase
    .from('intelligence_insights')
    .update({
      status: 'acted_on',
      acted_on_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', insightId)

  console.log(
    `[insight-tracking] Recorded action on insight ${insightId}, ` +
    `baseline ${metricName}=${baseline.value.toFixed(2)}, ` +
    `window=${windowDays}d`
  )

  return outcome as InsightOutcome
}

// ---------------------------------------------------------------------------
// measureInsightOutcomes — called by cron to measure results
// ---------------------------------------------------------------------------

/**
 * Check all pending insight_outcomes whose measurement window has elapsed.
 * Re-measures the metric, calculates improvement, and sets the verdict.
 *
 * Returns the number of outcomes measured.
 */
export async function measureInsightOutcomes(venueId?: string): Promise<number> {
  const supabase = createServiceClient()

  // Find outcomes that are pending and past their measurement window
  let query = supabase
    .from('insight_outcomes')
    .select('*, intelligence_insights!inner(category)')
    .eq('verdict', 'pending')
    .is('outcome_measured_at', null)

  if (venueId) {
    query = query.eq('venue_id', venueId)
  }

  const { data: pendingOutcomes, error } = await query

  if (error) {
    console.error('[insight-tracking] Failed to fetch pending outcomes:', error.message)
    return 0
  }

  if (!pendingOutcomes || pendingOutcomes.length === 0) {
    return 0
  }

  let measuredCount = 0

  for (const outcome of pendingOutcomes) {
    const category = (outcome.intelligence_insights as { category: string })?.category ?? 'lead_conversion'
    const windowDays = MEASUREMENT_WINDOWS[category] ?? 30

    // Check if measurement window has elapsed
    const actedAt = new Date(outcome.acted_at as string)
    const windowEnd = new Date(actedAt.getTime() + windowDays * 86_400_000)

    if (windowEnd > new Date()) {
      // Window hasn't elapsed yet, skip
      continue
    }

    try {
      // Re-measure the metric
      const current = await measureMetric(
        outcome.venue_id as string,
        category,
        windowDays
      )

      const baselineValue = Number(outcome.baseline_value) || 0

      // Calculate improvement
      let improvementPct: number
      if (baselineValue === 0) {
        improvementPct = current.value > 0 ? 100 : 0
      } else {
        improvementPct = ((current.value - baselineValue) / Math.abs(baselineValue)) * 100
      }

      // For response_time, improvement is negative (lower is better)
      const isLowerBetter = category === 'response_time'
      const effectiveImprovement = isLowerBetter ? -improvementPct : improvementPct

      // Determine verdict
      let verdict: string
      if (Math.abs(effectiveImprovement) <= 10) {
        verdict = 'unchanged'
      } else if (effectiveImprovement > 10) {
        verdict = 'improved'
      } else {
        verdict = 'declined'
      }

      // Update the outcome row
      const { error: updateError } = await supabase
        .from('insight_outcomes')
        .update({
          outcome_value: current.value,
          outcome_period_start: current.periodStart,
          outcome_period_end: current.periodEnd,
          outcome_measured_at: new Date().toISOString(),
          improvement_pct: effectiveImprovement,
          verdict,
        })
        .eq('id', outcome.id)

      if (updateError) {
        console.error(`[insight-tracking] Failed to update outcome ${outcome.id}:`, updateError.message)
        continue
      }

      console.log(
        `[insight-tracking] Measured outcome ${outcome.id}: ` +
        `${baselineValue.toFixed(2)} -> ${current.value.toFixed(2)} ` +
        `(${effectiveImprovement.toFixed(1)}% = ${verdict})`
      )

      measuredCount++
    } catch (err) {
      console.error(`[insight-tracking] Failed to measure outcome ${outcome.id}:`, err)
    }
  }

  return measuredCount
}

// ---------------------------------------------------------------------------
// getOutcomeForInsight — look up the outcome for an insight (if any)
// ---------------------------------------------------------------------------

/**
 * Retrieve the outcome record for a given insight, if one exists.
 */
export async function getOutcomeForInsight(
  insightId: string
): Promise<InsightOutcome | null> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('insight_outcomes')
    .select('*')
    .eq('insight_id', insightId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[insight-tracking] Failed to fetch outcome:', error.message)
    return null
  }

  return data as InsightOutcome | null
}

// ---------------------------------------------------------------------------
// getOutcomesForVenue — all outcomes for a venue (for ROI views)
// ---------------------------------------------------------------------------

/**
 * Retrieve all insight outcomes for a venue, ordered by most recent.
 */
export async function getOutcomesForVenue(
  venueId: string,
  limit: number = 50
): Promise<InsightOutcome[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('insight_outcomes')
    .select('*')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[insight-tracking] Failed to fetch outcomes:', error.message)
    return []
  }

  return (data ?? []) as InsightOutcome[]
}
