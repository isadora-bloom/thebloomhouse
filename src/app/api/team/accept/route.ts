import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// ---------------------------------------------------------------------------
// GET: Validate an invitation token (public — used by the join page)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('token')

    if (!token) {
      return NextResponse.json({ error: 'Token is required.' }, { status: 400 })
    }

    const supabase = createServiceClient()

    const { data: invitation, error } = await supabase
      .from('team_invitations')
      .select('id, org_id, venue_id, email, role, status, expires_at, organisations(name), venues(name)')
      .eq('token', token)
      .maybeSingle()

    if (error || !invitation) {
      return NextResponse.json({ error: 'Invitation not found.' }, { status: 404 })
    }

    // Check status
    if (invitation.status !== 'pending') {
      return NextResponse.json(
        { error: `This invitation has already been ${invitation.status}.` },
        { status: 410 }
      )
    }

    // Check expiry
    if (new Date(invitation.expires_at as string) < new Date()) {
      // Mark as expired
      await supabase
        .from('team_invitations')
        .update({ status: 'expired' })
        .eq('id', invitation.id)

      return NextResponse.json(
        { error: 'This invitation has expired. Please ask your admin to send a new one.' },
        { status: 410 }
      )
    }

    return NextResponse.json({ invitation })
  } catch (err) {
    console.error('Validate invitation error:', err)
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST: Accept an invitation (creates user if needed, creates profile)
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { token, firstName, lastName, password } = body

    if (!token) {
      return NextResponse.json({ error: 'Token is required.' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // 1. Fetch and validate the invitation
    const { data: invitation, error: fetchError } = await supabase
      .from('team_invitations')
      .select('id, org_id, venue_id, email, role, status, expires_at')
      .eq('token', token)
      .maybeSingle()

    if (fetchError || !invitation) {
      return NextResponse.json({ error: 'Invitation not found.' }, { status: 404 })
    }

    if (invitation.status !== 'pending') {
      return NextResponse.json(
        { error: `This invitation has already been ${invitation.status}.` },
        { status: 410 }
      )
    }

    if (new Date(invitation.expires_at as string) < new Date()) {
      await supabase.from('team_invitations').update({ status: 'expired' }).eq('id', invitation.id)
      return NextResponse.json({ error: 'This invitation has expired.' }, { status: 410 })
    }

    // 2. Determine if user exists
    let userId: string | null = null

    // Check if there's an existing auth user with this email
    const { data: authUsers } = await supabase.auth.admin.listUsers()
    const existingAuthUser = authUsers?.users?.find(
      (u) => u.email?.toLowerCase() === (invitation.email as string).toLowerCase()
    )

    if (existingAuthUser) {
      userId = existingAuthUser.id
    } else {
      // New user — must have firstName, lastName, password
      if (!firstName || !lastName || !password) {
        return NextResponse.json(
          { error: 'First name, last name, and password are required for new accounts.' },
          { status: 400 }
        )
      }

      if (password.length < 8) {
        return NextResponse.json(
          { error: 'Password must be at least 8 characters.' },
          { status: 400 }
        )
      }

      // Create the auth user
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: invitation.email as string,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: `${firstName} ${lastName}`,
          role: invitation.role,
        },
      })

      if (createError) {
        return NextResponse.json({ error: createError.message }, { status: 400 })
      }

      userId = newUser.user.id
    }

    // 3. Check if user already has a profile in this org
    const { data: existingProfile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('id', userId!)
      .eq('org_id', invitation.org_id as string)
      .maybeSingle()

    if (existingProfile) {
      // User already in this org — just update role if needed and mark invitation accepted
      await supabase
        .from('user_profiles')
        .update({
          role: invitation.role,
          venue_id: invitation.venue_id || undefined,
        })
        .eq('id', userId!)
        .eq('org_id', invitation.org_id as string)
    } else {
      // Create user_profile
      const profileData: Record<string, unknown> = {
        id: userId!,
        org_id: invitation.org_id,
        venue_id: invitation.venue_id || null,
        role: invitation.role,
      }

      if (firstName && lastName) {
        profileData.first_name = firstName
        profileData.last_name = lastName
      } else if (existingAuthUser?.user_metadata?.full_name) {
        const parts = (existingAuthUser.user_metadata.full_name as string).split(' ')
        profileData.first_name = parts[0] || null
        profileData.last_name = parts.slice(1).join(' ') || null
      }

      const { error: profileError } = await supabase
        .from('user_profiles')
        .insert(profileData)

      if (profileError) {
        console.error('Failed to create user_profile:', profileError)
        return NextResponse.json({ error: 'Failed to create user profile.' }, { status: 500 })
      }
    }

    // 4. Mark invitation as accepted
    await supabase
      .from('team_invitations')
      .update({
        status: 'accepted',
        accepted_at: new Date().toISOString(),
      })
      .eq('id', invitation.id)

    return NextResponse.json({
      success: true,
      venueId: invitation.venue_id,
      orgId: invitation.org_id,
      role: invitation.role,
    })
  } catch (err) {
    console.error('Accept invitation error:', err)
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
