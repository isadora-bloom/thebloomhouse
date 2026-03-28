/**
 * Bloom House: Source Attribution Service
 *
 * Calculates ROI and conversion metrics by marketing source. Groups
 * wedding data by lead source (The Knot, WeddingWire, Instagram, etc.)
 * and computes cost-per-inquiry, cost-per-booking, conversion rate, and
 * return on marketing spend.
 *
 * Results are upserted to the source_attribution table for dashboards
 * and the daily intel briefing.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceAttribution {
  venue_id: string
  source: string
  period_start: string
  period_end: string
  inquiries: number
  tours: number
  bookings: number
  revenue: number
  marketing_spend: number
  cost_per_inquiry: number | null
  cost_per_booking: number | null
  conversion_rate: number
  roi: number | null
}

// ---------------------------------------------------------------------------
// Core calculation
// ---------------------------------------------------------------------------

/**
 * Queries weddings and marketing_spend for a given venue and period,
 * groups by source, and calculates attribution metrics. Results are
 * upserted to the source_attribution table.
 */
export async function calculateAttribution(
  venueId: string,
  periodStart: string,
  periodEnd: string
): Promise<SourceAttribution[]> {
  const supabase = createServiceClient()

  // Fetch weddings that had their first contact within the period
  const { data: weddings, error: weddingsError } = await supabase
    .from('weddings')
    .select('id, source, status, total_revenue, created_at')
    .eq('venue_id', venueId)
    .gte('created_at', periodStart)
    .lte('created_at', periodEnd)

  if (weddingsError) throw weddingsError

  // Fetch marketing spend for the period
  const { data: spend, error: spendError } = await supabase
    .from('marketing_spend')
    .select('source, amount')
    .eq('venue_id', venueId)
    .gte('period_start', periodStart)
    .lte('period_end', periodEnd)

  if (spendError) throw spendError

  // Group spend by source
  const spendBySource = new Map<string, number>()
  for (const row of spend ?? []) {
    const source = (row.source as string) ?? 'unknown'
    const amount = (row.amount as number) ?? 0
    spendBySource.set(source, (spendBySource.get(source) ?? 0) + amount)
  }

  // Group weddings by source
  const sourceMap = new Map<
    string,
    { inquiries: number; tours: number; bookings: number; revenue: number }
  >()

  for (const w of weddings ?? []) {
    const source = (w.source as string) ?? 'unknown'
    const status = w.status as string
    const revenue = (w.total_revenue as number) ?? 0

    if (!sourceMap.has(source)) {
      sourceMap.set(source, { inquiries: 0, tours: 0, bookings: 0, revenue: 0 })
    }

    const entry = sourceMap.get(source)!

    // Every wedding record counts as an inquiry
    entry.inquiries++

    // Count tours (status progressed beyond inquiry)
    if (['toured', 'proposal_sent', 'booked', 'completed'].includes(status)) {
      entry.tours++
    }

    // Count bookings
    if (['booked', 'completed'].includes(status)) {
      entry.bookings++
      entry.revenue += revenue
    }
  }

  // Ensure sources with spend but no weddings still appear
  for (const source of spendBySource.keys()) {
    if (!sourceMap.has(source)) {
      sourceMap.set(source, { inquiries: 0, tours: 0, bookings: 0, revenue: 0 })
    }
  }

  // Calculate metrics and build results
  const results: SourceAttribution[] = []

  for (const [source, data] of sourceMap) {
    const marketingSpend = spendBySource.get(source) ?? 0

    const costPerInquiry =
      data.inquiries > 0 && marketingSpend > 0
        ? marketingSpend / data.inquiries
        : null

    const costPerBooking =
      data.bookings > 0 && marketingSpend > 0
        ? marketingSpend / data.bookings
        : null

    const conversionRate =
      data.inquiries > 0
        ? (data.bookings / data.inquiries) * 100
        : 0

    const roi =
      marketingSpend > 0
        ? ((data.revenue - marketingSpend) / marketingSpend) * 100
        : null

    const attribution: SourceAttribution = {
      venue_id: venueId,
      source,
      period_start: periodStart,
      period_end: periodEnd,
      inquiries: data.inquiries,
      tours: data.tours,
      bookings: data.bookings,
      revenue: data.revenue,
      marketing_spend: marketingSpend,
      cost_per_inquiry: costPerInquiry ? Math.round(costPerInquiry * 100) / 100 : null,
      cost_per_booking: costPerBooking ? Math.round(costPerBooking * 100) / 100 : null,
      conversion_rate: Math.round(conversionRate * 10) / 10,
      roi: roi != null ? Math.round(roi * 10) / 10 : null,
    }

    results.push(attribution)
  }

  // Upsert results to source_attribution table
  if (results.length > 0) {
    const { error: upsertError } = await supabase
      .from('source_attribution')
      .upsert(
        results.map((r) => ({
          venue_id: r.venue_id,
          source: r.source,
          period_start: r.period_start,
          period_end: r.period_end,
          inquiries: r.inquiries,
          tours: r.tours,
          bookings: r.bookings,
          revenue: r.revenue,
          marketing_spend: r.marketing_spend,
          cost_per_inquiry: r.cost_per_inquiry,
          cost_per_booking: r.cost_per_booking,
          conversion_rate: r.conversion_rate,
          roi: r.roi,
        })),
        { onConflict: 'venue_id,source,period_start,period_end' }
      )

    if (upsertError) throw upsertError
  }

  return results
}

// ---------------------------------------------------------------------------
// Batch calculation
// ---------------------------------------------------------------------------

/**
 * Runs attribution calculation for all active venues.
 */
export async function calculateAllVenueAttribution(
  periodStart: string,
  periodEnd: string
): Promise<void> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('is_active', true)

  if (error) throw error

  for (const venue of venues ?? []) {
    try {
      await calculateAttribution(venue.id as string, periodStart, periodEnd)
    } catch (err) {
      console.error(`[attribution] Failed for venue ${venue.id}:`, err)
    }
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns top sources for a venue by the given metric.
 */
export async function getTopSources(
  venueId: string,
  metric: 'roi' | 'bookings' | 'conversion_rate',
  limit: number = 5
): Promise<SourceAttribution[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('source_attribution')
    .select('*')
    .eq('venue_id', venueId)
    .not(metric, 'is', null)
    .order(metric, { ascending: false })
    .limit(limit)

  if (error) throw error

  return (data ?? []) as unknown as SourceAttribution[]
}
