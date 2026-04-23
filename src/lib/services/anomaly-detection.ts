/**
 * Bloom House: Anomaly Detection Service
 *
 * Compares current venue metrics against baselines (prior period of same length)
 * and generates alerts when deviations exceed thresholds.
 *
 * Metrics monitored:
 *   - inquiry_volume: count of new inquiries
 *   - response_time: avg minutes to first response
 *   - tour_conversion: tours / inquiries
 *   - booking_rate: bookings / tours
 *   - avg_booking_value: mean booking value
 *   - lost_deal_rate: lost / total inquiries
 *
 * For warning/critical severity, calls AI to explain probable causes
 * and suggest concrete actions.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Severity = 'info' | 'warning' | 'critical'

interface MetricConfig {
  threshold: number
  description: string
}

interface MetricValues {
  current: number
  baseline: number
}

interface AICause {
  cause: string
  likelihood: 'high' | 'medium' | 'low'
  action: string
}

interface AIExplanation {
  explanation: string
  causes: AICause[]
}

interface AnomalyAlert {
  id: string
  venue_id: string
  alert_type: string
  metric_name: string
  current_value: number
  baseline_value: number
  change_percent: number
  severity: Severity
  ai_explanation: string | null
  causes: AICause[] | null
  acknowledged: boolean
  created_at: string
  venues?: { name: string | null } | null
}

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

const METRICS: Record<string, MetricConfig> = {
  inquiry_volume: { threshold: 0.25, description: 'count of new inquiries' },
  response_time: { threshold: 1.0, description: 'avg minutes to first response' },
  tour_conversion: { threshold: 0.20, description: 'tours / inquiries ratio' },
  booking_rate: { threshold: 0.25, description: 'bookings / tours ratio' },
  avg_booking_value: { threshold: 0.20, description: 'average booking value' },
  lost_deal_rate: { threshold: 0.30, description: 'lost deals / total inquiries ratio' },
  engagement_rate: { threshold: 0.25, description: 'Engagement rate per inquiry' },
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

// ---------------------------------------------------------------------------
// Metric queries
// ---------------------------------------------------------------------------

/**
 * Compute a single metric's value for a venue within a date range.
 * Returns null if the metric cannot be computed (e.g. no data in range).
 */
async function queryMetric(
  venueId: string,
  metricName: string,
  periodStart: string,
  periodEnd: string
): Promise<number | null> {
  const supabase = createServiceClient()

  switch (metricName) {
    // ----- inquiry_volume: count weddings with inquiry_date in period -----
    case 'inquiry_volume': {
      const { count, error } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)

      if (error) {
        console.error(`[anomaly] Error querying inquiry_volume:`, error.message)
        return null
      }
      return count ?? 0
    }

    // ----- response_time: avg (first_response_at - inquiry_date) in minutes -----
    case 'response_time': {
      const { data, error } = await supabase
        .from('weddings')
        .select('inquiry_date, first_response_at')
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)
        .not('first_response_at', 'is', null)

      if (error) {
        console.error(`[anomaly] Error querying response_time:`, error.message)
        return null
      }
      if (!data || data.length === 0) return null

      const totalMinutes = data.reduce((sum, row) => {
        const inquiry = new Date(row.inquiry_date as string).getTime()
        const response = new Date(row.first_response_at as string).getTime()
        return sum + (response - inquiry) / 60_000
      }, 0)

      return totalMinutes / data.length
    }

    // ----- tour_conversion: count(tour_date not null) / count(inquiry_date) -----
    case 'tour_conversion': {
      const { count: totalCount, error: totalError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)

      if (totalError) {
        console.error(`[anomaly] Error querying tour_conversion total:`, totalError.message)
        return null
      }
      if (!totalCount || totalCount === 0) return null

      const { count: tourCount, error: tourError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)
        .not('tour_date', 'is', null)

      if (tourError) {
        console.error(`[anomaly] Error querying tour_conversion tours:`, tourError.message)
        return null
      }

      return (tourCount ?? 0) / totalCount
    }

    // ----- booking_rate: count(booked_at not null) / count(tour_date not null) -----
    case 'booking_rate': {
      const { count: tourCount, error: tourError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)
        .not('tour_date', 'is', null)

      if (tourError) {
        console.error(`[anomaly] Error querying booking_rate tours:`, tourError.message)
        return null
      }
      if (!tourCount || tourCount === 0) return null

      const { count: bookedCount, error: bookedError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)
        .not('booked_at', 'is', null)

      if (bookedError) {
        console.error(`[anomaly] Error querying booking_rate bookings:`, bookedError.message)
        return null
      }

      return (bookedCount ?? 0) / tourCount
    }

    // ----- avg_booking_value: avg(booking_value) where booked_at in period -----
    case 'avg_booking_value': {
      const { data, error } = await supabase
        .from('weddings')
        .select('booking_value')
        .eq('venue_id', venueId)
        .gte('booked_at', periodStart)
        .lt('booked_at', periodEnd)
        .not('booking_value', 'is', null)

      if (error) {
        console.error(`[anomaly] Error querying avg_booking_value:`, error.message)
        return null
      }
      if (!data || data.length === 0) return null

      const total = data.reduce((sum, row) => sum + Number(row.booking_value), 0)
      return total / data.length
    }

    // ----- lost_deal_rate: count(status='lost') / count(*) in period -----
    case 'lost_deal_rate': {
      const { count: totalCount, error: totalError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)

      if (totalError) {
        console.error(`[anomaly] Error querying lost_deal_rate total:`, totalError.message)
        return null
      }
      if (!totalCount || totalCount === 0) return null

      const { count: lostCount, error: lostError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)
        .eq('status', 'lost')

      if (lostError) {
        console.error(`[anomaly] Error querying lost_deal_rate lost:`, lostError.message)
        return null
      }

      return (lostCount ?? 0) / totalCount
    }

    // ----- engagement_rate: engagement events / inquiry weddings -----
    // Connects the Agent's heat mapping data into anomaly detection.
    // A drop in engagement rate may indicate couples are losing interest
    // or the portal/emails aren't driving interaction.
    case 'engagement_rate': {
      const { count: engagementCount, error: engError } = await supabase
        .from('engagement_events')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('created_at', periodStart)
        .lt('created_at', periodEnd)

      if (engError) {
        console.error(`[anomaly] Error querying engagement_rate events:`, engError.message)
        return null
      }

      const { count: inquiryCount, error: inqError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)

      if (inqError) {
        console.error(`[anomaly] Error querying engagement_rate inquiries:`, inqError.message)
        return null
      }
      if (!inquiryCount || inquiryCount === 0) return null

      return (engagementCount ?? 0) / inquiryCount
    }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// AI explanation
// ---------------------------------------------------------------------------

/**
 * Ask AI to explain a metric anomaly and suggest causes + actions.
 */
async function getAIExplanation(
  venueId: string,
  metricName: string,
  currentValue: number,
  baselineValue: number,
  changePercent: number
): Promise<AIExplanation | null> {
  try {
    const result = await callAIJson<AIExplanation>({
      systemPrompt: `You are a wedding venue operations analyst. When given a metric anomaly,
provide a concise explanation and 2-3 possible causes ranked by likelihood, each with one
concrete action the venue team can take this week.

Return JSON with this exact shape:
{
  "explanation": "Brief plain-English summary of what the anomaly means",
  "causes": [
    {
      "cause": "Description of the possible cause",
      "likelihood": "high" | "medium" | "low",
      "action": "One specific action to investigate or address this"
    }
  ]
}

Be specific to the wedding venue industry. Reference seasonality, marketing channels,
competitor behavior, and operational factors where relevant.`,

      userPrompt: `Anomaly detected for a wedding venue:

Metric: ${metricName} (${METRICS[metricName]?.description ?? metricName})
Current period value: ${formatMetricValue(metricName, currentValue)}
Baseline (prior period): ${formatMetricValue(metricName, baselineValue)}
Change: ${changePercent > 0 ? '+' : ''}${(changePercent * 100).toFixed(1)}%

Provide 2-3 possible causes ranked by likelihood, each with one concrete action.`,

      maxTokens: 600,
      temperature: 0.3,
      venueId,
      taskType: 'anomaly_explanation',
    })

    return result
  } catch (err) {
    console.error(`[anomaly] AI explanation failed for ${metricName}:`, err)
    return null
  }
}

/**
 * Format a metric value for display in the AI prompt.
 */
function formatMetricValue(metricName: string, value: number): string {
  switch (metricName) {
    case 'inquiry_volume':
      return `${Math.round(value)} inquiries`
    case 'response_time':
      return `${Math.round(value)} minutes`
    case 'tour_conversion':
    case 'booking_rate':
    case 'lost_deal_rate':
      return `${(value * 100).toFixed(1)}%`
    case 'avg_booking_value':
      return `$${Math.round(value).toLocaleString()}`
    case 'engagement_rate':
      return `${(value * 100).toFixed(1)}% engagement per inquiry`
    default:
      return String(value)
  }
}

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Run anomaly detection for a single venue. Compares the last `periodDays`
 * against the prior period of equal length. Creates alerts for any metric
 * where the change exceeds its threshold.
 *
 * Severity logic:
 *   |change| > threshold * 2  → 'critical'
 *   |change| > threshold      → 'warning'
 *   otherwise                 → skip (no alert)
 *
 * For warning/critical, calls AI to explain causes.
 * Returns the array of created alert rows.
 */
export async function runAnomalyDetection(
  venueId: string,
  periodDays = 7
): Promise<AnomalyAlert[]> {
  const now = new Date().toISOString()
  const periodStart = daysAgo(periodDays)
  const baselineStart = daysAgo(periodDays * 2)

  const createdAlerts: AnomalyAlert[] = []
  const supabase = createServiceClient()

  for (const [metricName, config] of Object.entries(METRICS)) {
    // Query current and baseline periods
    const [current, baseline] = await Promise.all([
      queryMetric(venueId, metricName, periodStart, now),
      queryMetric(venueId, metricName, baselineStart, periodStart),
    ])

    // Skip if either period has no data
    if (current === null || baseline === null) continue

    // Compute change percent (avoid division by zero)
    if (baseline === 0) continue
    const changePercent = (current - baseline) / baseline
    const absChange = Math.abs(changePercent)

    // Determine severity
    let severity: Severity
    if (absChange > config.threshold * 2) {
      severity = 'critical'
    } else if (absChange > config.threshold) {
      severity = 'warning'
    } else {
      continue // Within normal range — no alert
    }

    // Get AI explanation for warning/critical
    const aiResult = await getAIExplanation(
      venueId,
      metricName,
      current,
      baseline,
      changePercent
    )

    // Determine alert type based on direction
    const direction = changePercent > 0 ? 'increase' : 'decrease'
    const alertType = `${metricName}_${direction}`

    // Insert the alert
    const { data, error } = await supabase
      .from('anomaly_alerts')
      .insert({
        venue_id: venueId,
        alert_type: alertType,
        metric_name: metricName,
        current_value: current,
        baseline_value: baseline,
        change_percent: changePercent,
        severity,
        ai_explanation: aiResult?.explanation ?? null,
        causes: aiResult?.causes ?? null,
        acknowledged: false,
      })
      .select()
      .single()

    if (error) {
      console.error(`[anomaly] Failed to insert alert for ${metricName}:`, error.message)
      continue
    }

    createdAlerts.push(data as AnomalyAlert)

    console.log(
      `[anomaly] ${severity.toUpperCase()} alert: ${metricName} ` +
        `${direction} ${(absChange * 100).toFixed(1)}% for venue ${venueId}`
    )
  }

  return createdAlerts
}

// ---------------------------------------------------------------------------
// Availability anomaly detection
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface MonthBucket {
  year: number
  month: number // 0-indexed
  bookedSlots: number
  totalSlots: number
  saturdayBooked: number
  saturdayTotal: number
  nonSatBooked: number
  nonSatTotal: number
  earliestDate: Date
}

/**
 * Detect seasonal availability anomalies: months with unusually high demand,
 * or months where Saturdays are filling fast while weekdays remain wide open.
 *
 * Reads venue_availability for the next 12 months. Uses static templates for
 * ai_explanation (no AI call). Idempotent via causes->>'source'='availability'
 * + causes->>'month' lookup. No-ops cleanly if the venue has no availability
 * rows yet (the data may simply not have been touched by the coordinator).
 */
export async function detectAvailabilityAnomalies(
  venueId: string
): Promise<AnomalyAlert[]> {
  const supabase = createServiceClient()
  const createdAlerts: AnomalyAlert[] = []

  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setMonth(end.getMonth() + 12)

  const startIso = start.toISOString().slice(0, 10)
  const endIso = end.toISOString().slice(0, 10)

  const { data: rows, error } = await supabase
    .from('venue_availability')
    .select('date, status, max_events, booked_count')
    .eq('venue_id', venueId)
    .gte('date', startIso)
    .lt('date', endIso)

  if (error) {
    console.error(`[anomaly] Error querying venue_availability:`, error.message)
    return []
  }
  if (!rows || rows.length === 0) {
    // Nothing to analyse. Stay quiet, don't throw.
    return []
  }

  // Group rows by calendar month, tallying booked vs capacity per month and
  // separately for Saturdays vs non-Saturdays.
  const buckets = new Map<string, MonthBucket>()
  for (const r of rows) {
    const date = new Date(r.date as string)
    if (isNaN(date.getTime())) continue

    const year = date.getUTCFullYear()
    const month = date.getUTCMonth()
    const key = `${year}-${String(month + 1).padStart(2, '0')}`

    const max = Math.max(1, Number(r.max_events) || 1)
    const booked = Math.min(max, Math.max(0, Number(r.booked_count) || 0))
    const isSaturday = date.getUTCDay() === 6

    let b = buckets.get(key)
    if (!b) {
      b = {
        year,
        month,
        bookedSlots: 0,
        totalSlots: 0,
        saturdayBooked: 0,
        saturdayTotal: 0,
        nonSatBooked: 0,
        nonSatTotal: 0,
        earliestDate: date,
      }
      buckets.set(key, b)
    }
    b.bookedSlots += booked
    b.totalSlots += max
    if (isSaturday) {
      b.saturdayBooked += booked
      b.saturdayTotal += max
    } else {
      b.nonSatBooked += booked
      b.nonSatTotal += max
    }
    if (date < b.earliestDate) b.earliestDate = date
  }

  const msPerDay = 24 * 60 * 60 * 1000

  for (const [key, b] of buckets.entries()) {
    if (b.totalSlots <= 0) continue

    const monthName = MONTH_NAMES[b.month]
    const fillRate = b.bookedSlots / b.totalSlots
    const daysOut = Math.round((b.earliestDate.getTime() - now.getTime()) / msPerDay)

    // Rule A: overall fill > 80% with the month still more than 60 days out.
    const isHighDemand = fillRate > 0.80 && daysOut > 60

    // Rule B: Saturdays > 90% filled AND non-Saturdays < 30%.
    const satFill = b.saturdayTotal > 0 ? b.saturdayBooked / b.saturdayTotal : 0
    const nonSatFill = b.nonSatTotal > 0 ? b.nonSatBooked / b.nonSatTotal : 0
    const isSaturdayDemand =
      b.saturdayTotal > 0 &&
      b.nonSatTotal > 0 &&
      satFill > 0.90 &&
      nonSatFill < 0.30

    // Prefer the more specific Saturday signal over the general one when both
    // trip, so the venue sees one actionable alert, not two.
    let alertType: string | null = null
    let explanation: string | null = null
    if (isSaturdayDemand) {
      alertType = 'availability_saturday_demand'
      explanation = `Saturdays in ${monthName} are filling fast; weekdays still wide open.`
    } else if (isHighDemand) {
      alertType = 'availability_high_demand'
      explanation =
        `Unusually high demand for ${monthName} dates. ` +
        `Currently ${b.bookedSlots}/${b.totalSlots} slots filled.`
    }

    if (!alertType || !explanation) continue

    // Idempotent upsert: look for an existing row with the same source+month.
    const { data: existing, error: existingErr } = await supabase
      .from('anomaly_alerts')
      .select('id, acknowledged')
      .eq('venue_id', venueId)
      .eq('alert_type', alertType)
      .filter('causes->>source', 'eq', 'availability')
      .filter('causes->>month', 'eq', key)
      .limit(1)

    if (existingErr) {
      console.error(`[anomaly] Error checking availability alert:`, existingErr.message)
      continue
    }

    const causes = [
      {
        source: 'availability',
        month: key,
        monthName,
        fillRate: Number(fillRate.toFixed(3)),
        saturdayFillRate: Number(satFill.toFixed(3)),
        nonSaturdayFillRate: Number(nonSatFill.toFixed(3)),
        bookedSlots: b.bookedSlots,
        totalSlots: b.totalSlots,
        action: isSaturdayDemand
          ? `Promote weekday weddings in ${monthName} or consider a Friday/Sunday incentive.`
          : `Review pricing and inventory for ${monthName} before the remaining dates sell out.`,
      },
    ]

    const severity: Severity = isSaturdayDemand || fillRate > 0.90 ? 'warning' : 'info'

    if (existing && existing.length > 0) {
      const { data: updated, error: updateErr } = await supabase
        .from('anomaly_alerts')
        .update({
          current_value: b.bookedSlots,
          baseline_value: b.totalSlots,
          change_percent: fillRate,
          severity,
          ai_explanation: explanation,
          causes,
        })
        .eq('id', existing[0].id)
        .select()
        .single()

      if (updateErr) {
        console.error(`[anomaly] Failed to update availability alert:`, updateErr.message)
        continue
      }
      if (updated) createdAlerts.push(updated as AnomalyAlert)
      continue
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('anomaly_alerts')
      .insert({
        venue_id: venueId,
        alert_type: alertType,
        metric_name: 'availability_fill_rate',
        current_value: b.bookedSlots,
        baseline_value: b.totalSlots,
        change_percent: fillRate,
        severity,
        ai_explanation: explanation,
        causes,
        acknowledged: false,
      })
      .select()
      .single()

    if (insertErr) {
      console.error(`[anomaly] Failed to insert availability alert:`, insertErr.message)
      continue
    }
    if (inserted) createdAlerts.push(inserted as AnomalyAlert)
  }

  return createdAlerts
}

// ---------------------------------------------------------------------------
// Run for all venues
// ---------------------------------------------------------------------------

/**
 * Run anomaly detection for every active venue.
 * Returns a map of venueId -> array of created alerts.
 */
export async function runAllVenueAnomalies(): Promise<Record<string, AnomalyAlert[]>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('active', true)

  if (error || !venues || venues.length === 0) {
    console.warn('[anomaly] No active venues found')
    return {}
  }

  const results: Record<string, AnomalyAlert[]> = {}

  for (const venue of venues) {
    const id = venue.id as string
    const metricAlerts = await runAnomalyDetection(id)

    // Availability anomalies are additive: they live in the same table so
    // they surface alongside metric anomalies on the dashboard + /intel/anomalies.
    // Guarded so a single venue's failure can't nuke the whole cron run.
    let availabilityAlerts: AnomalyAlert[] = []
    try {
      availabilityAlerts = await detectAvailabilityAnomalies(id)
    } catch (err) {
      console.error(`[anomaly] Availability detection failed for venue ${id}:`, err)
    }

    results[id] = [...metricAlerts, ...availabilityAlerts]
  }

  return results
}

// ---------------------------------------------------------------------------
// Alert queries
// ---------------------------------------------------------------------------

/**
 * Get all unacknowledged alerts for a venue, most recent first.
 */
export async function getActiveAlerts(venueId: string): Promise<AnomalyAlert[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('anomaly_alerts')
    .select('*, venues:venue_id(name)')
    .eq('venue_id', venueId)
    .eq('acknowledged', false)
    .order('created_at', { ascending: false })

  if (error) {
    console.error(`[anomaly] Error fetching active alerts:`, error.message)
    return []
  }

  return (data ?? []) as AnomalyAlert[]
}

/**
 * Mark an alert as acknowledged by a specific user.
 */
export async function acknowledgeAlert(
  alertId: string,
  userId: string
): Promise<boolean> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('anomaly_alerts')
    .update({
      acknowledged: true,
      acknowledged_by: userId,
    })
    .eq('id', alertId)

  if (error) {
    console.error(`[anomaly] Error acknowledging alert ${alertId}:`, error.message)
    return false
  }

  return true
}
