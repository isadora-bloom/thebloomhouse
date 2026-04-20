import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/services/email'
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

    // Resolve org name + inviter name for the email template
    const { data: org } = await supabase
      .from('organisations')
      .select('name')
      .eq('id', orgId)
      .maybeSingle()

    const orgName = (org?.name as string) ?? 'The Bloom House'

    let inviterName = 'Your teammate'
    if (invitedBy) {
      const { data: inviterProfile } = await supabase
        .from('user_profiles')
        .select('full_name, email')
        .eq('id', invitedBy)
        .maybeSingle()
      inviterName =
        (inviterProfile?.full_name as string) ||
        (inviterProfile?.email as string) ||
        'Your teammate'
    }

    const roleLabelMap: Record<string, string> = {
      org_admin: 'organisation admin',
      venue_manager: 'venue manager',
      coordinator: 'coordinator',
      readonly: 'read-only member',
    }
    const roleLabel = roleLabelMap[role] ?? role

    const subject = `You've been invited to ${orgName} on The Bloom House`
    const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FDFAF6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#2D2D2D;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="background:#7D8471;padding:28px;">
        <h1 style="margin:0;font-size:22px;font-weight:600;color:#FFFFFF;font-family:Georgia,serif;">
          ${orgName}
        </h1>
        <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">
          Team invitation on The Bloom House
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:28px;">
        <h2 style="margin:0 0 12px;font-size:20px;">You're invited</h2>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">
          <strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on The Bloom House.
        </p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
          You've been invited as a <strong>${roleLabel}</strong>.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${inviteLink}" style="display:inline-block;padding:12px 24px;background:#7D8471;color:#FFFFFF;text-decoration:none;border-radius:8px;font-weight:600;">
            Accept invitation
          </a>
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#6B7280;">
          Or visit <a href="${inviteLink}" style="color:#7D8471;">${inviteLink}</a>
        </p>
        <p style="margin:0;font-size:13px;color:#6B7280;">
          This invitation expires in 7 days.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 28px;border-top:1px solid #F3F4F6;">
        <p style="margin:0;font-size:12px;color:#6B7280;text-align:center;">
          ${orgName} &middot; Powered by The Bloom House
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`

    const emailResult = await sendEmail({
      to: email,
      subject,
      html: htmlBody,
    })

    if (!emailResult.ok) {
      console.error('[team-invite] Failed to send invitation email:', emailResult.error)
    } else {
      console.log(
        `[team-invite] Sent invitation to ${email} for role ${role} (id: ${emailResult.id ?? 'n/a'})`
      )
    }

    return NextResponse.json({
      success: true,
      invitationId: invitation.id,
      inviteLink,
      token,
      emailSent: emailResult.ok,
      emailError: emailResult.ok ? undefined : emailResult.error,
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
