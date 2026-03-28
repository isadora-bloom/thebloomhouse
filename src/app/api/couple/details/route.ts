import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

const SELECT_FIELDS = [
  'couple_names', 'wedding_date', 'guest_count_estimate',
  'status', 'ceremony_type', 'notes', 'package',
  'hold_expires_at', 'contracted_at',
].join(', ')

const ALLOWED_UPDATE_FIELDS = [
  'couple_names', 'wedding_date', 'guest_count_estimate',
  'ceremony_type', 'notes',
] as const

function pick(body: Record<string, unknown>, fields: readonly string[]) {
  const result: Record<string, unknown> = {}
  for (const key of fields) {
    if (key in body) result[key] = body[key]
  }
  return result
}

// GET — return the couple's wedding record
export async function GET() {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('weddings')
      .select(SELECT_FIELDS)
      .eq('id', auth.weddingId)
      .eq('venue_id', auth.venueId)
      .single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (err) {
    return serverError(err)
  }
}

// PATCH — update wedding record (limited fields)
export async function PATCH(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const fields = pick(body, ALLOWED_UPDATE_FIELDS)
    if (Object.keys(fields).length === 0) return badRequest('No fields to update')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('weddings')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', auth.weddingId)
      .eq('venue_id', auth.venueId)
      .select(SELECT_FIELDS)
      .single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (err) {
    return serverError(err)
  }
}
