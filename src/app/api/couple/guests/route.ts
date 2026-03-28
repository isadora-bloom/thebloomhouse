import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/couple/guests
// Tables: guest_list, guest_tags, guest_tag_assignments, guest_meal_options, people
// ---------------------------------------------------------------------------

const GUEST_FIELDS = [
  'person_id', 'group_name', 'rsvp_status', 'meal_preference',
  'dietary_restrictions', 'plus_one', 'plus_one_name',
  'table_assignment_id', 'care_notes', 'meal_option_id', 'address',
] as const

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)
    const resource = searchParams.get('resource')

    // Sub-resource: tags
    if (resource === 'tags') {
      const { data, error } = await supabase
        .from('guest_tags')
        .select('*')
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .order('tag_name')

      if (error) throw error
      return NextResponse.json({ data })
    }

    // Sub-resource: meal_options
    if (resource === 'meal_options') {
      const { data, error } = await supabase
        .from('guest_meal_options')
        .select('*')
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .order('option_name')

      if (error) throw error
      return NextResponse.json({ data })
    }

    // Unread count shortcut
    if (searchParams.get('unread') === 'true') {
      // This param doesn't apply to guests — ignore or return 400
      return badRequest('unread param not supported on guests endpoint')
    }

    // Main guest list query
    const search = searchParams.get('search')
    const rsvp = searchParams.get('rsvp')
    const tagId = searchParams.get('tag')

    // If filtering by tag, get matching guest IDs first
    let tagGuestIds: string[] | null = null
    if (tagId) {
      const { data: assignments, error: tagErr } = await supabase
        .from('guest_tag_assignments')
        .select('guest_id')
        .eq('tag_id', tagId)

      if (tagErr) throw tagErr
      tagGuestIds = (assignments ?? []).map((a) => a.guest_id)
      if (tagGuestIds.length === 0) {
        return NextResponse.json({
          data: [],
          summary: { total: 0, attending: 0, declined: 0, pending: 0, maybe: 0 },
        })
      }
    }

    // Build guest query with joins
    let query = supabase
      .from('guest_list')
      .select(`
        *,
        person:people(id, first_name, last_name, email, phone),
        meal_option:guest_meal_options(id, option_name),
        tags:guest_tag_assignments(id, tag:guest_tags(id, tag_name, color))
      `)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)

    if (rsvp) {
      query = query.eq('rsvp_status', rsvp)
    }

    if (tagGuestIds) {
      query = query.in('id', tagGuestIds)
    }

    if (search) {
      // Search by person name — we'll filter client-side after join
      // Supabase doesn't support cross-table ilike in a single filter,
      // so we pull all and filter. For large lists this would use an RPC.
    }

    query = query.order('created_at', { ascending: true }).limit(1000)

    const { data: guests, error } = await query
    if (error) throw error

    let filtered = guests ?? []

    // Client-side name search filter
    if (search) {
      const term = search.toLowerCase()
      filtered = filtered.filter((g) => {
        const person = g.person as { first_name?: string; last_name?: string; email?: string } | null
        const fullName = person
          ? `${person.first_name ?? ''} ${person.last_name ?? ''}`.toLowerCase()
          : ''
        const email = person?.email?.toLowerCase() ?? ''
        const group = g.group_name?.toLowerCase() ?? ''
        return fullName.includes(term) || email.includes(term) || group.includes(term)
      })
    }

    // Build summary from unfiltered wedding totals
    const { data: allGuests, error: summaryErr } = await supabase
      .from('guest_list')
      .select('rsvp_status')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)

    if (summaryErr) throw summaryErr

    const summary = {
      total: (allGuests ?? []).length,
      attending: (allGuests ?? []).filter((g) => g.rsvp_status === 'attending').length,
      declined: (allGuests ?? []).filter((g) => g.rsvp_status === 'declined').length,
      pending: (allGuests ?? []).filter((g) => g.rsvp_status === 'pending').length,
      maybe: (allGuests ?? []).filter((g) => g.rsvp_status === 'maybe').length,
    }

    return NextResponse.json({ data: filtered, summary })
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

    // Sub-resource: tags
    if (resource === 'tags') {
      const { tag_name, color } = body
      if (!tag_name) return badRequest('tag_name is required')

      const { data, error } = await supabase
        .from('guest_tags')
        .insert({
          venue_id: auth.venueId,
          wedding_id: auth.weddingId,
          tag_name,
          color: color ?? null,
        })
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data }, { status: 201 })
    }

    // Sub-resource: meal_options
    if (resource === 'meal_options') {
      const { option_name, description, is_default } = body
      if (!option_name) return badRequest('option_name is required')

      const { data, error } = await supabase
        .from('guest_meal_options')
        .insert({
          venue_id: auth.venueId,
          wedding_id: auth.weddingId,
          option_name,
          description: description ?? null,
          is_default: is_default ?? false,
        })
        .select()
        .single()

      if (error) throw error
      return NextResponse.json({ data }, { status: 201 })
    }

    // Sub-resource: bulk_import
    if (resource === 'bulk_import') {
      const { guests } = body as {
        guests: Array<{ name: string; email?: string; rsvp_status?: string; group_name?: string }>
      }
      if (!Array.isArray(guests) || guests.length === 0) {
        return badRequest('guests array is required and cannot be empty')
      }

      const createdGuests = []

      for (const guest of guests) {
        if (!guest.name) continue

        // Split name into first/last
        const parts = guest.name.trim().split(/\s+/)
        const firstName = parts[0] ?? ''
        const lastName = parts.length > 1 ? parts.slice(1).join(' ') : ''

        // Create person record
        const { data: person, error: personErr } = await supabase
          .from('people')
          .insert({
            venue_id: auth.venueId,
            wedding_id: auth.weddingId,
            role: 'guest',
            first_name: firstName,
            last_name: lastName,
            email: guest.email ?? null,
          })
          .select()
          .single()

        if (personErr) throw personErr

        // Create guest_list record
        const { data: guestRecord, error: guestErr } = await supabase
          .from('guest_list')
          .insert({
            venue_id: auth.venueId,
            wedding_id: auth.weddingId,
            person_id: person.id,
            rsvp_status: guest.rsvp_status ?? 'pending',
            group_name: guest.group_name ?? null,
          })
          .select()
          .single()

        if (guestErr) throw guestErr
        createdGuests.push(guestRecord)
      }

      return NextResponse.json({ data: createdGuests, count: createdGuests.length }, { status: 201 })
    }

    // Default: create single guest
    const record: Record<string, unknown> = {
      venue_id: auth.venueId,
      wedding_id: auth.weddingId,
    }
    for (const field of GUEST_FIELDS) {
      if (body[field] !== undefined) {
        record[field] = body[field]
      }
    }

    const { data, error } = await supabase
      .from('guest_list')
      .insert(record)
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
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { id } = body
    if (!id) return badRequest('id is required')

    const supabase = createServiceClient()

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const field of GUEST_FIELDS) {
      if (body[field] !== undefined) {
        updates[field] = body[field]
      }
    }

    const { data, error } = await supabase
      .from('guest_list')
      .update(updates)
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
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
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return badRequest('id query parameter is required')

    const supabase = createServiceClient()

    const { error } = await supabase
      .from('guest_list')
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
