import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Helper: period filter
// ---------------------------------------------------------------------------

function periodCutoff(period: string | null): string | null {
  if (!period || period === 'all') return null
  const days = period === '90d' ? 90 : 30
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

// ---------------------------------------------------------------------------
// GET — List tours or summary
//   ?outcome=completed|cancelled|no_show|rescheduled
//   ?period=30d|90d|all
//   ?summary=true  → aggregated stats
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const summary = searchParams.get('summary') === 'true'
    const outcome = searchParams.get('outcome')
    const period = searchParams.get('period')
    const cutoff = periodCutoff(period)

    const supabase = createServiceClient()

    if (summary) {
      // Fetch all tours for aggregation
      let q = supabase
        .from('tours')
        .select('id, outcome, wedding_id')
        .eq('venue_id', auth.venueId)

      if (cutoff) q = q.gte('scheduled_at', cutoff)

      const { data: tours, error } = await q
      if (error) return serverError(error)

      const total = tours?.length ?? 0
      const completed = tours?.filter(t => t.outcome === 'completed').length ?? 0
      const cancelled = tours?.filter(t => t.outcome === 'cancelled').length ?? 0
      const no_show = tours?.filter(t => t.outcome === 'no_show').length ?? 0
      const rescheduled = tours?.filter(t => t.outcome === 'rescheduled').length ?? 0

      // Conversion: completed tours that led to booked weddings
      const completedWeddingIds = tours
        ?.filter(t => t.outcome === 'completed' && t.wedding_id)
        .map(t => t.wedding_id) ?? []

      let bookedCount = 0
      if (completedWeddingIds.length > 0) {
        const { data: booked } = await supabase
          .from('weddings')
          .select('id')
          .eq('venue_id', auth.venueId)
          .in('id', completedWeddingIds)
          .in('status', ['booked', 'completed'])

        bookedCount = booked?.length ?? 0
      }

      const conversion_rate = completed > 0
        ? Math.round((bookedCount / completed) * 100) / 100
        : 0

      return NextResponse.json({
        total,
        completed,
        cancelled,
        no_show,
        rescheduled,
        conversion_rate,
      })
    }

    // List tours with joins
    let q = supabase
      .from('tours')
      .select(`
        *,
        weddings ( id, status ),
        conductor:user_profiles!tours_conducted_by_fkey ( id, first_name, last_name )
      `)
      .eq('venue_id', auth.venueId)
      .order('scheduled_at', { ascending: false })

    if (outcome) q = q.eq('outcome', outcome)
    if (cutoff) q = q.gte('scheduled_at', cutoff)

    const { data: tours, error } = await q
    if (error) return serverError(error)

    // Fetch couple names for each wedding
    const weddingIds = [...new Set((tours ?? []).map(t => t.wedding_id).filter(Boolean))]
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

    const enriched = (tours ?? []).map(t => ({
      ...t,
      couple_names: t.wedding_id ? (peopleByWedding[t.wedding_id] ?? null) : null,
      conducted_by_name: t.conductor
        ? [t.conductor.first_name, t.conductor.last_name].filter(Boolean).join(' ')
        : null,
    }))

    return NextResponse.json({ tours: enriched })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — Create a tour
//   Body: { wedding_id, scheduled_at, tour_type, conducted_by, source, notes }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { wedding_id, scheduled_at, tour_type, conducted_by, source, notes } = body

    if (!scheduled_at) return badRequest('scheduled_at is required')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('tours')
      .insert({
        venue_id: auth.venueId,
        wedding_id: wedding_id ?? null,
        scheduled_at,
        tour_type: tour_type ?? null,
        conducted_by: conducted_by ?? null,
        source: source ?? null,
        notes: notes ?? null,
      })
      .select()
      .single()

    if (error) return serverError(error)
    return NextResponse.json({ tour: data }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// PATCH — Update tour outcome
//   Body: { id, outcome, booking_date?, competing_venues?, notes? }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { id, outcome, booking_date, competing_venues, notes } = body

    if (!id) return badRequest('id is required')
    if (!outcome) return badRequest('outcome is required')

    const supabase = createServiceClient()

    const update: Record<string, unknown> = { outcome }
    if (booking_date !== undefined) update.booking_date = booking_date
    if (competing_venues !== undefined) update.competing_venues = competing_venues
    if (notes !== undefined) update.notes = notes

    const { data, error } = await supabase
      .from('tours')
      .update(update)
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) return serverError(error)
    return NextResponse.json({ tour: data })
  } catch (err) {
    return serverError(err)
  }
}
