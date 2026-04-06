import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/portal/wedding-detail-config
// Table: wedding_detail_config (single row per venue, upsert)
// ---------------------------------------------------------------------------

// ---- GET ----
export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('wedding_detail_config')
      .select('*')
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    if (error) throw error

    return NextResponse.json({ data: data ?? null })
  } catch (error) {
    return serverError(error)
  }
}

// ---- POST (upsert) ----
export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const body = await request.json()

    const payload = {
      venue_id: auth.venueId,
      allow_outside_ceremony: body.allow_outside_ceremony ?? true,
      allow_inside_ceremony: body.allow_inside_ceremony ?? true,
      arbor_options: body.arbor_options ?? [],
      allow_unity_table: body.allow_unity_table ?? true,
      allow_charger_plates: body.allow_charger_plates ?? true,
      allow_champagne_glasses: body.allow_champagne_glasses ?? true,
      allow_sparklers: body.allow_sparklers ?? true,
      allow_wands: body.allow_wands ?? true,
      allow_bubbles: body.allow_bubbles ?? true,
      custom_send_off_options: body.custom_send_off_options ?? [],
      custom_fields: body.custom_fields ?? [],
      updated_at: new Date().toISOString(),
    }

    // Check if record exists
    const { data: existing } = await supabase
      .from('wedding_detail_config')
      .select('id')
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    if (existing) {
      const { data, error } = await supabase
        .from('wedding_detail_config')
        .update(payload)
        .eq('id', existing.id)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data })
    } else {
      const { data, error } = await supabase
        .from('wedding_detail_config')
        .insert(payload)
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data }, { status: 201 })
    }
  } catch (error) {
    return serverError(error)
  }
}
