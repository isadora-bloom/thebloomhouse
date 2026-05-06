import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { checkRateLimit } from '@/lib/rate-limit'
import { clientIpForRateLimit } from '@/lib/security/client-ip'

// ---------------------------------------------------------------------------
// Public wedding website API
// GET  ?slug=xxx                                   — full published website (public)
// GET  ?slug=xxx&t=token&action=search_guest&name=xxx — guest search (TOKEN-GATED)
// POST ?slug=xxx&t=token&action=rsvp               — RSVP submission (TOKEN-GATED)
//
// Two tiers:
//   - Public: slug-only website rendering. Couples share the URL openly.
//   - Token-gated: guest search + RSVP submit. Requires share_token (mig
//     218) carried in the couple's invitation link. Without the token,
//     guest enumeration via 2-char prefix match is closed.
//
// Per 2026-05-06 audit Lens 8.
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status })
}

function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

async function rateLimit(request: NextRequest, action: 'search_guest' | 'rsvp' | 'public_read') {
  const ip = clientIpForRateLimit(request)
  // Limits chosen to allow legitimate use without enabling mass scraping:
  //   public_read 600/hr — enough for a couple's friends/family to browse
  //   search_guest 60/hr — limits enumeration via name search
  //   rsvp 10/hr — well above what one guest needs
  const limits = { public_read: 600, search_guest: 60, rsvp: 10 } as const
  return checkRateLimit({
    key: `wedding-website:${action}:${ip}`,
    limit: limits[action],
    windowSec: 3600,
  })
}

function rateLimited(rl: { resetAt: Date }) {
  return NextResponse.json(
    { error: 'Rate limit exceeded' },
    {
      status: 429,
      headers: {
        'Retry-After': String(
          Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000),
        ),
      },
    },
  )
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

/**
 * Token-gated lookup. Returns the website row only if (slug, share_token)
 * BOTH match. Used by guest search + RSVP submit. Wrong token = same 404
 * response as missing slug; no information leak about which is wrong.
 */
async function getPublishedWebsiteWithToken(
  supabase: ReturnType<typeof createServiceClient>,
  slug: string,
  token: string,
) {
  const { data, error } = await supabase
    .from('wedding_website_settings')
    .select('*')
    .eq('slug', slug)
    .eq('share_token', token)
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
    const token = searchParams.get('t')

    if (!slug) return err('slug is required')

    const supabase = createServiceClient()

    // ---- Guest search (TOKEN-GATED) ----
    if (action === 'search_guest') {
      const rl = await rateLimit(request, 'search_guest')
      if (!rl.ok) return rateLimited(rl)

      if (!token) {
        // No token = no enumeration. 404 not 401 so an attacker can't
        // distinguish a missing-token from a wrong-token.
        return err('Wedding website not found or not published', 404)
      }
      const website = await getPublishedWebsiteWithToken(supabase, slug, token)
      if (!website) return err('Wedding website not found or not published', 404)

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
          first_name,
          last_name,
          group_name,
          rsvp_status,
          plus_one,
          has_plus_one,
          person:people(id, first_name, last_name)
        `)
        .eq('wedding_id', website.wedding_id)

      if (guestErr) throw guestErr

      // Filter by name match (case-insensitive partial)
      // Check both guest_list.first_name/last_name AND people.first_name/last_name
      const matches = (guests ?? []).filter((g) => {
        // Check direct columns on guest_list first
        const directName = `${g.first_name ?? ''} ${g.last_name ?? ''}`.trim().toLowerCase()
        if (directName.length > 0 && directName.includes(term)) return true

        // Fall back to joined people table
        const person = g.person as unknown as { first_name?: string; last_name?: string } | null
        if (!person) return false
        const fullName = `${person.first_name ?? ''} ${person.last_name ?? ''}`.toLowerCase()
        return fullName.includes(term)
      }).map((g) => {
        const person = g.person as unknown as { id: string; first_name: string; last_name: string } | null
        // Prefer direct columns, fallback to person
        const firstName = g.first_name || person?.first_name || ''
        const lastName = g.last_name || person?.last_name || ''
        return {
          guest_id: g.id,
          name: `${firstName} ${lastName}`.trim(),
          group_name: g.group_name,
          rsvp_status: g.rsvp_status,
          plus_one: g.has_plus_one || g.plus_one,
        }
      })

      return json({ guests: matches })
    }

    // ---- Full website data (PUBLIC, slug-only) ----
    // Slugs are user-chosen and predictable; rate-limit scrape patterns
    // even though the response itself is meant to be public. Per round-2
    // audit follow-up #37.
    const rlPublic = await rateLimit(request, 'public_read')
    if (!rlPublic.ok) return rateLimited(rlPublic)

    const website = await getPublishedWebsite(supabase, slug)
    if (!website) return err('Wedding website not found or not published', 404)
    const weddingId = website.wedding_id
    const venueId = website.venue_id

    // Fetch related data in parallel
    const [
      { data: mealOptions },
      { data: timeline },
      { data: accommodations },
      { data: wedding },
      { data: rsvpConfig },
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
        .select('id, wedding_date, guest_count')
        .eq('id', weddingId)
        .single(),
      supabase
        .from('rsvp_config')
        .select('*')
        .eq('venue_id', venueId)
        .eq('wedding_id', weddingId)
        .maybeSingle(),
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
      event_date: wedding?.wedding_date ?? null,
      rsvp_config: rsvpConfig
        ? {
            ask_meal_choice: rsvpConfig.ask_meal_choice ?? true,
            ask_dietary: rsvpConfig.ask_dietary ?? true,
            ask_allergies: rsvpConfig.ask_allergies ?? false,
            ask_phone: rsvpConfig.ask_phone ?? false,
            ask_email: rsvpConfig.ask_email ?? false,
            ask_address: rsvpConfig.ask_address ?? false,
            ask_hotel: rsvpConfig.ask_hotel ?? false,
            ask_shuttle: rsvpConfig.ask_shuttle ?? false,
            ask_accessibility: rsvpConfig.ask_accessibility ?? false,
            ask_song_request: rsvpConfig.ask_song_request ?? false,
            ask_message: rsvpConfig.ask_message ?? false,
            allow_maybe: rsvpConfig.allow_maybe ?? false,
            custom_questions: rsvpConfig.custom_questions ?? [],
            rsvp_deadline: rsvpConfig.rsvp_deadline ?? null,
            attending_message: rsvpConfig.attending_message ?? null,
            declined_message: rsvpConfig.declined_message ?? null,
          }
        : null,
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
  const rl = await rateLimit(request, 'rsvp')
  if (!rl.ok) return rateLimited(rl)

  try {
    const { searchParams } = new URL(request.url)
    const slug = searchParams.get('slug')
    const action = searchParams.get('action')
    const token = searchParams.get('t')

    if (!slug) return err('slug is required')
    if (action !== 'rsvp') return err('Invalid action. Use action=rsvp')
    if (!token) {
      // RSVP submit without a share-token is closed entirely. Pre-fix
      // any caller could submit a fake RSVP for any guest_id by
      // enumerating UUIDs (or by walking a leaked guest list).
      return err('Wedding website not found or not published', 404)
    }

    const supabase = createServiceClient()
    const website = await getPublishedWebsiteWithToken(supabase, slug, token)
    if (!website) return err('Wedding website not found or not published', 404)

    const body = await request.json()
    const {
      guest_id,
      rsvp_status,
      meal_choice,
      meal_preference, // legacy compat
      dietary_restrictions,
      plus_one_rsvp,
      plus_one_name,
      plus_one_meal,
      // Extended fields from rsvp_config
      phone,
      email,
      address,
      hotel_name,
      shuttle_needed,
      accessibility_needs,
      song_request,
      message_to_couple,
      allergies,
      custom_answers,
    } = body

    if (!guest_id) return err('guest_id is required')
    if (!rsvp_status || !['attending', 'declined', 'maybe'].includes(rsvp_status)) {
      return err('rsvp_status must be attending, declined, or maybe')
    }

    // Verify this guest belongs to this wedding
    const { data: guest, error: guestErr } = await supabase
      .from('guest_list')
      .select('id, wedding_id, plus_one, has_plus_one')
      .eq('id', guest_id)
      .eq('wedding_id', website.wedding_id)
      .single()

    if (guestErr || !guest) {
      return err('Guest not found for this wedding', 404)
    }

    const hasPlusOne = guest.has_plus_one || guest.plus_one

    // Build update payload for guest_list
    const updatePayload: Record<string, unknown> = {
      rsvp_status,
      rsvp_responded_at: new Date().toISOString(),
    }

    const mealVal = meal_choice || meal_preference
    if (mealVal !== undefined) {
      updatePayload.meal_choice = mealVal
      updatePayload.meal_preference = mealVal // keep both in sync
    }

    if (dietary_restrictions !== undefined) {
      updatePayload.dietary_restrictions = dietary_restrictions
    }

    if (hasPlusOne) {
      if (plus_one_rsvp !== undefined) {
        updatePayload.plus_one_rsvp = plus_one_rsvp
      }
      if (plus_one_name !== undefined) {
        updatePayload.plus_one_name = plus_one_name
      }
      if (plus_one_meal !== undefined) {
        updatePayload.plus_one_meal_choice = plus_one_meal
      }
    }

    // Handle shuttle and accessibility flags on guest_list
    if (shuttle_needed !== undefined) {
      updatePayload.needs_shuttle = !!shuttle_needed
    }
    if (accessibility_needs !== undefined && accessibility_needs.trim()) {
      updatePayload.needs_accessibility = true
      updatePayload.accessibility_notes = accessibility_needs
    }

    const { error: updateErr } = await supabase
      .from('guest_list')
      .update(updatePayload)
      .eq('id', guest_id)

    if (updateErr) throw updateErr

    // Insert into rsvp_responses if any extended fields are present
    const hasExtendedFields =
      phone || email || address || hotel_name ||
      shuttle_needed !== undefined || accessibility_needs ||
      song_request || message_to_couple || allergies ||
      (custom_answers && Object.keys(custom_answers).length > 0)

    if (hasExtendedFields) {
      // Upsert: delete any previous response for this guest, then insert fresh
      await supabase
        .from('rsvp_responses')
        .delete()
        .eq('guest_id', guest_id)

      await supabase
        .from('rsvp_responses')
        .insert({
          venue_id: website.venue_id,
          wedding_id: website.wedding_id,
          guest_id,
          phone: phone || null,
          email: email || null,
          address: address || null,
          hotel_name: hotel_name || null,
          shuttle_needed: shuttle_needed ?? null,
          accessibility_needs: accessibility_needs || null,
          song_request: song_request || null,
          message_to_couple: message_to_couple || null,
          allergies: allergies || null,
          custom_answers: custom_answers || {},
          responded_at: new Date().toISOString(),
        })
    }

    // Auto-insert into allergy_registry if allergies reported
    if (allergies && allergies.trim()) {
      // Remove previous entries for this guest to avoid duplicates
      await supabase
        .from('allergy_registry')
        .delete()
        .eq('guest_id', guest_id)

      await supabase
        .from('allergy_registry')
        .insert({
          venue_id: website.venue_id,
          wedding_id: website.wedding_id,
          guest_name: body.guest_name || 'Guest',
          allergy_type: allergies.trim(),
          severity: 'moderate',
          notes: 'Reported via RSVP form',
          is_important: true,
          guest_id,
        })
    }

    return json({ success: true, message: 'RSVP submitted successfully' })
  } catch (error) {
    console.error('[public/wedding-website] POST error:', error)
    return err('Internal server error', 500)
  }
}
