import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/portal/borrow
// Table: borrow_catalog (id, venue_id, item_name, category, description,
//        image_url, quantity_available, is_active, created_at)
// Join: borrow_selections (count per catalog item)
// ---------------------------------------------------------------------------

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    void request

    // Fetch all catalog items (including inactive — admin view)
    const { data: catalog, error: catErr } = await supabase
      .from('borrow_catalog')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('category')
      .order('item_name')

    if (catErr) throw catErr

    if (!catalog || catalog.length === 0) {
      return NextResponse.json({ data: [] })
    }

    // Fetch selection counts per catalog item
    const catalogIds = catalog.map((c) => c.id)

    const { data: selections, error: selErr } = await supabase
      .from('borrow_selections')
      .select('catalog_item_id')
      .eq('venue_id', auth.venueId)
      .in('catalog_item_id', catalogIds)

    if (selErr) throw selErr

    // Count selections per catalog item
    const countMap = new Map<string, number>()
    for (const s of selections ?? []) {
      const current = countMap.get(s.catalog_item_id) ?? 0
      countMap.set(s.catalog_item_id, current + 1)
    }

    const result = catalog.map((item) => ({
      ...item,
      selection_count: countMap.get(item.id) ?? 0,
    }))

    return NextResponse.json({ data: result })
  } catch (error) {
    return serverError(error)
  }
}

// ---- POST ----
export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { item_name, category, description, image_url, quantity_available, is_active } = body

    if (!item_name || typeof item_name !== 'string' || item_name.trim().length === 0) {
      return badRequest('item_name is required')
    }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('borrow_catalog')
      .insert({
        venue_id: auth.venueId,
        item_name: item_name.trim(),
        category: category ?? null,
        description: description ?? null,
        image_url: image_url ?? null,
        quantity_available: quantity_available ?? 1,
        is_active: is_active ?? true,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data }, { status: 201 })
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

    const allowed = [
      'item_name', 'category', 'description', 'image_url',
      'quantity_available', 'is_active',
    ] as const
    const updates: Record<string, unknown> = {}

    for (const key of allowed) {
      if (key in fields) {
        updates[key] = fields[key]
      }
    }

    if (Object.keys(updates).length === 0) {
      return badRequest('No valid fields to update')
    }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('borrow_catalog')
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

// ---- DELETE ----
export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return badRequest('id query parameter is required')

    const supabase = createServiceClient()

    // Delete catalog item — cascades to borrow_selections via FK
    const { error } = await supabase
      .from('borrow_catalog')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (error) {
    return serverError(error)
  }
}
