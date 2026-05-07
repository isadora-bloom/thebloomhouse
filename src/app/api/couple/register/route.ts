import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * POST /api/couple/register
 *
 * Registers a couple account against a wedding's event_code.
 *
 * Tier-B #57 (Option B, 2026-05-07): supports up to TWO partner accounts
 * per wedding sharing a single event_code. The first registration is
 * the "primary" partner; the second registration creates a separate
 * auth user + user_profiles row pointing at the same wedding_id, with
 * its own login credentials. Each partner has their own auth identity
 * but sees the same wedding data via the couple_read RLS policies in
 * mig 226 (wedding_id is the only thing those policies care about, so
 * two user_profiles rows with the same wedding_id naturally co-tenant).
 *
 * Flow:
 * 1. Validate event code against weddings.event_code
 * 2. Verify venue slug matches the wedding's venue
 * 3. Reject if 2 couple accounts already exist for this wedding (cap)
 * 4. Reject if THIS email is already registered for this wedding
 *    (idempotency / prevent dup accounts for the same person)
 * 5. Create Supabase auth user (admin.createUser with email_confirm)
 * 6. Create user_profiles row with role='couple', wedding_id, venue_id
 * 7. Stamp wedding.couple_registered_at on FIRST registration only
 *    (preserves "first sign-up timestamp" semantics)
 * 8. Link auth user to a people record by email; if no email match,
 *    fill in the first partner row that has no email yet
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
    const venueData = wedding.venues as
      | { name?: string; slug?: string }
      | { name?: string; slug?: string }[]
      | null
    const venueSlug = Array.isArray(venueData) ? venueData[0]?.slug : venueData?.slug

    if (venueSlug !== slug) {
      return NextResponse.json(
        { error: 'Event code does not match this venue' },
        { status: 400 }
      )
    }

    // 3. Cap at 2 couple accounts per wedding.
    // Two partners is the supported case; we don't open it up further so
    // a leaked event_code can't onboard arbitrary readers. If a couple
    // ever needs more (say, a planner with their own login), the right
    // answer is a coordinator-side action, not a third partner.
    const { count: existingCount, error: countErr } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', wedding.id)
      .eq('role', 'couple')

    if (countErr) {
      console.error('[COUPLE REGISTER] Count error:', countErr)
      return NextResponse.json({ error: 'Failed to verify registration state' }, { status: 500 })
    }

    if ((existingCount ?? 0) >= 2) {
      return NextResponse.json(
        {
          error:
            'Both partner accounts are already registered for this wedding. ' +
            'If you need help, contact your venue.',
        },
        { status: 400 }
      )
    }

    // 4. Reject if THIS email already has a couple account for THIS wedding.
    // We resolve the auth user by email; if a row already exists, point
    // them to sign-in instead of creating a duplicate.
    const { data: dupAuth } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('wedding_id', wedding.id)
      .eq('role', 'couple')
      .limit(1)
    // Cross-reference auth.users since user_profiles.id IS the auth.uid().
    // Walk the user_profiles rows we have and check each auth user's email.
    if (dupAuth && dupAuth.length > 0) {
      for (const row of dupAuth) {
        const { data: authUser } = await supabase.auth.admin.getUserById(row.id as string)
        if (authUser?.user?.email?.toLowerCase() === email.toLowerCase()) {
          return NextResponse.json(
            {
              error: 'An account with this email already exists for this wedding. Sign in instead.',
            },
            { status: 400 }
          )
        }
      }
    }

    // 5. Create auth user
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

    // 6. Create user_profile.
    // Tier-A #2b (mig 226): wedding_id is what gates the couple_read /
    // couple_write RLS policies on every couple-portal-readable table.
    // Without it, the couple session resolves to "anon-but-authed" and
    // sees no rows. Both venue_id and wedding_id are stamped here so
    // the helper functions couple_user_wedding_id() / couple_user_venue_id()
    // resolve correctly.
    const { error: profileErr } = await supabase.from('user_profiles').insert({
      id: authData.user.id,
      venue_id: wedding.venue_id,
      wedding_id: wedding.id,
      role: 'couple',
    })

    if (profileErr) {
      console.error('[COUPLE REGISTER] Profile error:', profileErr)
      // Don't block — auth user was created, profile can be retried
    }

    // 7. Stamp couple_registered_at on FIRST registration only.
    // Preserves "when did the couple first start using the portal"
    // semantics for analytics / coordinator UX.
    if (!wedding.couple_registered_at) {
      await supabase
        .from('weddings')
        .update({ couple_registered_at: new Date().toISOString() })
        .eq('id', wedding.id)
    }

    // 8. Link the auth user to a people record.
    // Strategy:
    //   a) If a person row already has this email, that's the link.
    //   b) Else find the first partner row (partner1, then partner2)
    //      that has no email and stamp this email there. This handles
    //      both first and second registrations: first fills partner1,
    //      second fills partner2.
    const { data: existingPerson } = await supabase
      .from('people')
      .select('id')
      .eq('wedding_id', wedding.id)
      .eq('email', email)
      .maybeSingle()

    if (!existingPerson) {
      const { data: openPartner } = await supabase
        .from('people')
        .select('id, role, email')
        .eq('wedding_id', wedding.id)
        .in('role', ['partner1', 'partner2'])
        .or('email.is.null,email.eq.')
        .order('role', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (openPartner) {
        await supabase
          .from('people')
          .update({ email })
          .eq('id', openPartner.id)
      }
    }

    return NextResponse.json({
      success: true,
      weddingId: wedding.id,
      venueSlug,
      // Surface to the client whether this was the first or second
      // partner so the post-register screen can welcome them
      // appropriately ("Welcome — Sarah's already registered" etc.)
      partnerNumber: (existingCount ?? 0) === 0 ? 1 : 2,
    })
  } catch (err) {
    console.error('[COUPLE REGISTER ERROR]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
