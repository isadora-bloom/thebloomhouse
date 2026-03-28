import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Helper: period filter date
// ---------------------------------------------------------------------------

function periodCutoff(period: string | null): string | null {
  if (!period || period === 'all') return null
  const daysMap: Record<string, number> = { '30d': 30, '90d': 90, '12m': 365 }
  const days = daysMap[period] ?? 30
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

// ---------------------------------------------------------------------------
// GET — Source attribution data
//   ?period=30d|90d|12m|all
//   Aggregates interactions by source, cross-referenced with tours and weddings
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const period = searchParams.get('period')
    const cutoff = periodCutoff(period)

    const supabase = createServiceClient()

    // Fetch weddings with source info
    let weddingsQ = supabase
      .from('weddings')
      .select('id, source, status, booking_value, created_at, first_response_at, inquiry_date')
      .eq('venue_id', auth.venueId)

    if (cutoff) weddingsQ = weddingsQ.gte('created_at', cutoff)

    // Fetch tours with source info
    let toursQ = supabase
      .from('tours')
      .select('id, source, outcome, wedding_id')
      .eq('venue_id', auth.venueId)

    if (cutoff) toursQ = toursQ.gte('created_at', cutoff)

    // Fetch first inbound interaction per wedding for response time
    let interactionsQ = supabase
      .from('interactions')
      .select('wedding_id, direction, timestamp')
      .eq('venue_id', auth.venueId)
      .eq('direction', 'inbound')
      .order('timestamp', { ascending: true })

    if (cutoff) interactionsQ = interactionsQ.gte('timestamp', cutoff)

    // Fetch first outbound draft per wedding for response time
    let draftsQ = supabase
      .from('drafts')
      .select('wedding_id, created_at')
      .eq('venue_id', auth.venueId)
      .in('status', ['approved', 'sent'])
      .order('created_at', { ascending: true })

    if (cutoff) draftsQ = draftsQ.gte('created_at', cutoff)

    // Fetch budget for revenue calculation
    let budgetQ = supabase
      .from('budget')
      .select('wedding_id, actual_cost')
      .eq('venue_id', auth.venueId)

    const [weddingsRes, toursRes, interactionsRes, draftsRes, budgetRes] = await Promise.all([
      weddingsQ, toursQ, interactionsQ, draftsQ, budgetQ,
    ])

    if (weddingsRes.error) return serverError(weddingsRes.error)

    const weddings = weddingsRes.data ?? []
    const tours = toursRes.data ?? []
    const interactions = interactionsRes.data ?? []
    const drafts = draftsRes.data ?? []
    const budgetItems = budgetRes.data ?? []

    // Group weddings by source
    const sourceMap: Record<string, {
      source_name: string
      inquiry_count: number
      tour_count: number
      booking_count: number
      revenue: number
      response_times: number[]
    }> = {}

    // Revenue per wedding
    const revenueByWedding: Record<string, number> = {}
    for (const b of budgetItems) {
      if (!b.wedding_id) continue
      revenueByWedding[b.wedding_id] = (revenueByWedding[b.wedding_id] ?? 0) + (Number(b.actual_cost) || 0)
    }

    // Also use booking_value from weddings as fallback
    for (const w of weddings) {
      if (!revenueByWedding[w.id] && w.booking_value) {
        revenueByWedding[w.id] = Number(w.booking_value) || 0
      }
    }

    // First inbound timestamp per wedding
    const firstInbound: Record<string, string> = {}
    for (const i of interactions) {
      if (i.wedding_id && !firstInbound[i.wedding_id]) {
        firstInbound[i.wedding_id] = i.timestamp
      }
    }

    // First draft timestamp per wedding
    const firstDraft: Record<string, string> = {}
    for (const d of drafts) {
      if (d.wedding_id && !firstDraft[d.wedding_id]) {
        firstDraft[d.wedding_id] = d.created_at
      }
    }

    // Tours by source
    const toursBySource: Record<string, number> = {}
    for (const t of tours) {
      const src = t.source ?? 'unknown'
      toursBySource[src] = (toursBySource[src] ?? 0) + 1
    }

    for (const w of weddings) {
      const src = w.source ?? 'unknown'
      if (!sourceMap[src]) {
        sourceMap[src] = {
          source_name: src,
          inquiry_count: 0,
          tour_count: 0,
          booking_count: 0,
          revenue: 0,
          response_times: [],
        }
      }

      sourceMap[src].inquiry_count++

      if (['booked', 'completed'].includes(w.status)) {
        sourceMap[src].booking_count++
        sourceMap[src].revenue += revenueByWedding[w.id] ?? 0
      }

      // Response time
      const inboundTs = firstInbound[w.id]
      const draftTs = firstDraft[w.id]
      if (inboundTs && draftTs) {
        const diffMs = new Date(draftTs).getTime() - new Date(inboundTs).getTime()
        if (diffMs > 0) {
          sourceMap[src].response_times.push(diffMs / 60000) // minutes
        }
      }
    }

    // Add tour counts
    for (const [src, count] of Object.entries(toursBySource)) {
      if (!sourceMap[src]) {
        sourceMap[src] = {
          source_name: src,
          inquiry_count: 0,
          tour_count: 0,
          booking_count: 0,
          revenue: 0,
          response_times: [],
        }
      }
      sourceMap[src].tour_count = count
    }

    // Build result
    const sources = Object.values(sourceMap).map(s => ({
      source_name: s.source_name,
      inquiry_count: s.inquiry_count,
      tour_count: s.tour_count,
      booking_count: s.booking_count,
      revenue: Math.round(s.revenue * 100) / 100,
      avg_response_time: s.response_times.length > 0
        ? Math.round(s.response_times.reduce((a, b) => a + b, 0) / s.response_times.length)
        : null,
    }))

    // Sort by inquiry count descending
    sources.sort((a, b) => b.inquiry_count - a.inquiry_count)

    return NextResponse.json({ sources })
  } catch (err) {
    return serverError(err)
  }
}
