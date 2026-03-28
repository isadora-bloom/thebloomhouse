import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Public wedding website API — no auth required
// GET  ?slug=xxx           — full published website data
// GET  ?slug=xxx&action=search_guest&name=xxx — guest name search for RSVP
// POST ?slug=xxx&action=rsvp — public RSVP submission
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status })
}

function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getPublishedWebsite(supabase: ReturnType<typeof createServiceClient>, slug: string) {
  const { data, error } = await supabase
    .from('wedding_website_settings')
    .select('*')
    .eq('slug', slug)
    .eq('is_published', true)
    .maybeSingle()

  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const slug = searchParams.get('slug')
    const action = searchParams.get('action')

    if (!slug) return err('slug is required')

    const supabase = createServiceClient()
    const website = await getPublishedWebsite(supabase, slug)
    if (!website) return err('Wedding website not found or not published', 404)

    // ---- Guest search ----
    if (action === 'search_guest') {
      const name = searchParams.get('name')
      if (!name || name.trim().length < 2) {
        return err('name param required (min 2 chars)')
      }

      const term = name.trim().toLowerCase()

      // Get all guests for this wedding, joined with people
      const { data: guests, error: guestErr } = await supabase
        .from('guest_list')
        .select(`
          id,
          group_name,
          rsvp_status,
          plus_one,
          person:people(id, first_name, last_name)
        `)
        .eq('wedding_id', website.wedding_id)

      if (guestErr) throw guestErr

      // Filter by name match (case-insensitive partial)
      const matches = (guests ?? []).filter((g) => {
        const person = g.person as unknown as { first_name?: string; last_name?: string } | null
        if (!person) return false
        const fullName = `${person.first_name ?? ''} ${person.last_name ?? ''}`.toLowerCase()
        return fullName.includes(term)
      }).map((g) => {
        const person = g.person as unknown as { id: string; first_name: string; last_name: string }
        return {
          guest_id: g.id,
          name: `${person.first_name} ${person.last_name}`.trim(),
          group_name: g.group_name,
          rsvp_status: g.rsvp_status,
          plus_one: g.plus_one,
        }
      })

      return json({ guests: matches })
    }

    // ---- Full website data ----
    const weddingId = website.wedding_id
    const venueId = website.venue_id

    // Fetch related data in parallel
    const [
      { data: mealOptions },
      { data: timeline },
      { data: accommodations },
      { data: wedding },
    ] = await Promise.all([
      supabase
        .from('guest_meal_options')
        .select('id, option_name, description')
        .eq('wedding_id', weddingId)
        .eq('venue_id', venueId)
        .order('option_name'),
      supabase
        .from('timeline')
        .select('id, title, description, start_time, end_time, type, sort_order')
        .eq('wedding_id', weddingId)
        .order('sort_order'),
      supabase
        .from('accommodations')
        .select('id, name, description, address, phone, website_url, distance_miles, price_range, block_code, block_deadline, notes')
        .eq('venue_id', venueId)
        .order('name'),
      supabase
        .from('weddings')
        .select('id, event_date, guest_count')
        .eq('id', weddingId)
        .single(),
    ])

    return json({
      website: {
        slug: website.slug,
        theme: website.theme,
        accent_color: website.accent_color,
        couple_names: website.couple_names,
        sections_order: website.sections_order,
        sections_enabled: website.sections_enabled,
        our_story: website.our_story,
        dress_code: website.dress_code,
        registry_links: website.registry_links,
        faq: website.faq,
        things_to_do: website.things_to_do,
        sections: website.sections,
        partner1_name: website.partner1_name,
        partner2_name: website.partner2_name,
        wedding_date: website.wedding_date,
        venue_name: website.venue_name,
        venue_address: website.venue_address,
      },
      meal_options: mealOptions ?? [],
      timeline: timeline ?? [],
      accommodations: accommodations ?? [],
      event_date: wedding?.event_date ?? null,
    })
  } catch (error) {
    console.error('[public/wedding-website] GET error:', error)
    return err('Internal server error', 500)
  }
}

// ---------------------------------------------------------------------------
// POST — RSVP submission
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const slug = searchParams.get('slug')
    const action = searchParams.get('action')

    if (!slug) return err('slug is required')
    if (action !== 'rsvp') return err('Invalid action. Use action=rsvp')

    const supabase = createServiceClient()
    const website = await getPublishedWebsite(supabase, slug)
    if (!website) return err('Wedding website not found or not published', 404)

    const body = await request.json()
    const {
      guest_id,
      rsvp_status,
      meal_preference,
      dietary_restrictions,
      plus_one_rsvp,
      plus_one_name,
      plus_one_meal,
    } = body

    if (!guest_id) return err('guest_id is required')
    if (!rsvp_status || !['attending', 'declined', 'maybe'].includes(rsvp_status)) {
      return err('rsvp_status must be attending, declined, or maybe')
    }

    // Verify this guest belongs to this wedding
    const { data: guest, error: guestErr } = await supabase
      .from('guest_list')
      .select('id, wedding_id, plus_one')
      .eq('id', guest_id)
      .eq('wedding_id', website.wedding_id)
      .single()

    if (guestErr || !guest) {
      return err('Guest not found for this wedding', 404)
    }

    // Build update payload
    const updatePayload: Record<string, unknown> = {
      rsvp_status,
    }

    if (meal_preference !== undefined) {
      updatePayload.meal_preference = meal_preference
    }

    if (dietary_restrictions !== undefined) {
      updatePayload.dietary_restrictions = dietary_restrictions
    }

    if (guest.plus_one) {
      if (plus_one_rsvp !== undefined) {
        updatePayload.plus_one_rsvp = plus_one_rsvp
      }
      if (plus_one_name !== undefined) {
        updatePayload.plus_one_name = plus_one_name
      }
      if (plus_one_meal !== undefined) {
        updatePayload.plus_one_meal = plus_one_meal
      }
    }

    const { error: updateErr } = await supabase
      .from('guest_list')
      .update(updatePayload)
      .eq('id', guest_id)

    if (updateErr) throw updateErr

    return json({ success: true, message: 'RSVP submitted successfully' })
  } catch (error) {
    console.error('[public/wedding-website] POST error:', error)
    return err('Internal server error', 500)
  }
}
