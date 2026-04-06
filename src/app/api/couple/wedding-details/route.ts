import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'
import { logActivity } from '@/lib/services/activity-logger'
import { createNotification } from '@/lib/services/admin-notifications'

// ---------------------------------------------------------------------------
// /api/couple/wedding-details
// Table: wedding_details (single row per wedding, upsert pattern)
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS = [
  'wedding_colors',
  'partner1_social',
  'partner2_social',
  'dogs_coming',
  'dogs_description',
  'ceremony_location',
  'arbor_choice',
  'unity_table',
  'ceremony_notes',
  'seating_method',
  'providing_table_numbers',
  'providing_charger_plates',
  'providing_champagne_glasses',
  'providing_cake_cutter',
  'providing_cake_topper',
  'favors_description',
  'reception_notes',
  'send_off_type',
  'send_off_notes',
  'custom_field_values',
] as const

function pick(body: Record<string, unknown>, fields: readonly string[]) {
  const result: Record<string, unknown> = {}
  for (const key of fields) {
    if (key in body) result[key] = body[key]
  }
  return result
}

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    void request

    const { data, error } = await supabase
      .from('wedding_details')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .maybeSingle()

    if (error) throw error

    return NextResponse.json({ data: data ?? null })
  } catch (error) {
    return serverError(error)
  }
}

// ---- POST (upsert) ----
export async function POST(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const body = await request.json()
    const fields = pick(body, ALLOWED_FIELDS)

    // Check if record exists
    const { data: existing } = await supabase
      .from('wedding_details')
      .select('id')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .maybeSingle()

    if (existing) {
      // Update
      const { data, error } = await supabase
        .from('wedding_details')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .select()
        .single()

      if (error) throw error

      logActivity({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        userId: auth.userId,
        activityType: 'wedding_details_updated',
        entityType: 'wedding_details',
        entityId: data?.id,
        details: { updatedFields: Object.keys(fields) },
      })

      return NextResponse.json({ data })
    } else {
      // Insert
      const { data, error } = await supabase
        .from('wedding_details')
        .insert({
          venue_id: auth.venueId,
          wedding_id: auth.weddingId,
          ...fields,
        })
        .select()
        .single()

      if (error) throw error

      logActivity({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        userId: auth.userId,
        activityType: 'wedding_details_created',
        entityType: 'wedding_details',
        entityId: data?.id,
        details: { fields: Object.keys(fields) },
      })
      createNotification({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        type: 'client_activity',
        title: 'Wedding details updated',
        body: 'A couple updated their wedding details.',
      })

      return NextResponse.json({ data }, { status: 201 })
    }
  } catch (error) {
    return serverError(error)
  }
}
