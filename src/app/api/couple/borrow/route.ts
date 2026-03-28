import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/couple/borrow
// Tables: borrow_catalog (venue-level, read-only), borrow_selections (wedding-level)
// ---------------------------------------------------------------------------

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    void request

    // Venue's active borrow catalog
    const { data: catalog, error: catErr } = await supabase
      .from('borrow_catalog')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('is_active', true)
      .order('category')
      .order('item_name')

    if (catErr) throw catErr

    // Couple's selections with catalog item details
    const { data: selections, error: selErr } = await supabase
      .from('borrow_selections')
      .select(`
        *,
        catalog_item:borrow_catalog(id, item_name, category, description, image_url, quantity_available)
      `)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('created_at')

    if (selErr) throw selErr

    return NextResponse.json({
      data: {
        catalog: catalog ?? [],
        selections: selections ?? [],
      },
    })
  } catch (error) {
    return serverError(error)
  }
}

// ---- POST ----
export async function POST(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { catalog_item_id, quantity, notes } = body

    if (!catalog_item_id) return badRequest('catalog_item_id is required')

    const supabase = createServiceClient()

    // Verify the catalog item belongs to this venue and is active
    const { data: item, error: itemErr } = await supabase
      .from('borrow_catalog')
      .select('id')
      .eq('id', catalog_item_id)
      .eq('venue_id', auth.venueId)
      .eq('is_active', true)
      .maybeSingle()

    if (itemErr) throw itemErr
    if (!item) return badRequest('Catalog item not found or inactive')

    const { data, error } = await supabase
      .from('borrow_selections')
      .insert({
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
        catalog_item_id,
        quantity: quantity ?? 1,
        notes: notes ?? null,
      })
      .select(`
        *,
        catalog_item:borrow_catalog(id, item_name, category, description, image_url, quantity_available)
      `)
      .single()

    if (error) throw error
    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    return serverError(error)
  }
}

// ---- DELETE ----
export async function DELETE(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return badRequest('id query parameter is required')

    const supabase = createServiceClient()

    const { error } = await supabase
      .from('borrow_selections')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (error) {
    return serverError(error)
  }
}
