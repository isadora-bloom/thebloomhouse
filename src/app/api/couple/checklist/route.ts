import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

const ALLOWED_FIELDS = [
  'title', 'description', 'due_date', 'category',
  'is_completed', 'sort_order',
] as const

function pick(body: Record<string, unknown>, fields: readonly string[]) {
  const result: Record<string, unknown> = {}
  for (const key of fields) {
    if (key in body) result[key] = body[key]
  }
  return result
}

interface ChecklistRow {
  is_completed: boolean | null
  due_date: string | null
}

// GET — list all checklist items + summary
export async function GET() {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('checklist_items')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('sort_order', { ascending: true })

    if (error) throw error

    const rows = (data ?? []) as ChecklistRow[]
    const today = new Date().toISOString().split('T')[0]
    let total = 0
    let completed = 0
    let overdue = 0

    for (const row of rows) {
      total++
      if (row.is_completed) {
        completed++
      } else if (row.due_date && row.due_date < today) {
        overdue++
      }
    }

    return NextResponse.json({
      data,
      summary: { total, completed, overdue },
    })
  } catch (err) {
    return serverError(err)
  }
}

// POST — create checklist item
export async function POST(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const fields = pick(body, ALLOWED_FIELDS)
    if (!fields.title) return badRequest('title is required')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('checklist_items')
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

// PATCH — update checklist item by id
// Handles is_completed toggle: sets completed_at accordingly
export async function PATCH(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const { id } = body
    if (!id) return badRequest('id is required')

    const fields = pick(body, ALLOWED_FIELDS)
    if (Object.keys(fields).length === 0) return badRequest('No fields to update')

    // Handle completed_at based on is_completed changes
    const updates: Record<string, unknown> = {
      ...fields,
      updated_at: new Date().toISOString(),
    }

    if ('is_completed' in fields) {
      updates.completed_at = fields.is_completed
        ? new Date().toISOString()
        : null
    }

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('checklist_items')
      .update(updates)
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

// DELETE — delete checklist item by id (query param)
export async function DELETE(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return badRequest('id query param is required')

    const supabase = createServiceClient()
    const { error } = await supabase
      .from('checklist_items')
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
