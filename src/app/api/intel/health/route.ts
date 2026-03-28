import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Helper: clamp score 0–100
// ---------------------------------------------------------------------------

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

// ---------------------------------------------------------------------------
// GET — Venue health score (return latest or compute fresh if stale >7 days)
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()

    // Check for recent health score
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data: existing } = await supabase
      .from('venue_health')
      .select('*')
      .eq('venue_id', auth.venueId)
      .gte('calculated_at', sevenDaysAgo)
      .order('calculated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existing) {
      return NextResponse.json({ health: existing })
    }

    // Compute fresh health score
    const [weddingsRes, interactionsRes, draftsRes] = await Promise.all([
      supabase
        .from('weddings')
        .select('id, status, wedding_date, guest_count_estimate, booking_value, source, first_response_at, inquiry_date')
        .eq('venue_id', auth.venueId),
      supabase
        .from('interactions')
        .select('wedding_id, direction, timestamp')
        .eq('venue_id', auth.venueId)
        .eq('direction', 'inbound')
        .order('timestamp', { ascending: true }),
      supabase
        .from('drafts')
        .select('wedding_id, created_at')
        .eq('venue_id', auth.venueId)
        .in('status', ['approved', 'sent'])
        .order('created_at', { ascending: true }),
    ])

    const weddings = weddingsRes.data ?? []
    const interactions = interactionsRes.data ?? []
    const drafts = draftsRes.data ?? []

    // --- Data quality score: % of weddings with complete data ---
    const completeFields = ['wedding_date', 'guest_count_estimate', 'booking_value', 'source'] as const
    let completeCount = 0
    for (const w of weddings) {
      const filled = completeFields.filter(f => w[f] != null).length
      if (filled >= 3) completeCount++ // 3 of 4 = "complete enough"
    }
    const data_quality_score = weddings.length > 0
      ? clamp((completeCount / weddings.length) * 100)
      : 0

    // --- Pipeline score: conversion rate (inquiries → booked) ---
    const inquiries = weddings.length
    const booked = weddings.filter(w => ['booked', 'completed'].includes(w.status)).length
    const pipeline_score = inquiries > 0
      ? clamp((booked / inquiries) * 100 * 5) // Scale: 20% conversion = 100 score
      : 0

    // --- Response time score ---
    const firstInbound: Record<string, string> = {}
    for (const i of interactions) {
      if (i.wedding_id && !firstInbound[i.wedding_id]) {
        firstInbound[i.wedding_id] = i.timestamp
      }
    }

    const firstDraft: Record<string, string> = {}
    for (const d of drafts) {
      if (d.wedding_id && !firstDraft[d.wedding_id]) {
        firstDraft[d.wedding_id] = d.created_at
      }
    }

    const responseTimes: number[] = []
    for (const wId of Object.keys(firstInbound)) {
      if (firstDraft[wId]) {
        const diffMin = (new Date(firstDraft[wId]).getTime() - new Date(firstInbound[wId]).getTime()) / 60000
        if (diffMin > 0) responseTimes.push(diffMin)
      }
    }

    let response_time_score = 50 // default if no data
    if (responseTimes.length > 0) {
      const avgMinutes = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      // Under 15 min = 100, under 60 min = 80, under 240 min = 60, under 1440 = 30, else 10
      if (avgMinutes <= 15) response_time_score = 100
      else if (avgMinutes <= 60) response_time_score = 80
      else if (avgMinutes <= 240) response_time_score = 60
      else if (avgMinutes <= 1440) response_time_score = 30
      else response_time_score = 10
    }

    // --- Booking rate score (last 90 days) ---
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    const recentWeddings = weddings.filter(w => w.inquiry_date && w.inquiry_date >= ninetyDaysAgo)
    const recentBooked = recentWeddings.filter(w => ['booked', 'completed'].includes(w.status)).length
    const booking_rate_score = recentWeddings.length > 0
      ? clamp((recentBooked / recentWeddings.length) * 100 * 5)
      : 0

    // --- Overall score (weighted average) ---
    const overall_score = clamp(
      data_quality_score * 0.2 +
      pipeline_score * 0.25 +
      response_time_score * 0.3 +
      booking_rate_score * 0.25
    )

    // Save to venue_health
    const { data: saved, error: saveErr } = await supabase
      .from('venue_health')
      .insert({
        venue_id: auth.venueId,
        calculated_at: new Date().toISOString(),
        overall_score,
        data_quality_score,
        pipeline_score,
        response_time_score,
        booking_rate_score,
      })
      .select()
      .single()

    if (saveErr) return serverError(saveErr)
    return NextResponse.json({ health: saved })
  } catch (err) {
    return serverError(err)
  }
}
