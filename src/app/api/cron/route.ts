import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { fetchAllVenueTrends } from '@/lib/services/trends'
import { fetchWeatherForecast } from '@/lib/services/weather'
import { fetchAllEconomicIndicators } from '@/lib/services/economics'
import { runAllVenueAnomalies } from '@/lib/services/anomaly-detection'
import {
  generateWeeklyBriefing,
  generateMonthlyBriefing,
} from '@/lib/services/briefings'
import { generateWeeklyDigest } from '@/lib/services/weekly-digest'
import { measureInsightOutcomes } from '@/lib/services/insight-tracking'
import { sendAllDigests } from '@/lib/services/daily-digest'
import { processAllVenueFollowUps } from '@/lib/services/follow-up-sequences'
import { applyDailyDecay } from '@/lib/services/heat-mapping'
import { processAllNewEmails, flushPendingAutoSends } from '@/lib/services/email-pipeline'
import { runAllVenueIntelligence } from '@/lib/services/intelligence-engine'
import { createNotification } from '@/lib/services/admin-notifications'
import { learnFiltersForAllVenues } from '@/lib/services/inbox-filters'
import { computeAllVenueHealth } from '@/lib/services/venue-health-compute'
import { persistDropoffInsights } from '@/lib/services/quality-signals'
import { refreshAllCensusData } from '@/lib/services/census-ingest'

// ---------------------------------------------------------------------------
// Valid job names
// ---------------------------------------------------------------------------

const VALID_JOBS = [
  'email_poll',
  'heat_decay',
  'trends_refresh',
  'weather_forecast',
  'economic_indicators',
  'anomaly_detection',
  'intelligence_analysis',
  'weekly_briefing',
  'weekly_digest',
  'monthly_briefing',
  'daily_digest',
  'follow_up_sequences',
  'attribution_refresh',
  'post_event_feedback_check',
  'outcome_measurement',
  'inbox_filter_learning',
  'venue_health_compute',
  'quality_signals_refresh',
  'census_refresh',
] as const

type JobName = (typeof VALID_JOBS)[number]

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function runJob(job: JobName): Promise<unknown> {
  switch (job) {
    case 'email_poll':
      return pollEmailsAllVenues()

    case 'heat_decay':
      return applyDecayAllVenues()

    case 'trends_refresh':
      return fetchAllVenueTrends()

    case 'weather_forecast':
      return fetchWeatherForAllVenues()

    case 'economic_indicators':
      return fetchAllEconomicIndicators()

    case 'anomaly_detection':
      return runAllVenueAnomalies()

    case 'intelligence_analysis':
      return runAllVenueIntelligence()

    case 'weekly_briefing':
      return generateBriefingsForAllVenues('weekly')

    case 'weekly_digest':
      return generateDigestsForAllVenues()

    case 'monthly_briefing':
      return generateBriefingsForAllVenues('monthly')

    case 'daily_digest':
      return sendAllDigests()

    case 'follow_up_sequences':
      return processAllVenueFollowUps()

    case 'attribution_refresh':
      return refreshAttributionAllVenues()

    case 'post_event_feedback_check':
      return checkPostEventFeedback()

    case 'outcome_measurement':
      return measureOutcomesAllVenues()

    case 'inbox_filter_learning':
      return learnFiltersForAllVenues()

    case 'venue_health_compute':
      return computeAllVenueHealth()

    case 'quality_signals_refresh':
      // Two-email drop-offs per venue. We iterate active venues and
      // fire-and-forget the insights upsert. Keep this cheap — runs
      // weekly, not daily.
      return refreshQualitySignalsAllVenues()

    case 'census_refresh':
      // Monthly pull of Census ACS5 demographics. Rolls county data up
      // to state + national rows in market_intelligence. Never throws —
      // per-state failures are logged inside the service.
      return refreshAllCensusData()
  }
}

async function refreshQualitySignalsAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()
  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')
  const out: Record<string, number> = {}
  for (const v of venues ?? []) {
    try {
      out[v.id as string] = await persistDropoffInsights(v.id as string)
    } catch (err) {
      console.error(`[quality-signals] failed for ${v.id}:`, err)
      out[v.id as string] = -1
    }
  }
  return out
}

/**
 * Poll emails for all venues with Gmail connected.
 *
 * Gmail tokens live in two places:
 *   - venue_config.gmail_tokens (legacy single-inbox flow)
 *   - gmail_connections (multi-Gmail, current flow — sync_enabled + status='active')
 *
 * Union venue ids from both so a venue that only exists in gmail_connections
 * isn't silently skipped when the legacy column is null.
 */
async function pollEmailsAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const venueIds = new Set<string>()

  const { data: legacyRows } = await supabase
    .from('venue_config')
    .select('venue_id')
    .not('gmail_tokens', 'is', null)

  for (const row of legacyRows ?? []) {
    if (row.venue_id) venueIds.add(row.venue_id as string)
  }

  const { data: connectionRows } = await supabase
    .from('gmail_connections')
    .select('venue_id')
    .eq('sync_enabled', true)
    .eq('status', 'active')

  for (const row of connectionRows ?? []) {
    if (row.venue_id) venueIds.add(row.venue_id as string)
  }

  if (venueIds.size === 0) return {}

  const results: Record<string, number> = {}
  for (const id of venueIds) {
    try {
      const result = await processAllNewEmails(id)
      // Flush any pending auto-sends whose 5-minute delay has elapsed
      const flushed = await flushPendingAutoSends(id)
      results[id] = result.processed + flushed
    } catch (err) {
      console.error(`[cron] Email poll failed for venue ${id}:`, err)
      results[id] = 0
    }
  }
  return results
}

/**
 * Apply heat score decay to all venues.
 */
async function applyDecayAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (!venues || venues.length === 0) return {}

  const results: Record<string, number> = {}
  for (const v of venues) {
    const id = v.id as string
    try {
      const affected = await applyDailyDecay(id)
      results[id] = affected
    } catch (err) {
      console.error(`[cron] Heat decay failed for venue ${id}:`, err)
      results[id] = 0
    }
  }
  return results
}

/**
 * Refresh source attribution calculations for all venues.
 */
async function refreshAttributionAllVenues(): Promise<Record<string, boolean>> {
  const supabase = createServiceClient()

  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (!venues || venues.length === 0) return {}

  const results: Record<string, boolean> = {}
  for (const v of venues) {
    const id = v.id as string
    try {
      // Calculate source attribution from weddings + marketing_spend
      const { data: weddings } = await supabase
        .from('weddings')
        .select('source, status, booking_value, created_at')
        .eq('venue_id', id)

      const { data: spend } = await supabase
        .from('marketing_spend')
        .select('source, amount')
        .eq('venue_id', id)

      if (!weddings) { results[id] = false; continue }

      // Group by source
      const sources = new Map<string, { inquiries: number; tours: number; bookings: number; revenue: number; spend: number }>()

      for (const w of weddings) {
        const src = w.source || 'unknown'
        const existing = sources.get(src) || { inquiries: 0, tours: 0, bookings: 0, revenue: 0, spend: 0 }
        existing.inquiries++
        if (['tour_scheduled', 'tour_completed', 'proposal_sent', 'booked', 'completed'].includes(w.status)) existing.tours++
        if (['booked', 'completed'].includes(w.status)) {
          existing.bookings++
          existing.revenue += Number(w.booking_value) || 0
        }
        sources.set(src, existing)
      }

      // Add spend data
      for (const s of (spend || [])) {
        const existing = sources.get(s.source) || { inquiries: 0, tours: 0, bookings: 0, revenue: 0, spend: 0 }
        existing.spend += Number(s.amount) || 0
        sources.set(s.source, existing)
      }

      // Upsert source_attribution records
      const now = new Date().toISOString()
      for (const [source, data] of sources) {
        const costPerInquiry = data.inquiries > 0 ? data.spend / data.inquiries : 0
        const costPerBooking = data.bookings > 0 ? data.spend / data.bookings : 0
        const conversionRate = data.inquiries > 0 ? data.bookings / data.inquiries : 0
        const roi = data.spend > 0 ? (data.revenue - data.spend) / data.spend : 0

        await supabase.from('source_attribution').upsert({
          venue_id: id,
          source,
          period_start: new Date(new Date().getFullYear(), 0, 1).toISOString(),
          period_end: now,
          spend: data.spend,
          inquiries: data.inquiries,
          tours: data.tours,
          bookings: data.bookings,
          revenue: data.revenue,
          cost_per_inquiry: costPerInquiry,
          cost_per_booking: costPerBooking,
          conversion_rate: conversionRate,
          roi,
          calculated_at: now,
        }, { onConflict: 'venue_id,source,period_start' })
      }

      results[id] = true
    } catch (err) {
      console.error(`[cron] Attribution refresh failed for venue ${id}:`, err)
      results[id] = false
    }
  }
  return results
}

/**
 * Fetch weather forecasts for all venues that have lat/lng configured.
 */
async function fetchWeatherForAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)

  if (error || !venues || venues.length === 0) {
    console.warn('[cron] No venues with lat/lng found for weather forecast')
    return {}
  }

  const results: Record<string, number> = {}

  for (const venue of venues) {
    const id = venue.id as string
    try {
      const records = await fetchWeatherForecast(id)
      results[id] = records.length
    } catch (err) {
      console.error(`[cron] Weather forecast failed for venue ${id}:`, err)
      results[id] = 0
    }
  }

  return results
}

/**
 * Generate weekly intelligence digests for all active venues.
 * Runs on Mondays — checks day of week before generating.
 * Creates an admin notification when the digest is ready.
 */
async function generateDigestsForAllVenues(): Promise<Record<string, boolean>> {
  // Only generate on Mondays
  const dayOfWeek = new Date().getDay()
  if (dayOfWeek !== 1) {
    console.log('[cron] Weekly digest skipped — not Monday (day=' + dayOfWeek + ')')
    return {}
  }

  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (error || !venues || venues.length === 0) {
    console.warn('[cron] No active venues found for weekly digest')
    return {}
  }

  const results: Record<string, boolean> = {}

  for (const venue of venues) {
    const id = venue.id as string
    try {
      await generateWeeklyDigest(id)

      // Create notification that the digest is ready
      await createNotification({
        venueId: id,
        type: 'weekly_digest',
        title: 'Your weekly intelligence digest is ready',
        body: 'Review your leads, performance trends, and actionable insights for this week.',
      })

      results[id] = true
    } catch (err) {
      console.error(`[cron] Weekly digest failed for venue ${id}:`, err)
      results[id] = false
    }
  }

  return results
}

/**
 * Measure insight outcomes for all active venues.
 * Checks pending outcomes whose measurement window has elapsed.
 */
async function measureOutcomesAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (error || !venues || venues.length === 0) {
    return {}
  }

  const results: Record<string, number> = {}

  for (const venue of venues) {
    const id = venue.id as string
    try {
      const measured = await measureInsightOutcomes(id)
      results[id] = measured
    } catch (err) {
      console.error(`[cron] Outcome measurement failed for venue ${id}:`, err)
      results[id] = 0
    }
  }

  return results
}

/**
 * Generate briefings for all venues that have a briefing_email configured.
 */
async function generateBriefingsForAllVenues(
  type: 'weekly' | 'monthly'
): Promise<Record<string, boolean>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .not('briefing_email', 'is', null)

  if (error || !venues || venues.length === 0) {
    console.warn(`[cron] No venues with briefing_email found for ${type} briefing`)
    return {}
  }

  const results: Record<string, boolean> = {}

  for (const venue of venues) {
    const id = venue.id as string
    try {
      if (type === 'weekly') {
        await generateWeeklyBriefing(id)
      } else {
        await generateMonthlyBriefing(id)
      }
      results[id] = true
    } catch (err) {
      console.error(`[cron] ${type} briefing failed for venue ${id}:`, err)
      results[id] = false
    }
  }

  return results
}

/**
 * Check for weddings that happened 3 days ago and don't have feedback yet.
 * Creates a notification prompting the coordinator to submit feedback.
 */
async function checkPostEventFeedback(): Promise<{ notified: number }> {
  const supabase = createServiceClient()

  // Find weddings where wedding_date was 3 days ago, status is booked or completed,
  // and no event_feedback row exists yet
  const threeDaysAgo = new Date()
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
  const dateStr = threeDaysAgo.toISOString().split('T')[0]

  const { data: weddings, error } = await supabase
    .from('weddings')
    .select(`
      id,
      venue_id,
      wedding_date,
      status
    `)
    .eq('wedding_date', dateStr)
    .in('status', ['booked', 'completed'])

  if (error || !weddings || weddings.length === 0) {
    return { notified: 0 }
  }

  // Filter out weddings that already have feedback
  const weddingIds = weddings.map((w) => w.id as string)
  const { data: existingFeedback } = await supabase
    .from('event_feedback')
    .select('wedding_id')
    .in('wedding_id', weddingIds)

  const feedbackWeddingIds = new Set(
    (existingFeedback ?? []).map((f) => f.wedding_id as string)
  )

  const needsFeedback = weddings.filter(
    (w) => !feedbackWeddingIds.has(w.id as string)
  )

  if (needsFeedback.length === 0) {
    return { notified: 0 }
  }

  let notified = 0

  for (const w of needsFeedback) {
    const weddingId = w.id as string
    const venueId = w.venue_id as string

    // Get couple names for the notification
    const { data: people } = await supabase
      .from('people')
      .select('first_name, role')
      .eq('wedding_id', weddingId)

    const coupleNames = (people ?? [])
      .filter((p) =>
        ['partner1', 'partner2', 'bride', 'groom', 'partner'].includes(p.role)
      )
      .map((p) => p.first_name)
      .join(' & ')

    const label = coupleNames || 'the couple'

    try {
      await createNotification({
        venueId,
        weddingId,
        type: 'post_event_feedback',
        title: `Time to share your feedback on ${label}'s wedding!`,
        body: `Your observations help Bloom House learn. Complete the post-event feedback while it's fresh.`,
      })
      notified++
    } catch (err) {
      console.error(`[cron] Feedback notification failed for wedding ${weddingId}:`, err)
    }
  }

  return { notified }
}

// ---------------------------------------------------------------------------
// GET — Vercel cron sends GET requests
//   Header: Authorization: Bearer <CRON_SECRET>
//   Query: ?job=JOB_NAME
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const job = searchParams.get('job') as JobName | null

  if (!job || !VALID_JOBS.includes(job)) {
    return NextResponse.json(
      { error: `Invalid job. Must be one of: ${VALID_JOBS.join(', ')}` },
      { status: 400 }
    )
  }

  try {
    console.log(`[cron] Starting job: ${job}`)
    const result = await runJob(job)
    console.log(`[cron] Completed job: ${job}`)

    return NextResponse.json({ job, success: true, result })
  } catch (err) {
    console.error(`[cron] Job ${job} failed:`, err)
    return NextResponse.json(
      { job, success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
