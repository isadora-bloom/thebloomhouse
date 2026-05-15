import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'
import { logActivity } from '@/lib/services/activity-logger'
import { createNotification } from '@/lib/services/admin-notifications'

// ---------------------------------------------------------------------------
// /api/couple/tables
// Table: wedding_tables (single row per wedding, upsert pattern)
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS = [
  'guest_count',
  'table_shape',
  'guests_per_table',
  'rect_table_count',
  'sweetheart_table',
  'head_table',
  'head_table_people',
  'head_table_sided',
  'kids_table',
  'kids_count',
  'cocktail_tables',
  'linen_color',
  'napkin_color',
  'linen_venue_choice',
  'runner_style',
  'chargers',
  'checkered_dance_floor',
  'lounge_area',
  'centerpiece_notes',
  'layout_notes',
  'linen_notes',
  'extra_tables',
  'is_draft',
] as const

const INTERNAL_KEYS = new Set([
  'id', 'venue_id', 'wedding_id', 'created_at', 'updated_at', 'extra_fields',
])

/**
 * Whitelisted fields + leftovers. Off-whitelist keys used to be
 * silently dropped; now they are returned as `extras` and stored in
 * wedding_tables.extra_fields (migration 353).
 */
function pickWithExtras(body: Record<string, unknown>, fields: readonly string[]) {
  const allowed = new Set(fields)
  const result: Record<string, unknown> = {}
  const extras: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(body)) {
    if (allowed.has(key)) result[key] = val
    else if (!INTERNAL_KEYS.has(key)) extras[key] = val
  }
  return {
    fields: result,
    extras: Object.keys(extras).length > 0 ? extras : null,
  }
}

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    void request

    const { data, error } = await supabase
      .from('wedding_tables')
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
    const { fields, extras } = pickWithExtras(body, ALLOWED_FIELDS)
    const extraPatch = extras ? { extra_fields: extras } : {}

    // Check if record exists
    const { data: existing } = await supabase
      .from('wedding_tables')
      .select('id')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .maybeSingle()

    if (existing) {
      // Update
      const { data, error } = await supabase
        .from('wedding_tables')
        .update({ ...fields, ...extraPatch, updated_at: new Date().toISOString() })
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
        activityType: 'wedding_tables_updated',
        entityType: 'wedding_tables',
        entityId: data?.id,
        details: { updatedFields: Object.keys(fields) },
      })

      return NextResponse.json({ data })
    } else {
      // Insert
      const { data, error } = await supabase
        .from('wedding_tables')
        .insert({
          venue_id: auth.venueId,
          wedding_id: auth.weddingId,
          ...fields,
          ...extraPatch,
        })
        .select()
        .single()

      if (error) throw error

      logActivity({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        userId: auth.userId,
        activityType: 'wedding_tables_created',
        entityType: 'wedding_tables',
        entityId: data?.id,
        details: { fields: Object.keys(fields) },
      })
      createNotification({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        type: 'client_activity',
        title: 'Table layout updated',
        body: 'A couple updated their table layout plan.',
      })

      return NextResponse.json({ data }, { status: 201 })
    }
  } catch (error) {
    return serverError(error)
  }
}
