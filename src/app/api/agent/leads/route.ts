import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Temperature tier from heat score
// ---------------------------------------------------------------------------

function temperatureFromScore(score: number): string {
  if (score >= 75) return 'hot'
  if (score >= 50) return 'warm'
  if (score >= 30) return 'cool'
  if (score >= 15) return 'cold'
  return 'frozen'
}

// ---------------------------------------------------------------------------
// GET — List leads OR return temperature distribution
//   ?distribution=true  → { hot, warm, cool, cold, frozen, booked, lost }
//   ?tier=hot|warm|cool|cold|frozen
//   ?sort=score|date|name  (default: score)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const supabase = createServiceClient()

    // ── Distribution mode ──────────────────────────────────────────────
    if (searchParams.get('distribution') === 'true') {
      const { data: weddings, error } = await supabase
        .from('weddings')
        .select('status, heat_score')
        .eq('venue_id', auth.venueId)

      if (error) throw error

      const dist = { hot: 0, warm: 0, cool: 0, cold: 0, frozen: 0, booked: 0, lost: 0 }

      for (const w of weddings ?? []) {
        if (w.status === 'booked' || w.status === 'completed') {
          dist.booked++
        } else if (w.status === 'lost' || w.status === 'cancelled') {
          dist.lost++
        } else {
          const tier = temperatureFromScore(w.heat_score ?? 0)
          dist[tier as keyof typeof dist]++
        }
      }

      return NextResponse.json({ distribution: dist })
    }

    // ── Lead list mode ─────────────────────────────────────────────────
    const tierFilter = searchParams.get('tier')
    const sortBy = searchParams.get('sort') ?? 'score'

    // Fetch inquiry weddings with people (partner1, partner2)
    let query = supabase
      .from('weddings')
      .select(`
        id,
        status,
        heat_score,
        wedding_date,
        guest_count_estimate,
        source,
        inquiry_date,
        created_at,
        people:people(id, first_name, last_name, role)
      `)
      .eq('venue_id', auth.venueId)
      .eq('status', 'inquiry')

    // Sort
    if (sortBy === 'date') {
      query = query.order('inquiry_date', { ascending: false })
    } else {
      query = query.order('heat_score', { ascending: false })
    }

    const { data: weddings, error } = await query

    if (error) throw error

    // Compute temperature tier and apply tier filter
    let leads = (weddings ?? []).map((w) => {
      const temperature = temperatureFromScore(w.heat_score ?? 0)
      return { ...w, temperature }
    })

    if (tierFilter) {
      leads = leads.filter((l) => l.temperature === tierFilter)
    }

    // Fetch last engagement event and source interaction for each lead
    const weddingIds = leads.map((l) => l.id)

    // Last engagement events (batch)
    const { data: lastEngagements } = weddingIds.length > 0
      ? await supabase
          .from('engagement_events')
          .select('wedding_id, event_type, created_at')
          .eq('venue_id', auth.venueId)
          .in('wedding_id', weddingIds)
          .order('created_at', { ascending: false })
      : { data: [] }

    // Source interactions — first inbound per wedding (batch)
    const { data: sourceInteractions } = weddingIds.length > 0
      ? await supabase
          .from('interactions')
          .select('wedding_id, subject, timestamp')
          .eq('venue_id', auth.venueId)
          .eq('direction', 'inbound')
          .in('wedding_id', weddingIds)
          .order('created_at', { ascending: true })
      : { data: [] }

    // Build lookup maps (first per wedding_id)
    const lastEngagementMap = new Map<string, { event_type: string; created_at: string }>()
    for (const e of lastEngagements ?? []) {
      if (!lastEngagementMap.has(e.wedding_id)) {
        lastEngagementMap.set(e.wedding_id, { event_type: e.event_type, created_at: e.created_at })
      }
    }

    const sourceMap = new Map<string, { subject: string | null; timestamp: string }>()
    for (const i of sourceInteractions ?? []) {
      if (!sourceMap.has(i.wedding_id)) {
        sourceMap.set(i.wedding_id, { subject: i.subject, timestamp: i.timestamp })
      }
    }

    // Enrich leads
    const enrichedLeads = leads.map((lead) => ({
      ...lead,
      last_engagement: lastEngagementMap.get(lead.id) ?? null,
      source_interaction: sourceMap.get(lead.id) ?? null,
    }))

    return NextResponse.json({ leads: enrichedLeads })
  } catch (err) {
    return serverError(err)
  }
}
