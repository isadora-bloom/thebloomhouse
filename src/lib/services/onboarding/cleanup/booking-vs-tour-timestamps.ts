/**
 * Step 3 of the onboarding cleanup pipeline — re-align booking vs
 * tour timestamps.
 *
 * Extracted from scripts/backfill-booking-vs-tour-timestamps.ts (kept
 * as a thin CLI wrapper). Corrects the conflation between "when the
 * booking happened" (customer clicked Book in Calendly — the
 * inbound-interaction moment) and "when the tour happened" (the
 * scheduled tour datetime). Requires step 1 (direction reclassify) to
 * have already run so direction + from_email are trustworthy.
 *
 * Correct invariant per row:
 *   wedding.inquiry_date       = earliest inbound interaction's timestamp
 *   tour_scheduled engagement  = booking moment (interaction.timestamp)
 *   tour_booked touchpoint     = booking moment (interaction.timestamp)
 *   inquiry touchpoint         = wedding.inquiry_date
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CleanupStepResult } from './types'
import { emptyResult } from './types'

const MIN_DRIFT_HOURS = 12

interface Wedding { id: string; inquiry_date: string | null }

export async function backfillBookingVsTourTimestamps(
  sb: SupabaseClient,
  venueId: string,
  apply: boolean,
): Promise<CleanupStepResult> {
  const result = emptyResult('booking_vs_tour_timestamps', '3. Re-align booking vs tour timestamps')
  const errors: string[] = []
  const samples: string[] = []

  let weddingsScanned = 0
  let inquiryDatesFixed = 0
  let inquiryTouchpointsFixed = 0
  let bookingEventsFixed = 0
  let bookingTouchpointsFixed = 0

  const { data: weddings, error: wErr } = await sb
    .from('weddings')
    .select('id, inquiry_date')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: true })
  if (wErr) {
    result.ok = false
    result.errors.push(wErr.message)
    return result
  }

  for (const w of (weddings ?? []) as Wedding[]) {
    weddingsScanned++
    const { data: firstInbound } = await sb
      .from('interactions')
      .select('id, timestamp')
      .eq('wedding_id', w.id)
      .eq('direction', 'inbound')
      .not('timestamp', 'is', null)
      .order('timestamp', { ascending: true })
      .limit(1)
    const fi = (firstInbound?.[0] as { id: string; timestamp: string } | undefined)
    if (!fi) continue
    const earliestInboundIso = new Date(fi.timestamp).toISOString()

    const driftHours = w.inquiry_date
      ? Math.abs(new Date(w.inquiry_date).getTime() - new Date(earliestInboundIso).getTime()) / 3_600_000
      : Infinity
    if (driftHours >= MIN_DRIFT_HOURS) {
      inquiryDatesFixed++
      if (samples.length < 5) {
        samples.push(`wedding ${w.id.slice(0, 8)}… inquiry_date: ${w.inquiry_date} → ${earliestInboundIso} (drift ${Math.round(driftHours / 24 * 10) / 10}d)`)
      }
      if (apply) {
        const { error } = await sb.from('weddings').update({ inquiry_date: earliestInboundIso }).eq('id', w.id)
        if (error) errors.push(`wedding ${w.id}: ${error.message}`)
      }
    }

    const { data: inqTp } = await sb
      .from('wedding_touchpoints')
      .select('id, occurred_at')
      .eq('wedding_id', w.id)
      .eq('touch_type', 'inquiry')
      .limit(1)
    const inq = (inqTp?.[0] as { id: string; occurred_at: string | null } | undefined)
    if (inq) {
      const tpDriftH = inq.occurred_at
        ? Math.abs(new Date(inq.occurred_at).getTime() - new Date(earliestInboundIso).getTime()) / 3_600_000
        : Infinity
      if (tpDriftH >= MIN_DRIFT_HOURS) {
        inquiryTouchpointsFixed++
        if (apply) {
          const { error } = await sb.from('wedding_touchpoints').update({ occurred_at: earliestInboundIso }).eq('id', inq.id)
          if (error) errors.push(`touchpoint ${inq.id}: ${error.message}`)
        }
      }
    }

    const { data: bookingEvents } = await sb
      .from('engagement_events')
      .select('id, occurred_at, metadata')
      .eq('venue_id', venueId)
      .eq('wedding_id', w.id)
      .in('event_type', ['tour_scheduled', 'contract_sent'])
    for (const ee of (bookingEvents ?? []) as Array<{ id: string; occurred_at: string | null; metadata: { interaction_id?: string | null } | null }>) {
      const iid = ee.metadata?.interaction_id
      if (!iid) continue
      const { data: ix } = await sb.from('interactions').select('timestamp').eq('id', iid).maybeSingle()
      const ts = (ix as { timestamp: string | null } | null)?.timestamp
      if (!ts) continue
      const correct = new Date(ts).toISOString()
      const drift = ee.occurred_at
        ? Math.abs(new Date(ee.occurred_at).getTime() - new Date(correct).getTime()) / 3_600_000
        : Infinity
      if (drift >= MIN_DRIFT_HOURS) {
        bookingEventsFixed++
        if (apply) {
          const { error } = await sb.from('engagement_events').update({ occurred_at: correct }).eq('id', ee.id)
          if (error) errors.push(`engagement_event ${ee.id}: ${error.message}`)
        }
      }
    }

    const { data: bookingTps } = await sb
      .from('wedding_touchpoints')
      .select('id, occurred_at, metadata')
      .eq('venue_id', venueId)
      .eq('wedding_id', w.id)
      .in('touch_type', ['tour_booked', 'calendly_booked'])
    for (const tp of (bookingTps ?? []) as Array<{ id: string; occurred_at: string | null; metadata: { interaction_id?: string | null } | null }>) {
      const iid = tp.metadata?.interaction_id
      if (!iid) continue
      const { data: ix } = await sb.from('interactions').select('timestamp').eq('id', iid).maybeSingle()
      const ts = (ix as { timestamp: string | null } | null)?.timestamp
      if (!ts) continue
      const correct = new Date(ts).toISOString()
      const drift = tp.occurred_at
        ? Math.abs(new Date(tp.occurred_at).getTime() - new Date(correct).getTime()) / 3_600_000
        : Infinity
      if (drift >= MIN_DRIFT_HOURS) {
        bookingTouchpointsFixed++
        if (apply) {
          const { error } = await sb.from('wedding_touchpoints').update({ occurred_at: correct }).eq('id', tp.id)
          if (error) errors.push(`touchpoint ${tp.id}: ${error.message}`)
        }
      }
    }
  }

  result.counts = {
    weddings_scanned: weddingsScanned,
    inquiry_dates_fixed: inquiryDatesFixed,
    inquiry_touchpoints_fixed: inquiryTouchpointsFixed,
    booking_events_fixed: bookingEventsFixed,
    booking_touchpoints_fixed: bookingTouchpointsFixed,
  }
  result.samples = samples
  result.errors = errors
  return result
}
