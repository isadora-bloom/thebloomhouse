/**
 * /api/team/invite — mint and send a team invitation.
 *
 * 2026-09-14 security remediation (S1, item 1). What this route was:
 *
 *   - No authentication of any kind. Anyone who could reach the URL could
 *     POST an email, a role and an org id and have the platform send a
 *     branded invitation on that organisation's behalf.
 *   - orgId came from the request body, so the org being invited into was
 *     whatever the caller typed.
 *   - The response carried the raw invitation token, so the caller did not
 *     even need to receive the email to use the link.
 *   - The token was stored in plaintext in team_invitations.token.
 *   - GET listed every pending invitation for any orgId passed in the
 *     query string, emails included.
 *
 * Now: platform auth, org_admin or super_admin only, orgId derived from
 * the session, no role above the caller's own, no token in the response,
 * a sha256 alongside the plaintext column, and a rate limit on both verbs.
 *
 * Token storage: S3's migration 411 adds team_invitations.token_hash. We
 * write BOTH columns until that lands and the backfill runs — the hash so
 * the new read path works, the plaintext so an un-migrated deployment and
 * the accept route's fallback keep working. When 411 is applied
 * everywhere, drop the plaintext write here and the fallback in
 * team/accept, and make token nullable.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/services/email/transport'
import { appUrl } from '@/lib/app-url'
import { randomUUID, createHash } from 'crypto'
import { escapeHtml } from '@/lib/utils/escape-html'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  refuseDemo,
  requireRole,
  ADMIN_ROLES,
  roleRank,
  findAuthUserByEmail,
} from '@/lib/api/auth-helpers'
import { checkRateLimit, secondsUntil } from '@/lib/rate-limit'
import { clientIpForRateLimit } from '@/lib/security/client-ip'
import { apiError } from '@/lib/api/api-error'

/** sha256 of the invitation token, hex. Matches migration 411's column. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Postgres/PostgREST's way of saying "that column isn't there yet". */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return (
    error.code === 'PGRST204' ||
    error.code === '42703' ||
    /token_hash/.test(error.message ?? '')
  )
}

async function limit(request: NextRequest, orgId: string, verb: string) {
  for (const [key, max] of [
    [`team-invite:${verb}:${orgId}`, 30],
    [`team-invite-ip:${verb}:${clientIpForRateLimit(request)}`, 60],
  ] as const) {
    const rl = await checkRateLimit({ key, limit: max, windowSec: 3600 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many invitation requests. Try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) } },
      )
    }
  }
  return null
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    // The demo identity is an anonymous visitor. It may look; it may not
    // send invitations on a real organisation's behalf.
    const demoRefusal = refuseDemo(auth)
    if (demoRefusal) return demoRefusal

    const roleRefusal = requireRole(auth, ADMIN_ROLES)
    if (roleRefusal) return roleRefusal

    // The org is the caller's own, never the body's. This is the whole
    // fix: an invitation can only ever reach into the org the session
    // already belongs to.
    const orgId = auth.orgId
    if (!orgId) return forbidden('no organisation in scope')

    const limited = await limit(request, orgId, 'post')
    if (limited) return limited

    const { email, role, venueId } = await request.json()

    if (!email || !role) {
      return NextResponse.json(
        { error: 'Email and role are required.' },
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

    // No inviting somebody more senior than yourself. An org_admin can
    // mint another org_admin; nobody below super_admin can mint one.
    if (roleRank(role) > roleRank(auth.role)) {
      return forbidden('cannot invite a role above your own')
    }

    const supabase = createServiceClient()

    // A venue-scoped invitation must name a venue inside the caller's
    // org, not any uuid the client felt like sending.
    if (venueId) {
      const { data: targetVenue } = await supabase
        .from('venues')
        .select('org_id')
        .eq('id', venueId)
        .maybeSingle()
      if (!targetVenue || targetVenue.org_id !== orgId) {
        return forbidden('venue is not in your organisation')
      }
    }

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

    // Check if user already has a profile in this org. Paged lookup —
    // a bare listUsers() only sees the first 50 accounts.
    const existingUser = await findAuthUserByEmail(supabase, email)

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

    // The inviter is the authenticated session, full stop. The old
    // Authorization-header sniff was decorative: it fell through to null
    // whenever the header was absent, which was always.
    const invitedBy: string = auth.userId

    // Create the invitation. token_hash is what the accept path reads;
    // token stays until migration 411 is applied everywhere (see header).
    const row = {
      org_id: orgId,
      venue_id: venueId || null,
      email: email.toLowerCase(),
      role,
      invited_by: invitedBy,
      token,
      token_hash: hashInviteToken(token),
      status: 'pending',
      expires_at: expiresAt,
    }

    let { data: invitation, error: insertError } = await supabase
      .from('team_invitations')
      .insert(row)
      .select('id')
      .single()

    if (insertError && isMissingColumn(insertError)) {
      // Migration 411 not applied on this deployment yet. Fall back to
      // the plaintext column so invitations keep working; the accept
      // path reads both.
      console.warn('[team-invite] token_hash column absent — writing plaintext only (migration 411 pending)')
      const { token_hash: _dropped, ...legacyRow } = row
      ;({ data: invitation, error: insertError } = await supabase
        .from('team_invitations')
        .insert(legacyRow)
        .select('id')
        .single())
    }

    if (insertError || !invitation) {
      console.error('Failed to create invitation:', insertError)
      return NextResponse.json(
        { error: 'Failed to create invitation.' },
        { status: 500 }
      )
    }

    // Build the invite link
    const inviteLink = appUrl(`/join?token=${token}`)

    // Resolve org name + inviter name for the email template
    const { data: org } = await supabase
      .from('organisations')
      .select('name')
      .eq('id', orgId)
      .maybeSingle()

    const orgName = (org?.name as string) ?? 'The Bloom House'

    // 2026-05-11: pre-existing schema mismatch fixed. user_profiles
    // (001_shared_tables): id, venue_id, org_id, role, first_name,
    // last_name, avatar_url, plan_tier. No `full_name`, no `email`
    // column — email lives on auth.users, the name is first+last. The
    // previous query selected columns that don't exist and always fell
    // through to "Your teammate" in the invite email.
    let inviterName = 'Your teammate'
    {
      const { data: inviterProfile } = await supabase
        .from('user_profiles')
        .select('first_name, last_name')
        .eq('id', invitedBy)
        .maybeSingle()
      const first = (inviterProfile?.first_name as string | null)?.trim() ?? ''
      const last = (inviterProfile?.last_name as string | null)?.trim() ?? ''
      const combined = [first, last].filter(Boolean).join(' ')
      if (combined) {
        inviterName = combined
      } else {
        // Last-resort: pull the email from auth.users via the admin API.
        // Non-fatal if it fails — we still ship the invite with a
        // friendly default.
        try {
          const { data: authUser } = await supabase.auth.admin.getUserById(invitedBy)
          const email = authUser?.user?.email
          if (email) inviterName = email
        } catch {
          /* fall through to 'Your teammate' */
        }
      }
    }

    const roleLabelMap: Record<string, string> = {
      org_admin: 'organisation admin',
      venue_manager: 'venue manager',
      coordinator: 'coordinator',
      readonly: 'read-only member',
    }
    const roleLabel = roleLabelMap[role] ?? role

    // S5 (2026-09-14 security audit, item 10). orgName, inviterName and
    // roleLabel all reach this builder as free text — an org name typed
    // in settings, a first/last name off user_profiles, or in the
    // last-resort branch an email address read back from auth.users. They
    // went into the markup raw. escapeHtml is the same helper the
    // contract templates use. The invite link is escaped too: it carries
    // a token and ends up inside both an href and the visible text.
    //
    // Auth on this route is S1's; this change touches only the builder.
    const safeOrgName = escapeHtml(orgName)
    const safeInviterName = escapeHtml(inviterName)
    const safeRoleLabel = escapeHtml(roleLabel)
    const safeInviteLink = escapeHtml(inviteLink)

    // The subject is a plain-text header, not markup — escaping it would
    // put a literal &amp; in front of the recipient.
    const subject = `You've been invited to ${orgName} on The Bloom House`
    const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FDFAF6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#2D2D2D;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="background:#7D8471;padding:28px;">
        <h1 style="margin:0;font-size:22px;font-weight:600;color:#FFFFFF;font-family:Georgia,serif;">
          ${safeOrgName}
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
          <strong>${safeInviterName}</strong> has invited you to join <strong>${safeOrgName}</strong> on The Bloom House.
        </p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
          You've been invited as a <strong>${safeRoleLabel}</strong>.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${safeInviteLink}" style="display:inline-block;padding:12px 24px;background:#7D8471;color:#FFFFFF;text-decoration:none;border-radius:8px;font-weight:600;">
            Accept invitation
          </a>
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#6B7280;">
          Or visit <a href="${safeInviteLink}" style="color:#7D8471;">${safeInviteLink}</a>
        </p>
        <p style="margin:0;font-size:13px;color:#6B7280;">
          This invitation expires in 7 days.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 28px;border-top:1px solid #F3F4F6;">
        <p style="margin:0;font-size:12px;color:#6B7280;text-align:center;">
          ${safeOrgName} &middot; Powered by The Bloom House
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`

    // venueId: null (W55) — this email is Bloom-platform branded throughout
    // ("Powered by The Bloom House" footer, orgName in the header, no
    // venue colours/logo), independent of which venue field the row above
    // happens to carry. Resolving a venue's own sending domain here would
    // put "Rixey Manor <hello@rixeymanor.com>" on an email that still says
    // "The Bloom House" inside it — the platform default is correct.
    const emailResult = await sendEmail({
      to: email,
      subject,
      html: htmlBody,
      venueId: null,
    })

    if (!emailResult.ok) {
      console.error('[team-invite] Failed to send invitation email:', emailResult.error)
    } else {
      console.log(
        `[team-invite] Sent invitation to ${email} for role ${role} (id: ${emailResult.id ?? 'n/a'})`
      )
    }

    // No token, and no inviteLink either — both are the credential. The
    // invitation travels by email and only by email. A caller who needs
    // to resend gets a fresh invitation, not a copy of this one.
    return NextResponse.json({
      success: true,
      invitationId: invitation.id,
      emailSent: emailResult.ok,
      emailError: emailResult.ok ? undefined : emailResult.error,
    })
  } catch (err) {
    return apiError(err)
  }
}

// GET: List invitations for an org
export async function GET(request: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const roleRefusal = requireRole(auth, ADMIN_ROLES)
    if (roleRefusal) return roleRefusal

    // Same rule as POST: the org is the session's, not the query string's.
    // Listing by an arbitrary orgId handed out every pending invitee's
    // email address to anybody who could guess an org uuid.
    const orgId = auth.orgId
    if (!orgId) return forbidden('no organisation in scope')

    const limited = await limit(request, orgId, 'get')
    if (limited) return limited

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('team_invitations')
      .select('id, email, role, venue_id, status, expires_at, created_at, venues(name)')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })

    if (error) {
      return apiError(error)
    }

    return NextResponse.json({ invitations: data ?? [] })
  } catch (err) {
    return apiError(err)
  }
}
