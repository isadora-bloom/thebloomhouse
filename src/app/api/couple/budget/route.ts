import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

const ALLOWED_FIELDS = [
  'category', 'item_name', 'estimated_cost', 'actual_cost',
  'paid_amount', 'vendor_id', 'notes',
] as const

function pick(body: Record<string, unknown>, fields: readonly string[]) {
  const result: Record<string, unknown> = {}
  for (const key of fields) {
    if (key in body) result[key] = body[key]
  }
  return result
}

interface BudgetRow {
  category: string | null
  estimated_cost: number | null
  actual_cost: number | null
  paid_amount: number | null
}

// GET — list all budget items + summary
export async function GET() {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('budget')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('category', { ascending: true })

    if (error) throw error

    const rows = (data ?? []) as BudgetRow[]
    let totalEstimated = 0
    let totalActual = 0
    let totalPaid = 0
    const byCategory: Record<string, { estimated: number; actual: number; paid: number }> = {}

    for (const row of rows) {
      const est = row.estimated_cost ?? 0
      const act = row.actual_cost ?? 0
      const paid = row.paid_amount ?? 0
      totalEstimated += est
      totalActual += act
      totalPaid += paid

      const cat = row.category ?? 'Uncategorized'
      if (!byCategory[cat]) byCategory[cat] = { estimated: 0, actual: 0, paid: 0 }
      byCategory[cat].estimated += est
      byCategory[cat].actual += act
      byCategory[cat].paid += paid
    }

    return NextResponse.json({
      data,
      summary: { totalEstimated, totalActual, totalPaid, byCategory },
    })
  } catch (err) {
    return serverError(err)
  }
}

// POST — create budget item
export async function POST(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const fields = pick(body, ALLOWED_FIELDS)
    if (!fields.item_name) return badRequest('item_name is required')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('budget')
      .insert({
        ...fields,
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// PATCH — update budget item by id
export async function PATCH(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const { id } = body
    if (!id) return badRequest('id is required')

    const fields = pick(body, ALLOWED_FIELDS)
    if (Object.keys(fields).length === 0) return badRequest('No fields to update')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('budget')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (err) {
    return serverError(err)
  }
}

// DELETE — delete budget item by id (query param)
export async function DELETE(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return badRequest('id query param is required')

    const supabase = createServiceClient()
    const { error } = await supabase
      .from('budget')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return serverError(err)
  }
}
