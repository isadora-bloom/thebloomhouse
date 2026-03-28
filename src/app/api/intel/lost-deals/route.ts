import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — List lost deals or summary
//   ?reason=reason_category filter
//   ?summary=true → breakdown by reason_category
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const summary = searchParams.get('summary') === 'true'
    const reason = searchParams.get('reason')

    const supabase = createServiceClient()

    if (summary) {
      const { data: deals, error } = await supabase
        .from('lost_deals')
        .select('reason_category, competitor_name')
        .eq('venue_id', auth.venueId)

      if (error) return serverError(error)

      const rows = deals ?? []
      const breakdown: Record<string, number> = {}
      const competitors: Record<string, number> = {}

      for (const d of rows) {
        const cat = d.reason_category ?? 'other'
        breakdown[cat] = (breakdown[cat] ?? 0) + 1
        if (d.competitor_name) {
          competitors[d.competitor_name] = (competitors[d.competitor_name] ?? 0) + 1
        }
      }

      // Top competitors sorted by frequency
      const top_competitors = Object.entries(competitors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, count }))

      return NextResponse.json({
        total: rows.length,
        breakdown,
        top_competitors,
      })
    }

    // List lost deals
    let q = supabase
      .from('lost_deals')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('lost_at', { ascending: false })

    if (reason) q = q.eq('reason_category', reason)

    const { data: deals, error } = await q
    if (error) return serverError(error)

    // Fetch couple names
    const weddingIds = [...new Set((deals ?? []).map(d => d.wedding_id).filter(Boolean))]
    let peopleByWedding: Record<string, string> = {}

    if (weddingIds.length > 0) {
      const { data: people } = await supabase
        .from('people')
        .select('wedding_id, first_name, last_name, role')
        .in('wedding_id', weddingIds)
        .in('role', ['partner1', 'partner2'])

      if (people) {
        const grouped: Record<string, string[]> = {}
        for (const p of people) {
          if (!p.wedding_id) continue
          if (!grouped[p.wedding_id]) grouped[p.wedding_id] = []
          grouped[p.wedding_id].push([p.first_name, p.last_name].filter(Boolean).join(' '))
        }
        for (const [wid, names] of Object.entries(grouped)) {
          peopleByWedding[wid] = names.join(' & ')
        }
      }
    }

    const enriched = (deals ?? []).map(d => ({
      ...d,
      couple_names: d.wedding_id ? (peopleByWedding[d.wedding_id] ?? null) : null,
    }))

    return NextResponse.json({ lost_deals: enriched })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — Record a lost deal
//   Body: { wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name }
//   Also updates wedding status to 'lost'
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { wedding_id, lost_at_stage, reason_category, reason_detail, competitor_name } = body

    if (!wedding_id) return badRequest('wedding_id is required')
    if (!reason_category) return badRequest('reason_category is required')

    const supabase = createServiceClient()

    // Create lost deal and update wedding status in parallel
    const [dealResult, weddingResult] = await Promise.all([
      supabase
        .from('lost_deals')
        .insert({
          venue_id: auth.venueId,
          wedding_id,
          lost_at_stage: lost_at_stage ?? null,
          reason_category,
          reason_detail: reason_detail ?? null,
          competitor_name: competitor_name ?? null,
          lost_at: new Date().toISOString(),
        })
        .select()
        .single(),
      supabase
        .from('weddings')
        .update({ status: 'lost', lost_at: new Date().toISOString(), lost_reason: reason_category })
        .eq('id', wedding_id)
        .eq('venue_id', auth.venueId),
    ])

    if (dealResult.error) return serverError(dealResult.error)
    return NextResponse.json({ lost_deal: dealResult.data }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// PATCH — Record a recovery attempt
//   Body: { id, recovery_attempted: true, recovery_outcome }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { id, recovery_attempted, recovery_outcome } = body

    if (!id) return badRequest('id is required')

    const supabase = createServiceClient()

    const update: Record<string, unknown> = {}
    if (recovery_attempted !== undefined) update.recovery_attempted = recovery_attempted
    if (recovery_outcome !== undefined) update.recovery_outcome = recovery_outcome

    const { data, error } = await supabase
      .from('lost_deals')
      .update(update)
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) return serverError(error)
    return NextResponse.json({ lost_deal: data })
  } catch (err) {
    return serverError(err)
  }
}
