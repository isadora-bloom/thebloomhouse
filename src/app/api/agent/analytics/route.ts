import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Parse period string into a Date threshold
// ---------------------------------------------------------------------------

function periodToDate(period: string): Date {
  const now = new Date()
  const match = period.match(/^(\d+)d$/)
  const days = match ? parseInt(match[1], 10) : 30
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

// ---------------------------------------------------------------------------
// GET — Agent analytics for a venue in a time period
//   ?period=7d|30d|90d  (default: 30d)
//
//   Returns:
//     response_time  — avg minutes between inbound interaction and first draft
//     drafts         — { total, approved, rejected, edited, auto_sent, approval_rate, edit_rate }
//     auto_send      — { total_auto_sent, sources_breakdown }
//     cost           — { total_cost, avg_per_email, by_context }
//     conversion     — { inquiries, tours_scheduled, booked }
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const period = searchParams.get('period') ?? '30d'
    const since = periodToDate(period).toISOString()
    const supabase = createServiceClient()

    // ── Parallel data fetches ──────────────────────────────────────────
    const [
      draftsResult,
      inboundResult,
      costsResult,
      inquiriesResult,
      toursResult,
      bookedResult,
    ] = await Promise.all([
      // All drafts in period
      supabase
        .from('drafts')
        .select('id, status, auto_sent, auto_send_source, context_type, interaction_id, cost, created_at')
        .eq('venue_id', auth.venueId)
        .gte('created_at', since),

      // Inbound interactions in period (for response time calc)
      supabase
        .from('interactions')
        .select('id, timestamp')
        .eq('venue_id', auth.venueId)
        .eq('direction', 'inbound')
        .gte('timestamp', since),

      // API costs in period
      supabase
        .from('api_costs')
        .select('cost, context')
        .eq('venue_id', auth.venueId)
        .gte('created_at', since),

      // Inquiries created in period
      supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', auth.venueId)
        .gte('created_at', since),

      // Tours scheduled in period
      supabase
        .from('engagement_events')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', auth.venueId)
        .eq('event_type', 'tour_scheduled')
        .gte('created_at', since),

      // Booked in period
      supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', auth.venueId)
        .eq('status', 'booked')
        .gte('booked_at', since),
    ])

    const drafts = draftsResult.data ?? []
    const inbound = inboundResult.data ?? []
    const costs = costsResult.data ?? []

    // ── Response time ──────────────────────────────────────────────────
    // Build a map of interaction_id → earliest draft created_at
    const draftsByInteraction = new Map<string, string>()
    for (const d of drafts) {
      if (d.interaction_id) {
        const existing = draftsByInteraction.get(d.interaction_id)
        if (!existing || d.created_at < existing) {
          draftsByInteraction.set(d.interaction_id, d.created_at)
        }
      }
    }

    let totalResponseMinutes = 0
    let responseCount = 0
    for (const i of inbound) {
      const draftTime = draftsByInteraction.get(i.id)
      if (draftTime) {
        const diff = new Date(draftTime).getTime() - new Date(i.timestamp).getTime()
        totalResponseMinutes += diff / (1000 * 60)
        responseCount++
      }
    }
    const avgResponseMinutes = responseCount > 0
      ? Math.round(totalResponseMinutes / responseCount)
      : null

    // ── Draft stats ────────────────────────────────────────────────────
    const total = drafts.length
    const approved = drafts.filter((d) => d.status === 'approved' || d.status === 'sent').length
    const rejected = drafts.filter((d) => d.status === 'rejected').length
    // Edited = approved drafts that also had feedback (approximated: drafts with status sent/approved and cost > 0)
    // Since we don't have explicit "edited" status, count auto_sent as separate category
    const autoSent = drafts.filter((d) => d.auto_sent).length
    const edited = 0 // Would require draft_feedback join — placeholder for now
    const approvalRate = total > 0 ? Math.round(((approved + autoSent) / total) * 100) : 0
    const editRate = total > 0 ? Math.round((edited / total) * 100) : 0

    // ── Auto-send breakdown ────────────────────────────────────────────
    const sourcesBreakdown: Record<string, number> = {}
    for (const d of drafts) {
      if (d.auto_sent && d.auto_send_source) {
        sourcesBreakdown[d.auto_send_source] = (sourcesBreakdown[d.auto_send_source] ?? 0) + 1
      }
    }

    // ── Cost stats ─────────────────────────────────────────────────────
    const totalCost = costs.reduce((sum, c) => sum + (Number(c.cost) || 0), 0)
    const avgPerEmail = total > 0 ? Math.round((totalCost / total) * 100) / 100 : 0

    const byContext: Record<string, number> = {}
    for (const c of costs) {
      const ctx = c.context ?? 'other'
      byContext[ctx] = (byContext[ctx] ?? 0) + (Number(c.cost) || 0)
    }
    // Round values
    for (const key of Object.keys(byContext)) {
      byContext[key] = Math.round(byContext[key] * 100) / 100
    }

    // ── Build response ─────────────────────────────────────────────────
    return NextResponse.json({
      period,
      response_time: {
        avg_minutes: avgResponseMinutes,
        sample_size: responseCount,
      },
      drafts: {
        total,
        approved,
        rejected,
        edited,
        auto_sent: autoSent,
        approval_rate: approvalRate,
        edit_rate: editRate,
      },
      auto_send: {
        total_auto_sent: autoSent,
        sources_breakdown: sourcesBreakdown,
      },
      cost: {
        total_cost: Math.round(totalCost * 100) / 100,
        avg_per_email: avgPerEmail,
        by_context: byContext,
      },
      conversion: {
        inquiries: inquiriesResult.count ?? 0,
        tours_scheduled: toursResult.count ?? 0,
        booked: bookedResult.count ?? 0,
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
