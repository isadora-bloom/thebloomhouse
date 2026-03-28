import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/couple/bar
// Tables: bar_planning, bar_recipes, bar_shopping_list
// ---------------------------------------------------------------------------

const PLANNING_FIELDS = ['bar_type', 'guest_count', 'bartender_count', 'notes'] as const
const RECIPE_FIELDS = ['cocktail_name', 'ingredients', 'instructions', 'servings', 'scaling_factor'] as const
const SHOPPING_FIELDS = ['item_name', 'category', 'quantity', 'unit', 'estimated_cost', 'purchased', 'notes'] as const

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    void request

    // Bar planning (single record per wedding)
    const { data: planning, error: planErr } = await supabase
      .from('bar_planning')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .maybeSingle()

    if (planErr) throw planErr

    // Recipes
    const { data: recipes, error: recErr } = await supabase
      .from('bar_recipes')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('cocktail_name')

    if (recErr) throw recErr

    // Shopping list
    const { data: shoppingList, error: shopErr } = await supabase
      .from('bar_shopping_list')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('category')
      .order('item_name')

    if (shopErr) throw shopErr

    return NextResponse.json({
      data: {
        planning: planning ?? null,
        recipes: recipes ?? [],
        shoppingList: shoppingList ?? [],
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
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)
    const resource = searchParams.get('resource')
    const body = await request.json()

    if (resource === 'planning') {
      // Upsert: check if a record already exists
      const { data: existing } = await supabase
        .from('bar_planning')
        .select('id')
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .maybeSingle()

      if (existing) {
        // Update existing
        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
        for (const field of PLANNING_FIELDS) {
          if (body[field] !== undefined) updates[field] = body[field]
        }

        const { data, error } = await supabase
          .from('bar_planning')
          .update(updates)
          .eq('id', existing.id)
          .eq('venue_id', auth.venueId)
          .eq('wedding_id', auth.weddingId)
          .select()
          .single()

        if (error) throw error
        return NextResponse.json({ data })
      } else {
        // Insert new
        const record: Record<string, unknown> = {
          venue_id: auth.venueId,
          wedding_id: auth.weddingId,
        }
        for (const field of PLANNING_FIELDS) {
          if (body[field] !== undefined) record[field] = body[field]
        }

        const { data, error } = await supabase
          .from('bar_planning')
          .insert(record)
          .select()
          .single()

        if (error) throw error
        return NextResponse.json({ data }, { status: 201 })
      }
    }

    if (resource === 'recipe') {
      if (!body.cocktail_name) return badRequest('cocktail_name is required')

      const record: Record<string, unknown> = {
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
      }
      for (const field of RECIPE_FIELDS) {
        if (body[field] !== undefined) record[field] = body[field]
      }

      const { data, error } = await supabase
        .from('bar_recipes')
        .insert(record)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data }, { status: 201 })
    }

    if (resource === 'shopping') {
      if (!body.item_name) return badRequest('item_name is required')

      const record: Record<string, unknown> = {
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
      }
      for (const field of SHOPPING_FIELDS) {
        if (body[field] !== undefined) record[field] = body[field]
      }

      const { data, error } = await supabase
        .from('bar_shopping_list')
        .insert(record)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data }, { status: 201 })
    }

    return badRequest('resource query param required: planning | recipe | shopping')
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

    if (resource === 'planning') {
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      for (const field of PLANNING_FIELDS) {
        if (body[field] !== undefined) updates[field] = body[field]
      }

      const { data, error } = await supabase
        .from('bar_planning')
        .update(updates)
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data })
    }

    if (resource === 'recipe') {
      const updates: Record<string, unknown> = {}
      for (const field of RECIPE_FIELDS) {
        if (body[field] !== undefined) updates[field] = body[field]
      }

      const { data, error } = await supabase
        .from('bar_recipes')
        .update(updates)
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data })
    }

    if (resource === 'shopping') {
      const updates: Record<string, unknown> = {}
      for (const field of SHOPPING_FIELDS) {
        if (body[field] !== undefined) updates[field] = body[field]
      }

      const { data, error } = await supabase
        .from('bar_shopping_list')
        .update(updates)
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data })
    }

    return badRequest('resource query param required: planning | recipe | shopping')
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

    if (resource === 'recipe') {
      const { error } = await supabase
        .from('bar_recipes')
        .delete()
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)

      if (error) throw error
      return NextResponse.json({ success: true })
    }

    if (resource === 'shopping') {
      const { error } = await supabase
        .from('bar_shopping_list')
        .delete()
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)

      if (error) throw error
      return NextResponse.json({ success: true })
    }

    return badRequest('resource query param required: recipe | shopping')
  } catch (error) {
    return serverError(error)
  }
}
