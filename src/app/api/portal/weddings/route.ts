import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/portal/weddings
// Tables: weddings, people, checklist_items, budget, timeline, messages,
//         guest_list, contracts
// ---------------------------------------------------------------------------

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    // ------------------------------------------------------------------
    // Single wedding — full detail
    // ------------------------------------------------------------------
    if (id) {
      const { data: wedding, error } = await supabase
        .from('weddings')
        .select('*')
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .single()

      if (error) throw error
      if (!wedding) return NextResponse.json({ error: 'Wedding not found' }, { status: 404 })

      // Fetch all related data in parallel
      const [
        peopleRes,
        guestCountRes,
        checklistRes,
        budgetRes,
        timelineRes,
        messagesRes,
        contractsRes,
      ] = await Promise.all([
        // People attached to this wedding
        supabase
          .from('people')
          .select('*')
          .eq('venue_id', auth.venueId)
          .eq('wedding_id', id),

        // Guest count
        supabase
          .from('guest_list')
          .select('*', { count: 'exact', head: true })
          .eq('venue_id', auth.venueId)
          .eq('wedding_id', id),

        // Checklist items
        supabase
          .from('checklist_items')
          .select('id, is_completed')
          .eq('venue_id', auth.venueId)
          .eq('wedding_id', id),

        // Budget items
        supabase
          .from('budget')
          .select('estimated_cost, paid_amount')
          .eq('venue_id', auth.venueId)
          .eq('wedding_id', id),

        // Upcoming timeline items (time >= now, limit 5)
        supabase
          .from('timeline')
          .select('*')
          .eq('venue_id', auth.venueId)
          .eq('wedding_id', id)
          .order('sort_order', { ascending: true })
          .limit(5),

        // Recent messages (last 10)
        supabase
          .from('messages')
          .select('*')
          .eq('venue_id', auth.venueId)
          .eq('wedding_id', id)
          .order('created_at', { ascending: false })
          .limit(10),

        // Contracts count
        supabase
          .from('contracts')
          .select('*', { count: 'exact', head: true })
          .eq('venue_id', auth.venueId)
          .eq('wedding_id', id),
      ])

      if (peopleRes.error) throw peopleRes.error
      if (guestCountRes.error) throw guestCountRes.error
      if (checklistRes.error) throw checklistRes.error
      if (budgetRes.error) throw budgetRes.error
      if (timelineRes.error) throw timelineRes.error
      if (messagesRes.error) throw messagesRes.error
      if (contractsRes.error) throw contractsRes.error

      // Compute checklist summary
      const checklistItems = checklistRes.data ?? []
      const checklistSummary = {
        total: checklistItems.length,
        completed: checklistItems.filter((c) => c.is_completed).length,
      }

      // Compute budget summary
      const budgetItems = budgetRes.data ?? []
      const budgetSummary = {
        totalEstimated: budgetItems.reduce(
          (sum, b) => sum + (Number(b.estimated_cost) || 0),
          0
        ),
        totalPaid: budgetItems.reduce(
          (sum, b) => sum + (Number(b.paid_amount) || 0),
          0
        ),
      }

      return NextResponse.json({
        data: {
          ...wedding,
          people: peopleRes.data ?? [],
          guest_count: guestCountRes.count ?? 0,
          checklist: checklistSummary,
          budget: budgetSummary,
          timeline: timelineRes.data ?? [],
          recent_messages: messagesRes.data ?? [],
          contracts_count: contractsRes.count ?? 0,
        },
      })
    }

    // ------------------------------------------------------------------
    // List all weddings
    // ------------------------------------------------------------------
    const status = searchParams.get('status')
    const search = searchParams.get('search')
    const archived = searchParams.get('archived')

    // Build wedding query
    let query = supabase
      .from('weddings')
      .select('*')
      .eq('venue_id', auth.venueId)

    if (status) {
      query = query.eq('status', status)
    }

    // Filter by archived status (cancelled / completed treated as archived)
    if (archived === 'true') {
      query = query.in('status', ['completed', 'cancelled'])
    } else if (!status) {
      // Default: exclude archived unless explicitly filtered
      query = query.not('status', 'in', '("completed","cancelled")')
    }

    query = query.order('wedding_date', { ascending: false, nullsFirst: false })

    const { data: weddings, error: weddingsErr } = await query
    if (weddingsErr) throw weddingsErr

    if (!weddings || weddings.length === 0) {
      return NextResponse.json({ data: [] })
    }

    const weddingIds = weddings.map((w) => w.id)

    // Fetch couple names and last message timestamps in parallel
    const [peopleRes, messagesRes] = await Promise.all([
      supabase
        .from('people')
        .select('wedding_id, first_name, last_name, role')
        .eq('venue_id', auth.venueId)
        .in('wedding_id', weddingIds)
        .in('role', ['partner1', 'partner2']),

      supabase
        .from('messages')
        .select('wedding_id, created_at')
        .eq('venue_id', auth.venueId)
        .in('wedding_id', weddingIds)
        .order('created_at', { ascending: false }),
    ])

    if (peopleRes.error) throw peopleRes.error
    if (messagesRes.error) throw messagesRes.error

    // Build couple names map
    const coupleMap = new Map<string, string>()
    for (const p of peopleRes.data ?? []) {
      if (!p.wedding_id) continue
      const existing = coupleMap.get(p.wedding_id) ?? ''
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ')
      coupleMap.set(p.wedding_id, existing ? `${existing} & ${name}` : name)
    }

    // Build last activity map (most recent message per wedding)
    const lastActivityMap = new Map<string, string>()
    for (const m of messagesRes.data ?? []) {
      if (!m.wedding_id || lastActivityMap.has(m.wedding_id)) continue
      lastActivityMap.set(m.wedding_id, m.created_at)
    }

    // Assemble response
    let results = weddings.map((w) => ({
      ...w,
      couple_names: coupleMap.get(w.id) ?? null,
      last_activity_at: lastActivityMap.get(w.id) ?? null,
    }))

    // Search filter (couple names or notes)
    if (search) {
      const term = search.toLowerCase()
      results = results.filter(
        (w) =>
          w.couple_names?.toLowerCase().includes(term) ||
          w.notes?.toLowerCase().includes(term)
      )
    }

    return NextResponse.json({ data: results })
  } catch (error) {
    return serverError(error)
  }
}

// ---- PATCH ----
export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { id, ...fields } = body as Record<string, unknown>
    if (!id || typeof id !== 'string') return badRequest('id is required')

    // Whitelist allowed fields
    const allowed = ['status', 'notes', 'package', 'hold_expires_at'] as const
    const updates: Record<string, unknown> = {}

    for (const key of allowed) {
      if (key in fields) {
        updates[key] = fields[key]
      }
    }

    if (Object.keys(updates).length === 0) {
      return badRequest('No valid fields to update')
    }

    updates.updated_at = new Date().toISOString()

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('weddings')
      .update(updates)
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (error) {
    return serverError(error)
  }
}
