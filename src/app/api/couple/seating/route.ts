import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/couple/seating
// Tables: seating_tables, seating_assignments, guest_list
// ---------------------------------------------------------------------------

const TABLE_FIELDS = [
  'table_name', 'table_type', 'capacity', 'x_position', 'y_position', 'rotation',
] as const

const ASSIGNMENT_FIELDS = ['guest_id', 'table_id', 'seat_number'] as const

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    void request // consumed for type — no query params needed

    // Fetch all tables with their assignments (including guest info)
    const { data: tables, error: tablesErr } = await supabase
      .from('seating_tables')
      .select(`
        *,
        assignments:seating_assignments(
          id, guest_id, seat_number, created_at,
          guest:guest_list(
            id, group_name, rsvp_status, plus_one_name,
            person:people(id, first_name, last_name)
          )
        )
      `)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('table_name')

    if (tablesErr) throw tablesErr

    // Fetch all assigned guest IDs to determine unassigned guests
    const { data: allAssignments, error: assignErr } = await supabase
      .from('seating_assignments')
      .select('guest_id')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)

    if (assignErr) throw assignErr

    const assignedGuestIds = new Set((allAssignments ?? []).map((a) => a.guest_id))

    // Fetch guests not assigned to any table
    let unassignedQuery = supabase
      .from('guest_list')
      .select(`
        id, group_name, rsvp_status, plus_one_name,
        person:people(id, first_name, last_name)
      `)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('created_at')

    // If there are assigned guests, exclude them
    if (assignedGuestIds.size > 0) {
      unassignedQuery = unassignedQuery.not('id', 'in', `(${[...assignedGuestIds].join(',')})`)
    }

    const { data: unassigned, error: unassignedErr } = await unassignedQuery
    if (unassignedErr) throw unassignedErr

    return NextResponse.json({ tables: tables ?? [], unassigned: unassigned ?? [] })
  } catch (error) {
    return serverError(error)
  }
}

// ---- POST ----
export async function POST(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)
    const resource = searchParams.get('resource')
    const body = await request.json()

    if (resource === 'table') {
      const record: Record<string, unknown> = {
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
      }
      for (const field of TABLE_FIELDS) {
        if (body[field] !== undefined) record[field] = body[field]
      }

      const { data, error } = await supabase
        .from('seating_tables')
        .insert(record)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data }, { status: 201 })
    }

    if (resource === 'assignment') {
      if (!body.guest_id) return badRequest('guest_id is required')
      if (!body.table_id) return badRequest('table_id is required')

      const record: Record<string, unknown> = {
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
      }
      for (const field of ASSIGNMENT_FIELDS) {
        if (body[field] !== undefined) record[field] = body[field]
      }

      const { data, error } = await supabase
        .from('seating_assignments')
        .insert(record)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data }, { status: 201 })
    }

    return badRequest('resource query param required: table | assignment')
  } catch (error) {
    return serverError(error)
  }
}

// ---- PATCH ----
export async function PATCH(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)
    const resource = searchParams.get('resource')
    const body = await request.json()
    const { id } = body
    if (!id) return badRequest('id is required')

    if (resource === 'table') {
      const updates: Record<string, unknown> = {}
      for (const field of TABLE_FIELDS) {
        if (body[field] !== undefined) updates[field] = body[field]
      }

      const { data, error } = await supabase
        .from('seating_tables')
        .update(updates)
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data })
    }

    if (resource === 'assignment') {
      const updates: Record<string, unknown> = {}
      for (const field of ASSIGNMENT_FIELDS) {
        if (body[field] !== undefined) updates[field] = body[field]
      }

      const { data, error } = await supabase
        .from('seating_assignments')
        .update(updates)
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data })
    }

    return badRequest('resource query param required: table | assignment')
  } catch (error) {
    return serverError(error)
  }
}

// ---- DELETE ----
export async function DELETE(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)
    const resource = searchParams.get('resource')
    const id = searchParams.get('id')
    if (!id) return badRequest('id query parameter is required')

    if (resource === 'table') {
      // Cascade deletes assignments via FK
      const { error } = await supabase
        .from('seating_tables')
        .delete()
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)

      if (error) throw error
      return NextResponse.json({ success: true })
    }

    if (resource === 'assignment') {
      const { error } = await supabase
        .from('seating_assignments')
        .delete()
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)

      if (error) throw error
      return NextResponse.json({ success: true })
    }

    return badRequest('resource query param required: table | assignment')
  } catch (error) {
    return serverError(error)
  }
}
