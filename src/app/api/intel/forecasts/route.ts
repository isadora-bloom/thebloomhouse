import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Status → probability weighting for pipeline forecast
// ---------------------------------------------------------------------------

const STATUS_WEIGHTS: Record<string, number> = {
  inquiry: 0.1,
  tour_scheduled: 0.25,
  tour_completed: 0.4,
  proposal_sent: 0.5,
  hold: 0.6,
  contract: 0.9,
  booked: 1.0,
}

// ---------------------------------------------------------------------------
// Helper: quarter label from date
// ---------------------------------------------------------------------------

function getQuarter(dateStr: string): string {
  const d = new Date(dateStr)
  const q = Math.ceil((d.getMonth() + 1) / 3)
  return `${d.getFullYear()}-Q${q}`
}

// ---------------------------------------------------------------------------
// GET — Revenue forecast by quarter (weighted pipeline)
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()

    // Fetch active weddings with booking_value and wedding_date
    const { data: weddings, error } = await supabase
      .from('weddings')
      .select('id, status, wedding_date, booking_value')
      .eq('venue_id', auth.venueId)
      .not('status', 'in', '("lost","cancelled","completed")')

    if (error) return serverError(error)

    // Also fetch budget actual_cost as fallback revenue
    const weddingIds = (weddings ?? []).map(w => w.id)
    let budgetByWedding: Record<string, number> = {}

    if (weddingIds.length > 0) {
      const { data: budgetItems } = await supabase
        .from('budget')
        .select('wedding_id, actual_cost')
        .in('wedding_id', weddingIds)

      if (budgetItems) {
        for (const b of budgetItems) {
          if (b.wedding_id) {
            budgetByWedding[b.wedding_id] = (budgetByWedding[b.wedding_id] ?? 0) + (Number(b.actual_cost) || 0)
          }
        }
      }
    }

    // Group by quarter
    const quarterMap: Record<string, {
      weighted_revenue: number
      pipeline_count: number
      booked_revenue: number
      potential_revenue: number
    }> = {}

    for (const w of weddings ?? []) {
      // Skip weddings without a date — can't assign to quarter
      if (!w.wedding_date) continue

      const quarter = getQuarter(w.wedding_date)
      if (!quarterMap[quarter]) {
        quarterMap[quarter] = {
          weighted_revenue: 0,
          pipeline_count: 0,
          booked_revenue: 0,
          potential_revenue: 0,
        }
      }

      const revenue = Number(w.booking_value) || budgetByWedding[w.id] || 0
      const weight = STATUS_WEIGHTS[w.status] ?? 0.1

      quarterMap[quarter].pipeline_count++
      quarterMap[quarter].potential_revenue += revenue
      quarterMap[quarter].weighted_revenue += revenue * weight

      if (w.status === 'booked') {
        quarterMap[quarter].booked_revenue += revenue
      }
    }

    // Round values and sort by quarter
    const quarters = Object.entries(quarterMap)
      .map(([quarter, data]) => ({
        quarter,
        weighted_revenue: Math.round(data.weighted_revenue * 100) / 100,
        pipeline_count: data.pipeline_count,
        booked_revenue: Math.round(data.booked_revenue * 100) / 100,
        potential_revenue: Math.round(data.potential_revenue * 100) / 100,
      }))
      .sort((a, b) => a.quarter.localeCompare(b.quarter))

    return NextResponse.json({ quarters })
  } catch (err) {
    return serverError(err)
  }
}
