import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Me-or-Market diagnosis
//
// Phase 6 Task 55. When inquiry volume drops, coordinators need to know fast
// whether this is a venue problem (fix it) or a market problem (ride it out).
// This service composes four existing signals into a single plain-English
// verdict. No AI call, no new DB tables. Cost = 0.
//
// Signals:
//   1. inquiryVolumeDelta      venue 30d vs prior 30d, from weddings.inquiry_date
//   2. regionalSearchDelta     search_trends last 4w vs prior 4w for this venue
//   3. econTrend               latest 2 consumer_sentiment rows (FRED UMCSENT)
//   4. availabilityFillDelta   venue_availability next 90d vs same window 1yr ago
//
// Verdict rubric:
//   - insufficient_data  3+ signals null
//   - market             inquiryVolumeDelta < -10% AND
//                        (regionalSearchDelta < -5% OR econTrend === 'down')
//   - venue              inquiryVolumeDelta < -10% AND
//                        regionalSearchDelta >= 0 AND econTrend !== 'down'
//   - mixed              everything else
//
// Multi-venue: each venue's search_trends rows are filtered by venue_id, so a
// UK venue sees UK metro codes and a US venue sees US metros. FRED is
// US-only; UK venues simply have econTrend = null and the rubric still works.
// ---------------------------------------------------------------------------

export type MeOrMarketVerdict = 'market' | 'venue' | 'mixed' | 'insufficient_data'

export interface MeOrMarketDiagnosis {
  venueId: string
  verdict: MeOrMarketVerdict
  headline: string
  signals: {
    inquiryVolumeDelta: number | null
    regionalSearchDelta: number | null
    econTrend: 'up' | 'flat' | 'down' | null
    availabilityFillDelta: number | null
  }
  explanation: string
}

// Threshold tuning, kept together so they're easy to revisit.
const INQUIRY_DROP_THRESHOLD_PCT = -10 // trigger a diagnosis at -10% or worse
const REGIONAL_SEARCH_DROP_PCT = -5    // counts as market-side softening
const REGIONAL_SEARCH_STEADY_PCT = 0   // at/above 0 points the finger inward
const ECON_FLAT_BAND_PCT = 2           // +/- 2% is flat, otherwise up/down

const DAY_MS = 24 * 60 * 60 * 1000

function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) {
    // No prior activity at all, can't express as a percent. Treat as null
    // rather than Infinity so the verdict rubric skips this signal.
    return null
  }
  return ((current - prior) / prior) * 100
}

function roundPct(n: number | null): number | null {
  if (n == null) return null
  return Math.round(n * 10) / 10
}

function formatSignedPct(n: number): string {
  const sign = n > 0 ? '+' : ''
  return `${sign}${Math.round(n)}%`
}

export async function computeMeOrMarket(venueId: string): Promise<MeOrMarketDiagnosis> {
  const service = createServiceClient()
  const now = Date.now()

  // --- 1. Inquiry volume: 30d vs prior 30d ---------------------------------
  const inq30 = new Date(now - 30 * DAY_MS).toISOString()
  const inq60 = new Date(now - 60 * DAY_MS).toISOString()

  const [currentInqRes, priorInqRes] = await Promise.all([
    service
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .gte('inquiry_date', inq30),
    service
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .gte('inquiry_date', inq60)
      .lt('inquiry_date', inq30),
  ])

  const currentInq = currentInqRes.count ?? 0
  const priorInq = priorInqRes.count ?? 0
  let inquiryVolumeDelta: number | null = null
  if (priorInq > 0) {
    inquiryVolumeDelta = pctDelta(currentInq, priorInq)
  } else if (currentInq > 0) {
    // No prior history but we have current data, can't express a delta,
    // leave null. The verdict logic will treat it as missing.
    inquiryVolumeDelta = null
  } else {
    inquiryVolumeDelta = null
  }

  // --- 2. Regional search trends: 4w vs prior 4w ---------------------------
  const fourWeeksAgo = new Date(now - 28 * DAY_MS).toISOString().split('T')[0]
  const eightWeeksAgo = new Date(now - 56 * DAY_MS).toISOString().split('T')[0]

  const { data: trendRows } = await service
    .from('search_trends')
    .select('week, interest')
    .eq('venue_id', venueId)
    .gte('week', eightWeeksAgo)

  let regionalSearchDelta: number | null = null
  if (trendRows && trendRows.length > 0) {
    let currentSum = 0
    let currentCount = 0
    let priorSum = 0
    let priorCount = 0
    for (const r of trendRows) {
      const interest = Number(r.interest) || 0
      const week = r.week as string
      if (week >= fourWeeksAgo) {
        currentSum += interest
        currentCount += 1
      } else if (week >= eightWeeksAgo) {
        priorSum += interest
        priorCount += 1
      }
    }
    if (priorCount > 0 && currentCount > 0) {
      const currentAvg = currentSum / currentCount
      const priorAvg = priorSum / priorCount
      regionalSearchDelta = pctDelta(currentAvg, priorAvg)
    }
  }

  // --- 3. Economic trend (US-only; UK venues get null) ---------------------
  const { data: econRows } = await service
    .from('economic_indicators')
    .select('date, value')
    .eq('indicator_name', 'consumer_sentiment')
    .order('date', { ascending: false })
    .limit(2)

  let econTrend: 'up' | 'flat' | 'down' | null = null
  if (econRows && econRows.length >= 2) {
    const latest = Number(econRows[0].value)
    const previous = Number(econRows[1].value)
    if (Number.isFinite(latest) && Number.isFinite(previous) && previous !== 0) {
      const delta = ((latest - previous) / previous) * 100
      if (delta > ECON_FLAT_BAND_PCT) econTrend = 'up'
      else if (delta < -ECON_FLAT_BAND_PCT) econTrend = 'down'
      else econTrend = 'flat'
    }
  }

  // --- 4. Availability fill delta: next 90d vs same window last year -------
  const today = new Date(now)
  const ninetyOut = new Date(now + 90 * DAY_MS)
  const lastYearStart = new Date(now - 365 * DAY_MS)
  const lastYearEnd = new Date(now + 90 * DAY_MS - 365 * DAY_MS)

  const iso = (d: Date) => d.toISOString().split('T')[0]

  const [currentAvailRes, priorAvailRes] = await Promise.all([
    service
      .from('venue_availability')
      .select('booked_count, max_events')
      .eq('venue_id', venueId)
      .gte('date', iso(today))
      .lte('date', iso(ninetyOut)),
    service
      .from('venue_availability')
      .select('booked_count, max_events')
      .eq('venue_id', venueId)
      .gte('date', iso(lastYearStart))
      .lte('date', iso(lastYearEnd)),
  ])

  function fillRate(rows: Array<{ booked_count: number | null; max_events: number | null }> | null): number | null {
    if (!rows || rows.length === 0) return null
    let booked = 0
    let capacity = 0
    for (const r of rows) {
      const b = Number(r.booked_count) || 0
      const m = Number(r.max_events) || 0
      booked += b
      capacity += m
    }
    if (capacity === 0) return null
    return booked / capacity
  }

  const currentFill = fillRate(currentAvailRes.data as Array<{ booked_count: number | null; max_events: number | null }> | null)
  const priorFill = fillRate(priorAvailRes.data as Array<{ booked_count: number | null; max_events: number | null }> | null)

  let availabilityFillDelta: number | null = null
  if (currentFill != null && priorFill != null && priorFill > 0) {
    availabilityFillDelta = ((currentFill - priorFill) / priorFill) * 100
  }

  const signals = {
    inquiryVolumeDelta: roundPct(inquiryVolumeDelta),
    regionalSearchDelta: roundPct(regionalSearchDelta),
    econTrend,
    availabilityFillDelta: roundPct(availabilityFillDelta),
  }

  // --- Verdict -------------------------------------------------------------
  const nullCount =
    (signals.inquiryVolumeDelta == null ? 1 : 0) +
    (signals.regionalSearchDelta == null ? 1 : 0) +
    (signals.econTrend == null ? 1 : 0) +
    (signals.availabilityFillDelta == null ? 1 : 0)

  let verdict: MeOrMarketVerdict
  let headline: string

  if (nullCount >= 3) {
    verdict = 'insufficient_data'
    headline = 'Not enough data yet to diagnose.'
  } else if (
    signals.inquiryVolumeDelta != null &&
    signals.inquiryVolumeDelta < INQUIRY_DROP_THRESHOLD_PCT &&
    ((signals.regionalSearchDelta != null && signals.regionalSearchDelta < REGIONAL_SEARCH_DROP_PCT) ||
      signals.econTrend === 'down')
  ) {
    verdict = 'market'
    headline = 'This looks like a market condition, not a venue issue.'
  } else if (
    signals.inquiryVolumeDelta != null &&
    signals.inquiryVolumeDelta < INQUIRY_DROP_THRESHOLD_PCT &&
    signals.regionalSearchDelta != null &&
    signals.regionalSearchDelta >= REGIONAL_SEARCH_STEADY_PCT &&
    signals.econTrend !== 'down'
  ) {
    verdict = 'venue'
    headline = 'Volume is down but the market is steady. Look inside.'
  } else {
    verdict = 'mixed'
    if (signals.inquiryVolumeDelta != null && signals.inquiryVolumeDelta < INQUIRY_DROP_THRESHOLD_PCT) {
      headline = 'Mixed signals. Some market softness, some you can fix.'
    } else {
      headline = 'Inquiry volume is holding. Nothing to diagnose right now.'
    }
  }

  // --- Explanation ---------------------------------------------------------
  const parts: string[] = []

  if (signals.inquiryVolumeDelta != null) {
    parts.push(
      `Inquiries are ${formatSignedPct(signals.inquiryVolumeDelta)} versus the prior 30 days.`
    )
  } else {
    parts.push('Not enough inquiry history to compare 30-day windows yet.')
  }

  if (signals.regionalSearchDelta != null) {
    parts.push(
      `Regional search interest is ${formatSignedPct(signals.regionalSearchDelta)} over the last 4 weeks.`
    )
  }

  if (signals.econTrend === 'down') {
    parts.push('Consumer sentiment is trending down.')
  } else if (signals.econTrend === 'up') {
    parts.push('Consumer sentiment is trending up.')
  } else if (signals.econTrend === 'flat') {
    parts.push('Consumer sentiment is holding flat.')
  }

  if (signals.availabilityFillDelta != null) {
    const direction = signals.availabilityFillDelta >= 0 ? 'faster' : 'slower'
    parts.push(
      `Dates for the next 90 days are filling ${direction} than this time last year (${formatSignedPct(signals.availabilityFillDelta)}).`
    )
  }

  const explanation = parts.join(' ')

  return {
    venueId,
    verdict,
    headline,
    signals,
    explanation,
  }
}
