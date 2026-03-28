import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — List pending client matches
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()

    const { data: matches, error } = await supabase
      .from('client_match_queue')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) return serverError(error)

    // Gather all client IDs (wedding IDs) for enrichment
    const clientIds = new Set<string>()
    for (const m of matches ?? []) {
      if (m.client_a_id) clientIds.add(m.client_a_id)
      if (m.client_b_id) clientIds.add(m.client_b_id)
    }

    let weddingInfo: Record<string, { status: string; couple_names: string }> = {}

    if (clientIds.size > 0) {
      const ids = [...clientIds]

      // Fetch wedding statuses
      const { data: weddings } = await supabase
        .from('weddings')
        .select('id, status')
        .in('id', ids)

      // Fetch people for couple names
      const { data: people } = await supabase
        .from('people')
        .select('wedding_id, first_name, last_name, role')
        .in('wedding_id', ids)
        .in('role', ['partner1', 'partner2'])

      const namesByWedding: Record<string, string[]> = {}
      for (const p of people ?? []) {
        if (!p.wedding_id) continue
        if (!namesByWedding[p.wedding_id]) namesByWedding[p.wedding_id] = []
        namesByWedding[p.wedding_id].push([p.first_name, p.last_name].filter(Boolean).join(' '))
      }

      for (const w of weddings ?? []) {
        weddingInfo[w.id] = {
          status: w.status,
          couple_names: (namesByWedding[w.id] ?? []).join(' & '),
        }
      }
    }

    const enriched = (matches ?? []).map(m => ({
      ...m,
      client_a: m.client_a_id ? (weddingInfo[m.client_a_id] ?? null) : null,
      client_b: m.client_b_id ? (weddingInfo[m.client_b_id] ?? null) : null,
    }))

    return NextResponse.json({ matches: enriched })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// PATCH — Resolve a match
//   ?action=merge  → Body: { id }. Set status to 'merged'.
//   ?action=dismiss → Body: { id }. Set status to 'dismissed', resolved_by/at.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')
    const body = await request.json()
    const { id } = body

    if (!id) return badRequest('id is required')
    if (!action || !['merge', 'dismiss'].includes(action)) {
      return badRequest('action query param must be "merge" or "dismiss"')
    }

    const supabase = createServiceClient()

    if (action === 'merge') {
      // For now, just update status. Actual merge logic is complex.
      const { data, error } = await supabase
        .from('client_match_queue')
        .update({
          status: 'merged',
          resolved_by: auth.userId,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .select()
        .single()

      if (error) return serverError(error)
      return NextResponse.json({ match: data })
    }

    // dismiss
    const { data, error } = await supabase
      .from('client_match_queue')
      .update({
        status: 'dismissed',
        resolved_by: auth.userId,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) return serverError(error)
    return NextResponse.json({ match: data })
  } catch (err) {
    return serverError(err)
  }
}
