import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

interface StaffingAssignment {
  id: string
  role: string
  person_name: string | null
  count: number
  hourly_rate: number
  hours: number
  tip_amount: number
  notes: string | null
}

interface RoleSummary {
  count: number
  totalCost: number
}

function computeSummary(assignments: StaffingAssignment[]) {
  let totalCost = 0
  const byRole: Record<string, RoleSummary> = {}

  for (const a of assignments) {
    const lineCost = (a.count ?? 0) * (a.hourly_rate ?? 0) * (a.hours ?? 0) + (a.tip_amount ?? 0)
    totalCost += lineCost

    if (a.role) {
      if (!byRole[a.role]) {
        byRole[a.role] = { count: 0, totalCost: 0 }
      }
      byRole[a.role].count += a.count ?? 0
      byRole[a.role].totalCost += lineCost
    }
  }

  return { totalCost, byRole }
}

// GET /api/couple/staffing — list assignments + summary
export async function GET() {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('staffing_assignments')
      .select('*')
      .eq('wedding_id', auth.weddingId)
      .eq('venue_id', auth.venueId)
      .order('created_at', { ascending: true })

    if (error) return serverError(error)

    const assignments = (data ?? []) as StaffingAssignment[]
    const summary = computeSummary(assignments)

    return NextResponse.json({ assignments, summary })
  } catch (err) {
    return serverError(err)
  }
}

// POST /api/couple/staffing — create staffing assignment
export async function POST(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await req.json()
    const { role, person_name, count, hourly_rate, hours, tip_amount, notes } = body

    if (!role) return badRequest('role is required')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('staffing_assignments')
      .insert({
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
        role,
        person_name: person_name ?? null,
        count: count ?? 1,
        hourly_rate: hourly_rate ?? 0,
        hours: hours ?? 0,
        tip_amount: tip_amount ?? 0,
        notes: notes ?? null,
      })
      .select()
      .single()

    if (error) return serverError(error)

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// PATCH /api/couple/staffing — update assignment
export async function PATCH(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await req.json()
    const { id, ...fields } = body

    if (!id) return badRequest('id is required')

    // Strip ownership fields
    delete fields.venue_id
    delete fields.wedding_id

    if (Object.keys(fields).length === 0) {
      return badRequest('No fields to update')
    }

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('staffing_assignments')
      .update(fields)
      .eq('id', id)
      .eq('wedding_id', auth.weddingId)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) return serverError(error)

    return NextResponse.json(data)
  } catch (err) {
    return serverError(err)
  }
}

// DELETE /api/couple/staffing?id=xxx — delete assignment
export async function DELETE(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const id = req.nextUrl.searchParams.get('id')
    if (!id) return badRequest('id query param is required')

    const supabase = createServiceClient()
    const { error } = await supabase
      .from('staffing_assignments')
      .delete()
      .eq('id', id)
      .eq('wedding_id', auth.weddingId)
      .eq('venue_id', auth.venueId)

    if (error) return serverError(error)

    return NextResponse.json({ success: true })
  } catch (err) {
    return serverError(err)
  }
}
