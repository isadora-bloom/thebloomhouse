import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — List campaigns with computed ROI
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('start_date', { ascending: false })

    if (error) return serverError(error)

    const enriched = (campaigns ?? []).map(c => ({
      ...c,
      computed_roi: c.spend && Number(c.spend) > 0
        ? Math.round((Number(c.revenue_attributed) / Number(c.spend)) * 100) / 100
        : null,
    }))

    return NextResponse.json({ campaigns: enriched })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — Create a campaign
//   Body: { name, channel, start_date, end_date, spend, notes }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { name, channel, start_date, end_date, spend, notes } = body

    if (!name) return badRequest('name is required')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('campaigns')
      .insert({
        venue_id: auth.venueId,
        name,
        channel: channel ?? null,
        start_date: start_date ?? null,
        end_date: end_date ?? null,
        spend: spend ?? 0,
        notes: notes ?? null,
      })
      .select()
      .single()

    if (error) return serverError(error)
    return NextResponse.json({ campaign: data }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// PATCH — Update a campaign
//   Body: { id, ...fields }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { id, ...fields } = body

    if (!id) return badRequest('id is required')

    // Allowlist of updatable fields
    const allowed = [
      'name', 'channel', 'start_date', 'end_date', 'spend', 'notes',
      'inquiries_attributed', 'tours_attributed', 'bookings_attributed', 'revenue_attributed',
    ]
    const update: Record<string, unknown> = {}
    for (const key of allowed) {
      if (fields[key] !== undefined) update[key] = fields[key]
    }

    // Recompute derived fields if spend/revenue changed
    const spend = update.spend !== undefined ? Number(update.spend) : undefined
    const revenue = update.revenue_attributed !== undefined ? Number(update.revenue_attributed) : undefined
    const inquiries = update.inquiries_attributed !== undefined ? Number(update.inquiries_attributed) : undefined
    const bookings = update.bookings_attributed !== undefined ? Number(update.bookings_attributed) : undefined

    if (spend !== undefined && inquiries !== undefined && inquiries > 0) {
      update.cost_per_inquiry = Math.round((spend / inquiries) * 100) / 100
    }
    if (spend !== undefined && bookings !== undefined && bookings > 0) {
      update.cost_per_booking = Math.round((spend / bookings) * 100) / 100
    }
    if (spend !== undefined && revenue !== undefined && spend > 0) {
      update.roi_ratio = Math.round((revenue / spend) * 100) / 100
    }

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('campaigns')
      .update(update)
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) return serverError(error)
    return NextResponse.json({ campaign: data })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// DELETE — Delete a campaign by id (query param)
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return badRequest('id query param is required')

    const supabase = createServiceClient()
    const { error } = await supabase
      .from('campaigns')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)

    if (error) return serverError(error)
    return NextResponse.json({ success: true })
  } catch (err) {
    return serverError(err)
  }
}
