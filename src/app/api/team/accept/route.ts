/**
 * /api/team/accept — validate and redeem a team invitation.
 *
 * 2026-09-14 security remediation (S1, item 1). What this route was:
 *
 *   - POST looked the invitation up, found an auth user with the matching
 *     email, and bound that user's profile to the invitation's org, venue
 *     and role WITHOUT the user ever authenticating. Anyone holding a
 *     token could rewrite a real account's tenancy and role. Paired with
 *     the unauthenticated invite endpoint, that was a two-call takeover.
 *   - The existing-user lookup was a bare listUsers(), which reads the
 *     first page only, so past 50 accounts it silently took the
 *     create-a-new-user branch instead.
 *   - No rate limit on either verb, so the token space was brute-forceable.
 *
 * Now: tokens are looked up by sha256 (migration 411; plaintext fallback
 * while that rolls out), an existing account must be the signed-in caller
 * before anything is bound to it, the lookup pages, and both verbs are
 * rate limited on the token and on the caller's IP.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { findAuthUserByEmail } from '@/lib/api/auth-helpers'
import { checkRateLimit, secondsUntil } from '@/lib/rate-limit'
import { clientIpForRateLimit } from '@/lib/security/client-ip'
import { createHash } from 'crypto'
import { apiError } from '@/lib/api/api-error'

/** sha256 of the invitation token, hex. Matches migration 411's column. */
function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Two keys, neither shared: the token so hammering one invitation cannot
 * spend anybody else's budget, and the caller so somebody walking the uuid
 * space runs out of attempts long before they run out of guesses. The
 * token key is the hash — rate-limit keys land in logs and metrics
 * dimensions, and the token is a credential.
 */
async function guard(request: NextRequest, token: string, max: number) {
  for (const [key, limit] of [
    [`team-accept:${hashInviteToken(token)}`, max],
    [`team-accept-ip:${clientIpForRateLimit(request)}`, max * 2],
  ] as const) {
    const rl = await checkRateLimit({ key, limit, windowSec: 900 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many attempts. Give it a few minutes and try again.' },
        { status: 429, headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) } },
      )
    }
  }
  return null
}

/**
 * Look an invitation up by token. Reads by sha256 first; falls back to the
 * plaintext column so invitations minted before migration 411 (and rows on
 * a deployment where 411 has not run) still resolve. Delete the fallback
 * when 411 is applied everywhere and the backfill has run.
 */
async function findInvitation(
  supabase: ReturnType<typeof createServiceClient>,
  token: string,
  columns: string,
) {
  const hash = hashInviteToken(token)
  const byHash = await supabase
    .from('team_invitations')
    .select(columns)
    .eq('token_hash', hash)
    .maybeSingle()
  if (!byHash.error && byHash.data) return byHash.data

  const byToken = await supabase
    .from('team_invitations')
    .select(columns)
    .eq('token', token)
    .maybeSingle()
  if (byToken.error) return null
  return byToken.data
}

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

    const limited = await guard(request, token, 20)
    if (limited) return limited

    const supabase = createServiceClient()

    const invitation = (await findInvitation(
      supabase,
      token,
      'id, org_id, venue_id, email, role, status, expires_at, organisations(name), venues(name)',
    )) as {
      id: string
      org_id: string
      venue_id: string | null
      email: string
      role: string
      status: string
      expires_at: string
    } | null

    if (!invitation) {
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
    return apiError(err)
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

    const limited = await guard(request, token, 10)
    if (limited) return limited

    const supabase = createServiceClient()

    // 1. Fetch and validate the invitation
    const invitation = (await findInvitation(
      supabase,
      token,
      'id, org_id, venue_id, email, role, status, expires_at',
    )) as {
      id: string
      org_id: string
      venue_id: string | null
      email: string
      role: string
      status: string
      expires_at: string
    } | null

    if (!invitation) {
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

    // 2. Determine if user exists. Paged lookup — a bare listUsers() only
    // sees the first 50 accounts, so on a real directory this took the
    // create-a-new-user branch for people who already had an account.
    let userId: string | null = null
    const inviteEmail = (invitation.email as string).toLowerCase()
    const existingAuthUser = await findAuthUserByEmail(supabase, inviteEmail)

    if (existingAuthUser) {
      // The account already exists, so accepting means changing an
      // EXISTING person's org, venue and role. Holding the token is not
      // enough for that: the person themselves has to be signed in.
      // Without this check, anyone with a token could rewrite a real
      // account's tenancy and hand themselves whatever role the
      // invitation carried.
      const server = await createServerSupabaseClient()
      const {
        data: { user: sessionUser },
      } = await server.auth.getUser()

      if (!sessionUser || sessionUser.email?.toLowerCase() !== inviteEmail) {
        return NextResponse.json(
          {
            error: `This invitation is for ${inviteEmail}, and that account already exists. Sign in as ${inviteEmail} first, then open the invitation link again.`,
            signInRequired: true,
            email: inviteEmail,
          },
          { status: 401 }
        )
      }
      if (sessionUser.id !== existingAuthUser.id) {
        // Same address, different account id. Nothing good explains this;
        // refuse rather than guess which one the invitation meant.
        return NextResponse.json({ error: 'Invitation could not be verified.' }, { status: 409 })
      }

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
    return apiError(err)
  }
}
