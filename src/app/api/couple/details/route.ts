import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

const SELECT_FIELDS = [
  'wedding_date', 'guest_count_estimate',
  'status', 'ceremony_type', 'notes', 'package',
  'hold_expires_at', 'contracted_at',
].join(', ')

const SELECT_WITH_PEOPLE = `${SELECT_FIELDS}, people!people_wedding_id_fkey(role, first_name, last_name)`

const ALLOWED_UPDATE_FIELDS = [
  'wedding_date', 'guest_count_estimate',
  'ceremony_type', 'notes',
] as const

function buildCoupleNames(data: any): string | null {
  const people = data?.people ?? []
  const partners = people.filter((p: any) => p.role === 'partner1' || p.role === 'partner2')
  const names = partners.map((p: any) => [p.first_name, p.last_name].filter(Boolean).join(' ')).filter(Boolean)
  return names.length > 0 ? names.join(' & ') : null
}

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
      .select(SELECT_WITH_PEOPLE)
      .eq('id', auth.weddingId)
      .eq('venue_id', auth.venueId)
      .single()

    if (error) throw error
    const { people, ...rest } = data as any
    return NextResponse.json({ data: { ...rest, couple_names: buildCoupleNames(data) } })
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
      .select(SELECT_WITH_PEOPLE)
      .single()

    if (error) throw error
    const { people, ...rest } = data as any
    return NextResponse.json({ data: { ...rest, couple_names: buildCoupleNames(data) } })
  } catch (err) {
    return serverError(err)
  }
}
