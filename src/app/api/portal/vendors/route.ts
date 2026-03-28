import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/portal/vendors
// Table: vendor_recommendations (id, venue_id, vendor_name, vendor_type,
//        contact_email, contact_phone, website_url, description, logo_url,
//        is_preferred, sort_order, click_count, created_at)
// ---------------------------------------------------------------------------

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)

    const type = searchParams.get('type')
    const preferred = searchParams.get('preferred')

    let query = supabase
      .from('vendor_recommendations')
      .select('*')
      .eq('venue_id', auth.venueId)

    if (type) {
      query = query.eq('vendor_type', type)
    }

    if (preferred === 'true') {
      query = query.eq('is_preferred', true)
    }

    query = query.order('sort_order', { ascending: true, nullsFirst: false })

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ data: data ?? [] })
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
    const {
      vendor_name,
      vendor_type,
      contact_email,
      contact_phone,
      website_url,
      description,
      logo_url,
      is_preferred,
      sort_order,
    } = body

    if (!vendor_name || typeof vendor_name !== 'string' || vendor_name.trim().length === 0) {
      return badRequest('vendor_name is required')
    }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('vendor_recommendations')
      .insert({
        venue_id: auth.venueId,
        vendor_name: vendor_name.trim(),
        vendor_type: vendor_type ?? null,
        contact_email: contact_email ?? null,
        contact_phone: contact_phone ?? null,
        website_url: website_url ?? null,
        description: description ?? null,
        logo_url: logo_url ?? null,
        is_preferred: is_preferred ?? false,
        sort_order: sort_order ?? 0,
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
    const { id, increment_clicks, ...fields } = body as Record<string, unknown>
    if (!id || typeof id !== 'string') return badRequest('id is required')

    const supabase = createServiceClient()

    // Generate portal token for vendor self-service
    if (fields.generate_token === true) {
      const token = randomUUID()

      const { data, error } = await supabase
        .from('vendor_recommendations')
        .update({ portal_token: token })
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data, portal_token: token })
    }

    // Increment click_count shortcut
    if (increment_clicks === true) {
      // Use rpc or fetch-then-update pattern
      const { data: current, error: fetchErr } = await supabase
        .from('vendor_recommendations')
        .select('click_count')
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .single()

      if (fetchErr) throw fetchErr

      const { data, error } = await supabase
        .from('vendor_recommendations')
        .update({ click_count: (current.click_count ?? 0) + 1 })
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data })
    }

    // Standard field update
    const allowed = [
      'vendor_name', 'vendor_type', 'contact_email', 'contact_phone',
      'website_url', 'description', 'logo_url', 'is_preferred', 'sort_order',
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

    const { data, error } = await supabase
      .from('vendor_recommendations')
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

    const { error } = await supabase
      .from('vendor_recommendations')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (error) {
    return serverError(error)
  }
}
