/**
 * Consultant Tracking Service
 *
 * Tracks coordinator actions into the consultant_metrics table.
 * Each row covers a (venue_id, consultant_id, period) window.
 * We upsert the current-month row and increment the relevant counter.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrackableAction =
  | 'inquiry_handled'
  | 'tour_booked'
  | 'booking_closed'
  | 'draft_approved'
  | 'draft_rejected'

// Map action names to the column they increment
const ACTION_COLUMN_MAP: Record<TrackableAction, string> = {
  inquiry_handled: 'inquiries_handled',
  tour_booked: 'tours_booked',
  booking_closed: 'bookings_closed',
  draft_approved: 'inquiries_handled', // approving a draft = handling an inquiry
  draft_rejected: 'inquiries_handled', // rejecting also counts as handling
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentPeriod(): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  }
}

// ---------------------------------------------------------------------------
// Track a coordinator action
// ---------------------------------------------------------------------------

export async function trackCoordinatorAction(
  venueId: string,
  userId: string,
  action: TrackableAction
): Promise<void> {
  const supabase = createServiceClient()
  const { start, end } = getCurrentPeriod()
  const column = ACTION_COLUMN_MAP[action]

  // Try to find existing row for this period
  const { data: existing } = await supabase
    .from('consultant_metrics')
    .select('id, inquiries_handled, tours_booked, bookings_closed, conversion_rate')
    .eq('venue_id', venueId)
    .eq('consultant_id', userId)
    .eq('period_start', start)
    .eq('period_end', end)
    .maybeSingle()

  if (existing) {
    // Increment the relevant counter
    const currentVal = (existing as Record<string, unknown>)[column] as number ?? 0
    const updates: Record<string, unknown> = {
      [column]: currentVal + 1,
      calculated_at: new Date().toISOString(),
    }

    // Recalculate conversion rate if we have bookings and inquiries
    const inquiries = column === 'inquiries_handled'
      ? currentVal + 1
      : (existing.inquiries_handled ?? 0)
    const bookings = column === 'bookings_closed'
      ? (existing.bookings_closed ?? 0) + 1
      : (existing.bookings_closed ?? 0)

    if (inquiries > 0) {
      updates.conversion_rate = Number(((bookings / inquiries) * 100).toFixed(2))
    }

    await supabase
      .from('consultant_metrics')
      .update(updates)
      .eq('id', existing.id)
  } else {
    // Insert a new row for this period
    const row: Record<string, unknown> = {
      venue_id: venueId,
      consultant_id: userId,
      period_start: start,
      period_end: end,
      inquiries_handled: 0,
      tours_booked: 0,
      bookings_closed: 0,
      conversion_rate: 0,
      avg_response_time_minutes: 0,
      avg_booking_value: 0,
      [column]: 1,
      calculated_at: new Date().toISOString(),
    }

    await supabase.from('consultant_metrics').insert(row)
  }
}

// ---------------------------------------------------------------------------
// Track response time (running average)
// ---------------------------------------------------------------------------

export async function trackResponseTime(
  venueId: string,
  userId: string,
  responseTimeMinutes: number
): Promise<void> {
  const supabase = createServiceClient()
  const { start, end } = getCurrentPeriod()

  const { data: existing } = await supabase
    .from('consultant_metrics')
    .select('id, avg_response_time_minutes, inquiries_handled')
    .eq('venue_id', venueId)
    .eq('consultant_id', userId)
    .eq('period_start', start)
    .eq('period_end', end)
    .maybeSingle()

  if (existing) {
    // Running average: new_avg = (old_avg * count + new_value) / (count + 1)
    const count = existing.inquiries_handled ?? 1
    const oldAvg = existing.avg_response_time_minutes ?? 0
    const newAvg = Number(((oldAvg * count + responseTimeMinutes) / (count + 1)).toFixed(2))

    await supabase
      .from('consultant_metrics')
      .update({
        avg_response_time_minutes: newAvg,
        calculated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
  } else {
    // Create a new row with this response time
    await supabase.from('consultant_metrics').insert({
      venue_id: venueId,
      consultant_id: userId,
      period_start: start,
      period_end: end,
      inquiries_handled: 0,
      tours_booked: 0,
      bookings_closed: 0,
      conversion_rate: 0,
      avg_response_time_minutes: responseTimeMinutes,
      avg_booking_value: 0,
      calculated_at: new Date().toISOString(),
    })
  }
}
