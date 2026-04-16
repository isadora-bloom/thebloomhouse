import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { randomUUID } from 'crypto'

export async function POST(request: NextRequest) {
  try {
    const { email, role, venueId, orgId } = await request.json()

    if (!email || !role || !orgId) {
      return NextResponse.json(
        { error: 'Email, role, and orgId are required.' },
        { status: 400 }
      )
    }

    const validRoles = ['org_admin', 'venue_manager', 'coordinator', 'readonly']
    if (!validRoles.includes(role)) {
      return NextResponse.json(
        { error: `Invalid role. Must be one of: ${validRoles.join(', ')}` },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Check if there's already a pending invitation for this email + org
    const { data: existingInvite } = await supabase
      .from('team_invitations')
      .select('id, status')
      .eq('org_id', orgId)
      .eq('email', email.toLowerCase())
      .eq('status', 'pending')
      .maybeSingle()

    if (existingInvite) {
      return NextResponse.json(
        { error: 'An invitation is already pending for this email.' },
        { status: 409 }
      )
    }

    // Check if user already has a profile in this org
    // First find auth user by email
    const { data: authUsers } = await supabase.auth.admin.listUsers()
    const existingUser = authUsers?.users?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    )

    if (existingUser) {
      const { data: existingProfile } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('id', existingUser.id)
        .eq('org_id', orgId)
        .maybeSingle()

      if (existingProfile) {
        return NextResponse.json(
          { error: 'This user is already a member of this organisation.' },
          { status: 409 }
        )
      }
    }

    // Generate invitation token and expiry (7 days)
    const token = randomUUID()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    // Get the inviting user from the auth header
    const authHeader = request.headers.get('authorization')
    let invitedBy: string | null = null
    if (authHeader?.startsWith('Bearer ')) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.split(' ')[1])
      invitedBy = user?.id ?? null
    }
    // Fallback: try cookie-based auth
    if (!invitedBy) {
      // Use anon client to resolve from cookies — but in API routes we just accept null
      invitedBy = null
    }

    // Create the invitation
    const { data: invitation, error: insertError } = await supabase
      .from('team_invitations')
      .insert({
        org_id: orgId,
        venue_id: venueId || null,
        email: email.toLowerCase(),
        role,
        invited_by: invitedBy,
        token,
        status: 'pending',
        expires_at: expiresAt,
      })
      .select('id, token')
      .single()

    if (insertError) {
      console.error('Failed to create invitation:', insertError)
      return NextResponse.json(
        { error: 'Failed to create invitation.' },
        { status: 500 }
      )
    }

    // Build the invite link
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const inviteLink = `${baseUrl}/join?token=${token}`

    // Log the invitation (email sending is a future enhancement)
    console.log(`[team-invite] Invitation sent to ${email} for role ${role}`)
    console.log(`[team-invite] Link: ${inviteLink}`)

    return NextResponse.json({
      success: true,
      invitationId: invitation.id,
      inviteLink,
      token,
    })
  } catch (err) {
    console.error('Team invite error:', err)
    return NextResponse.json(
      { error: 'An unexpected error occurred.' },
      { status: 500 }
    )
  }
}

// GET: List invitations for an org
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const orgId = searchParams.get('orgId')

    if (!orgId) {
      return NextResponse.json({ error: 'orgId is required.' }, { status: 400 })
    }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('team_invitations')
      .select('id, email, role, venue_id, status, expires_at, created_at, venues(name)')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to fetch invitations:', error)
      return NextResponse.json({ error: 'Failed to fetch invitations.' }, { status: 500 })
    }

    return NextResponse.json({ invitations: data ?? [] })
  } catch (err) {
    console.error('List invitations error:', err)
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
