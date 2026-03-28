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
import { sendAllDigests } from '@/lib/services/daily-digest'
import { processAllVenueFollowUps } from '@/lib/services/follow-up-sequences'

// ---------------------------------------------------------------------------
// Valid job names
// ---------------------------------------------------------------------------

const VALID_JOBS = [
  'trends_refresh',
  'weather_forecast',
  'economic_indicators',
  'anomaly_detection',
  'weekly_briefing',
  'monthly_briefing',
  'daily_digest',
  'follow_up_sequences',
] as const

type JobName = (typeof VALID_JOBS)[number]

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function runJob(job: JobName): Promise<unknown> {
  switch (job) {
    case 'trends_refresh':
      return fetchAllVenueTrends()

    case 'weather_forecast':
      return fetchWeatherForAllVenues()

    case 'economic_indicators':
      return fetchAllEconomicIndicators()

    case 'anomaly_detection':
      return runAllVenueAnomalies()

    case 'weekly_briefing':
      return generateBriefingsForAllVenues('weekly')

    case 'monthly_briefing':
      return generateBriefingsForAllVenues('monthly')

    case 'daily_digest':
      return sendAllDigests()

    case 'follow_up_sequences':
      return processAllVenueFollowUps()
  }
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
