import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

// GET: fetch vendor info by token (public, no auth)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: vendor, error } = await supabase
    .from('booked_vendors')
    .select('id, vendor_type, vendor_name, contact_name, contact_email, contact_phone, website, instagram, arrival_time, departure_time, notes, portal_token, wedding_id')
    .eq('portal_token', token)
    .single()

  if (error || !vendor) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Get couple names + date for display
  const { data: wedding } = await supabase
    .from('weddings')
    .select('wedding_date')
    .eq('id', vendor.wedding_id)
    .single()

  const { data: people } = await supabase
    .from('wedding_people')
    .select('first_name, last_name')
    .eq('wedding_id', vendor.wedding_id)
    .limit(2)

  const coupleNames = people?.map(p => p.first_name).join(' & ') || null

  return NextResponse.json({
    ...vendor,
    wedding_date: wedding?.wedding_date || null,
    couple_names: coupleNames,
  })
}

// PUT: vendor updates their own info (public, token is auth)
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const body = await req.json()
  const supabase = createServiceClient()

  // Verify token exists
  const { data: existing } = await supabase
    .from('booked_vendors')
    .select('id')
    .eq('portal_token', token)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { error } = await supabase
    .from('booked_vendors')
    .update({
      contact_name: body.contact_name || null,
      contact_email: body.contact_email || null,
      contact_phone: body.contact_phone || null,
      website: body.website || null,
      instagram: body.instagram || null,
      arrival_time: body.arrival_time || null,
      departure_time: body.departure_time || null,
      notes: body.notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
