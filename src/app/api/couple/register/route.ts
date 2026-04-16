import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * POST /api/couple/register
 *
 * Registers a new couple account:
 * 1. Validates event code against weddings.event_code
 * 2. Verifies venue slug matches the wedding's venue
 * 3. Creates Supabase auth user (admin.createUser with email_confirm)
 * 4. Creates user_profiles row with role='couple'
 * 5. Updates wedding.couple_registered_at
 * 6. Links auth user to existing people record by email
 */
export async function POST(request: NextRequest) {
  try {
    const { email, password, eventCode, slug } = await request.json()

    if (!email || !password || !eventCode || !slug) {
      return NextResponse.json(
        { error: 'Missing required fields: email, password, eventCode, slug' },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // 1. Look up wedding by event code
    const { data: wedding, error: lookupErr } = await supabase
      .from('weddings')
      .select('id, venue_id, couple_registered_at, venues(name, slug)')
      .eq('event_code', eventCode)
      .maybeSingle()

    if (lookupErr) {
      console.error('[COUPLE REGISTER] Lookup error:', lookupErr)
      return NextResponse.json({ error: 'Failed to look up event code' }, { status: 500 })
    }

    if (!wedding) {
      return NextResponse.json({ error: 'Invalid event code' }, { status: 400 })
    }

    // 2. Verify slug matches
    const venueData = wedding.venues as { name?: string; slug?: string } | { name?: string; slug?: string }[] | null
    const venueSlug = Array.isArray(venueData) ? venueData[0]?.slug : venueData?.slug

    if (venueSlug !== slug) {
      return NextResponse.json(
        { error: 'Event code does not match this venue' },
        { status: 400 }
      )
    }

    // 3. Check if already registered
    if (wedding.couple_registered_at) {
      return NextResponse.json(
        { error: 'An account has already been registered for this wedding' },
        { status: 400 }
      )
    }

    // 4. Create auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: 'couple' },
    })

    if (authError) {
      console.error('[COUPLE REGISTER] Auth error:', authError)
      return NextResponse.json({ error: authError.message }, { status: 400 })
    }

    // 5. Create user_profile
    const { error: profileErr } = await supabase.from('user_profiles').insert({
      id: authData.user.id,
      venue_id: wedding.venue_id,
      role: 'couple',
    })

    if (profileErr) {
      console.error('[COUPLE REGISTER] Profile error:', profileErr)
      // Don't block — auth user was created, profile can be retried
    }

    // 6. Update wedding
    await supabase
      .from('weddings')
      .update({ couple_registered_at: new Date().toISOString() })
      .eq('id', wedding.id)

    // 7. Link the auth user to the people record.
    // First try to match by existing email. If no match, update the first
    // partner1 record to use the registering email so useCoupleContext can
    // resolve the wedding from the auth user's email.
    const { data: existingPerson } = await supabase
      .from('people')
      .select('id')
      .eq('wedding_id', wedding.id)
      .eq('email', email)
      .maybeSingle()

    if (!existingPerson) {
      // Update partner1's email to the registering email
      const { data: partner1 } = await supabase
        .from('people')
        .select('id')
        .eq('wedding_id', wedding.id)
        .eq('role', 'partner1')
        .maybeSingle()

      if (partner1) {
        await supabase
          .from('people')
          .update({ email })
          .eq('id', partner1.id)
      }
    }

    return NextResponse.json({
      success: true,
      weddingId: wedding.id,
      venueSlug,
    })
  } catch (err) {
    console.error('[COUPLE REGISTER ERROR]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
