import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — Client list or single client detail
//   ?status=inquiry|tour_scheduled|...
//   ?search=term
//   ?sort=date|score|name
//   ?id=xxx  → single client detail
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const clientId = searchParams.get('id')
    const supabase = createServiceClient()

    // --- Single client detail ---
    if (clientId) {
      const [
        weddingResult,
        peopleResult,
        interactionsResult,
        engagementResult,
        contractsResult,
        checklistResult,
        budgetResult,
      ] = await Promise.all([
        supabase
          .from('weddings')
          .select('*')
          .eq('id', clientId)
          .eq('venue_id', auth.venueId)
          .single(),
        supabase
          .from('people')
          .select('*')
          .eq('wedding_id', clientId)
          .eq('venue_id', auth.venueId),
        supabase
          .from('interactions')
          .select('*')
          .eq('wedding_id', clientId)
          .eq('venue_id', auth.venueId)
          .order('timestamp', { ascending: false }),
        supabase
          .from('engagement_events')
          .select('*')
          .eq('wedding_id', clientId)
          .eq('venue_id', auth.venueId)
          .order('created_at', { ascending: false }),
        supabase
          .from('contracts')
          .select('*')
          .eq('wedding_id', clientId)
          .eq('venue_id', auth.venueId),
        supabase
          .from('checklist_items')
          .select('*')
          .eq('wedding_id', clientId)
          .eq('venue_id', auth.venueId)
          .order('sort_order', { ascending: true }),
        supabase
          .from('budget')
          .select('*')
          .eq('wedding_id', clientId)
          .eq('venue_id', auth.venueId),
      ])

      if (weddingResult.error) return serverError(weddingResult.error)

      // Compute budget summary
      const budgetItems = budgetResult.data ?? []
      const budget_summary = {
        total_estimated: budgetItems.reduce((s, b) => s + (Number(b.estimated_cost) || 0), 0),
        total_actual: budgetItems.reduce((s, b) => s + (Number(b.actual_cost) || 0), 0),
        total_paid: budgetItems.reduce((s, b) => s + (Number(b.paid_amount) || 0), 0),
        item_count: budgetItems.length,
      }

      // Checklist progress
      const checklistItems = checklistResult.data ?? []
      const checklist_progress = {
        total: checklistItems.length,
        completed: checklistItems.filter(c => c.is_completed).length,
        percentage: checklistItems.length > 0
          ? Math.round((checklistItems.filter(c => c.is_completed).length / checklistItems.length) * 100)
          : 0,
      }

      return NextResponse.json({
        wedding: weddingResult.data,
        people: peopleResult.data ?? [],
        interactions: interactionsResult.data ?? [],
        engagement_events: engagementResult.data ?? [],
        contracts: contractsResult.data ?? [],
        checklist_progress,
        budget_summary,
      })
    }

    // --- Client list ---
    const status = searchParams.get('status')
    const search = searchParams.get('search')
    const sort = searchParams.get('sort') ?? 'date'

    let q = supabase
      .from('weddings')
      .select('id, status, wedding_date, guest_count_estimate, heat_score, source, created_at, booking_value')
      .eq('venue_id', auth.venueId)

    if (status) q = q.eq('status', status)

    // Sort
    if (sort === 'score') {
      q = q.order('heat_score', { ascending: false })
    } else if (sort === 'name') {
      // We'll sort after joining people
      q = q.order('created_at', { ascending: false })
    } else {
      q = q.order('created_at', { ascending: false })
    }

    const { data: weddings, error } = await q
    if (error) return serverError(error)

    // Fetch couple names for all weddings
    const weddingIds = (weddings ?? []).map(w => w.id)
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

    let clients = (weddings ?? []).map(w => ({
      ...w,
      couple_names: peopleByWedding[w.id] ?? null,
    }))

    // Search filter (by couple_names)
    if (search) {
      const term = search.toLowerCase()
      clients = clients.filter(c =>
        c.couple_names?.toLowerCase().includes(term)
      )
    }

    // Sort by name if requested
    if (sort === 'name') {
      clients.sort((a, b) => (a.couple_names ?? '').localeCompare(b.couple_names ?? ''))
    }

    return NextResponse.json({ clients })
  } catch (err) {
    return serverError(err)
  }
}
