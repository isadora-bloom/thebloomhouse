import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { checkRateLimit, secondsUntil } from '@/lib/rate-limit'
import {
  hashInviteToken,
  validateCoupleInvite,
  checkRegistrationEligibility,
  type CoupleInviteRow,
} from '@/lib/services/portal/provision'

/**
 * POST /api/couple/register
 *
 * Registers a couple account against a single-use invitation token.
 *
 * What changed on 2026-09-08 (W1). This endpoint used to accept a
 * weddings.event_code as its only credential: three letters and three
 * digits, globally unique, printed in the invite email, never expiring,
 * and with no rate limit in front of it. Nine hundred codes per venue
 * prefix is a weekend of guessing, and a hit gave a stranger a login to
 * a real couple's portal. The event code is now a human reference only.
 * The credential is a 128-bit token from couple_invites (migration 391),
 * of which the database holds only a sha256.
 *
 * Flow:
 * 1. Rate limit by client IP and by venue slug
 * 2. Look the invite up by sha256(token); it must be unused, unexpired,
 *    and addressed to the email being registered (case-insensitively)
 * 3. Verify the venue slug in the URL matches the invite's venue
 * 4. Wedding must be booked or completed
 * 5. Reject if 2 couple accounts already exist for this wedding (cap)
 * 6. Reject if THIS email is already registered for this wedding
 * 7. Claim the invite: set used_at, conditional on it still being null,
 *    so two concurrent redemptions cannot both win
 * 8. Create the Supabase auth user
 * 9. Create the user_profiles row. If that fails, delete the auth user
 *    and release the invite, then return 500. There is no half-success:
 *    RLS (mig 226 couple_user_wedding_id()) and the 2-account cap both
 *    read user_profiles, so an auth user without a profile is an account
 *    that can sign in and see nothing, and does not count towards the cap.
 * 10. Stamp wedding.couple_registered_at on FIRST registration only
 * 11. Link the auth user to an existing people row by email. We no longer
 *     stamp the registrant's email onto a blank partner row: the token
 *     already proves the address, and guessing which partner they are
 *     wrote a real email onto the wrong person often enough to matter.
 *
 * Tier-B #57 (Option B, 2026-05-07) still holds: up to TWO partner
 * accounts per wedding, each with its own auth identity and its own
 * user_profiles row pointing at the same wedding_id. The couple_read
 * policies in mig 226 only care about wedding_id, so the two co-tenant
 * naturally. Each partner now needs their own invite.
 */

/** Registration attempts allowed per client IP per hour. */
const IP_LIMIT = 10
/** Registration attempts allowed per venue per hour. */
const VENUE_LIMIT = 60
const RATE_WINDOW_SEC = 3600

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return request.headers.get('x-real-ip')?.trim() || 'unknown'
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, password, slug } = body
    // `invite` is what the register page reads out of the ?invite= query
    // param. `inviteToken` is accepted as well so a caller that spells it
    // out is not silently rejected.
    const inviteToken: string | null =
      (body.inviteToken as string | undefined) ?? (body.invite as string | undefined) ?? null

    if (!email || !password || !slug) {
      return NextResponse.json(
        { error: 'Missing required fields: email, password, slug' },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    // Rate limit before any lookup. Two keys: the IP stops one machine
    // grinding through tokens, the venue key stops a botnet grinding
    // through one venue's. Both are cheap and neither can be the
    // forbidden ':shared' namespace.
    const ip = clientIp(request)
    for (const check of [
      { key: `couple-register-ip:${ip}`, limit: IP_LIMIT },
      { key: `couple-register-venue:${String(slug)}`, limit: VENUE_LIMIT },
    ]) {
      const rl = await checkRateLimit({
        key: check.key,
        limit: check.limit,
        windowSec: RATE_WINDOW_SEC,
      })
      if (!rl.ok) {
        return NextResponse.json(
          { error: 'Too many registration attempts. Try again later.' },
          { status: 429, headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) } }
        )
      }
    }

    const supabase = createServiceClient()

    // 1. Resolve the invite by the hash of the presented token. The
    // plaintext never touches the database.
    let invite: CoupleInviteRow | null = null
    if (inviteToken && inviteToken.trim()) {
      const { data, error: inviteErr } = await supabase
        .from('couple_invites')
        .select('id, venue_id, wedding_id, email, expires_at, used_at')
        .eq('token_hash', hashInviteToken(inviteToken))
        .maybeSingle()
      if (inviteErr) {
        console.error('[COUPLE REGISTER] Invite lookup error:', inviteErr)
        return NextResponse.json(
          { error: 'Failed to check your invitation' },
          { status: 500 }
        )
      }
      invite = (data as CoupleInviteRow | null) ?? null
    }

    const inviteCheck = validateCoupleInvite(invite, {
      token: inviteToken,
      email: String(email),
    })
    if (!inviteCheck.ok) {
      return NextResponse.json({ error: inviteCheck.message }, { status: 400 })
    }
    // Narrowed by validateCoupleInvite: ok implies a row.
    const validInvite = invite as CoupleInviteRow

    // 2. Load the wedding the invite points at, and check the venue slug
    // in the URL is the one that sent it.
    const { data: wedding, error: lookupErr } = await supabase
      .from('weddings')
      .select('id, venue_id, status, couple_registered_at, venues(name, slug)')
      .eq('id', validInvite.wedding_id)
      .maybeSingle()

    if (lookupErr) {
      console.error('[COUPLE REGISTER] Wedding lookup error:', lookupErr)
      return NextResponse.json({ error: 'Failed to look up your wedding' }, { status: 500 })
    }
    if (!wedding) {
      return NextResponse.json(
        { error: 'This invitation is no longer valid. Ask your venue to send a fresh one.' },
        { status: 400 }
      )
    }

    const venueData = wedding.venues as
      | { name?: string; slug?: string }
      | { name?: string; slug?: string }[]
      | null
    const venueSlug = Array.isArray(venueData) ? venueData[0]?.slug : venueData?.slug

    if (venueSlug !== slug || wedding.venue_id !== validInvite.venue_id) {
      return NextResponse.json(
        { error: 'This invitation does not belong to this venue.' },
        { status: 400 }
      )
    }

    // 3. Count existing couple accounts for this wedding, and check
    // whether this email already has one.
    const { data: existingProfiles, error: countErr } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('wedding_id', wedding.id)
      .eq('role', 'couple')

    if (countErr) {
      console.error('[COUPLE REGISTER] Count error:', countErr)
      return NextResponse.json({ error: 'Failed to verify registration state' }, { status: 500 })
    }

    const profileRows = (existingProfiles ?? []) as { id: string }[]
    // user_profiles.id IS the auth.uid(), so resolve each one's email to
    // spot a repeat registration rather than creating a duplicate.
    let emailAlreadyRegistered = false
    for (const row of profileRows) {
      const { data: authUser } = await supabase.auth.admin.getUserById(row.id)
      if (authUser?.user?.email?.toLowerCase() === String(email).toLowerCase()) {
        emailAlreadyRegistered = true
        break
      }
    }

    const eligibility = checkRegistrationEligibility({
      weddingStatus: wedding.status as string | null,
      coupleAccountCount: profileRows.length,
      emailAlreadyRegistered,
    })
    if (!eligibility.ok) {
      return NextResponse.json({ error: eligibility.message }, { status: 400 })
    }

    // 4. Claim the invite before creating anything. The .is('used_at', null)
    // guard plus .select() means exactly one of two concurrent redemptions
    // gets rows back; the loser is told the link is spent.
    const { data: claimed, error: claimErr } = await supabase
      .from('couple_invites')
      .update({ used_at: new Date().toISOString() })
      .eq('id', validInvite.id)
      .is('used_at', null)
      .select('id')

    if (claimErr) {
      console.error('[COUPLE REGISTER] Invite claim error:', claimErr)
      return NextResponse.json({ error: 'Failed to accept your invitation' }, { status: 500 })
    }
    if (!Array.isArray(claimed) || claimed.length === 0) {
      return NextResponse.json(
        {
          error:
            'This invitation has already been used. If that was you, sign in instead.',
        },
        { status: 400 }
      )
    }

    // Put the invite back if anything below fails, so the couple can retry
    // with the same link rather than having to ask for another.
    async function releaseInvite() {
      await supabase
        .from('couple_invites')
        .update({ used_at: null })
        .eq('id', validInvite.id)
    }

    // 5. Create the auth user. email_confirm is true because the invite
    // token was delivered to this address and nowhere else, so possession
    // of it proves the address as well as a confirmation click would.
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: 'couple' },
    })

    if (authError || !authData?.user) {
      console.error('[COUPLE REGISTER] Auth error:', authError)
      await releaseInvite()
      return NextResponse.json(
        { error: authError?.message ?? 'Could not create your account' },
        { status: 400 }
      )
    }

    // 6. Create the user_profile.
    // Tier-A #2b (mig 226): wedding_id is what gates the couple_read /
    // couple_write RLS policies on every couple-portal-readable table.
    // Without it the couple session resolves to "anon-but-authed" and sees
    // no rows, and the 2-account cap above cannot see them either. This
    // used to log and carry on, then return success. It no longer does.
    const { error: profileErr } = await supabase.from('user_profiles').insert({
      id: authData.user.id,
      venue_id: wedding.venue_id,
      wedding_id: wedding.id,
      role: 'couple',
    })

    if (profileErr) {
      console.error('[COUPLE REGISTER] Profile error:', profileErr)
      // Roll the auth user back. An account that can sign in but sees an
      // empty portal is worse than no account: it looks like the venue
      // lost their data, and it blocks the address from registering again.
      const { error: deleteErr } = await supabase.auth.admin.deleteUser(authData.user.id)
      if (deleteErr) {
        console.error('[COUPLE REGISTER] Rollback failed, orphan auth user:', {
          userId: authData.user.id,
          error: deleteErr.message,
        })
      }
      await releaseInvite()
      return NextResponse.json(
        { error: 'Could not finish setting up your account. Please try again.' },
        { status: 500 }
      )
    }

    // 7. Stamp couple_registered_at on FIRST registration only. Preserves
    // "when did the couple first start using the portal" for analytics.
    if (!wedding.couple_registered_at) {
      await supabase
        .from('weddings')
        .update({ couple_registered_at: new Date().toISOString() })
        .eq('id', wedding.id)
    }

    // 8. Link the auth user to an existing people row by email, when one
    // is already there. Nothing is written if there is no match: the old
    // code stamped this address onto the first partner row that had none,
    // which meant partner 2 registering could put their email on
    // partner 1's record and quietly corrupt who is who.
    const { data: existingPerson } = await supabase
      .from('people')
      .select('id')
      .eq('wedding_id', wedding.id)
      .ilike('email', String(email))
      .maybeSingle()

    return NextResponse.json({
      success: true,
      weddingId: wedding.id,
      venueSlug,
      personLinked: Boolean(existingPerson),
      // Surface to the client whether this was the first or second partner
      // so the post-register screen can welcome them appropriately.
      partnerNumber: eligibility.partnerNumber,
    })
  } catch (err) {
    console.error('[COUPLE REGISTER ERROR]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
