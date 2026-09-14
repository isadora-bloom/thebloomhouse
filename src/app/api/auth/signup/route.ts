/**
 * /api/auth/signup — self-serve account creation.
 *
 * 2026-09-14 security remediation (S1, item 2). What this route was:
 *
 *   - Unauthenticated and unlimited, so it was a free account factory and
 *     a free way to spend Supabase's auth quota.
 *   - `email_confirm: true` on the service-role createUser call, which
 *     marks the address confirmed without anybody proving they can read
 *     it. Sign up as someone else's email and you own that address inside
 *     the platform.
 *   - The auth user was created FIRST and the role checked after, so
 *     `role: 'couple'` and any unknown role left a confirmed auth user
 *     behind with no user_profiles row. That orphan is exactly what the
 *     team-invitation accept path used to bind an org, venue and role
 *     onto without the "user" ever authenticating — the two halves of the
 *     same takeover.
 *
 * Now: rate limited per IP and per address, role validated before
 * anything is created, real email confirmation, and an auth user is never
 * left behind without a profile — if the org or the profile write fails
 * the user is deleted again.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { checkRateLimit, secondsUntil } from '@/lib/rate-limit'
import { clientIpForRateLimit } from '@/lib/security/client-ip'
import { createHash } from 'crypto'

/**
 * The roles a stranger may ask for. Everything else is refused before a
 * single row is written. `couple` is refused too, but by name, so the
 * page can show the right explanation.
 */
const SELF_SERVE_ROLES = new Set(['coordinator', 'venue_manager'])

export async function POST(request: NextRequest) {
  try {
    const { email, password, role, fullName } = await request.json()

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
    }
    if (typeof password !== 'string' || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters.' },
        { status: 400 }
      )
    }

    const normalisedEmail = String(email).trim().toLowerCase()

    // Rate limit before anything else. Two keys: the IP stops one machine
    // farming accounts, the address stops a distributed attempt on one
    // mailbox. The address key is hashed — rate-limit keys reach logs and
    // metric dimensions, and an email address is personal data.
    const emailKey = createHash('sha256').update(normalisedEmail).digest('hex').slice(0, 32)
    for (const [key, limit] of [
      [`signup-ip:${clientIpForRateLimit(request)}`, 5],
      [`signup-email:${emailKey}`, 3],
    ] as const) {
      const rl = await checkRateLimit({ key, limit, windowSec: 3600 })
      if (!rl.ok) {
        return NextResponse.json(
          { error: 'Too many sign-up attempts. Try again later.' },
          { status: 429, headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) } }
        )
      }
    }

    // Role check BEFORE the auth user exists. This is the whole orphan fix.
    if (role === 'couple') {
      return NextResponse.json(
        {
          error:
            'Couples register through their venue invitation link, not direct signup. Ask your venue coordinator for your event code.',
          coupleRedirect: true,
        },
        { status: 400 }
      )
    }
    if (typeof role !== 'string' || !SELF_SERVE_ROLES.has(role)) {
      return NextResponse.json(
        { error: 'Pick how you will be using The Bloom House before creating an account.' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // 1. Create the auth user. email_confirm stays FALSE — Supabase sends
    // its own confirmation mail and the address is only trusted once the
    // person has clicked it. The old `true` here handed anybody a
    // confirmed account on an address they had never read.
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: normalisedEmail,
      password,
      email_confirm: false,
      user_metadata: { full_name: fullName, role },
    })

    if (authError || !authData?.user) {
      return NextResponse.json(
        { error: authError?.message ?? 'Could not create the account.' },
        { status: 400 }
      )
    }

    const userId = authData.user.id

    /** Undo the auth user. Called on every failure below so no account
     *  ever exists without the profile that gives it a tenancy. */
    const rollback = async (why: string) => {
      console.error(`[signup] rolling back auth user ${userId}: ${why}`)
      const { error } = await supabase.auth.admin.deleteUser(userId)
      if (error) {
        // Worth shouting about: a survivor here is an account with no
        // profile, which is the state the invite-accept path used to
        // exploit.
        console.error(`[signup] ROLLBACK FAILED for ${userId}: ${error.message}`)
      }
    }

    // 2. Create a fresh organisation (no venue yet — that happens in /setup)
    const { data: org, error: orgError } = await supabase
      .from('organisations')
      .insert({
        name: fullName ? `${fullName}'s Company` : 'My Company',
        owner_id: userId,
        is_demo: false,
      })
      .select('id')
      .single()

    if (orgError || !org) {
      await rollback(`organisation insert failed: ${orgError?.message ?? 'no row'}`)
      return NextResponse.json({ error: 'Failed to create organisation.' }, { status: 500 })
    }

    // 3. Create user_profile with org_admin role, NO venue_id yet
    const nameParts = (fullName || '').split(' ')
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .insert({
        id: userId,
        venue_id: null,
        org_id: org.id,
        role: 'org_admin',
        first_name: nameParts[0] || null,
        last_name: nameParts.slice(1).join(' ') || null,
      })
      .select('id')
      .single()

    // The profile write used to be logged and shrugged off. It is the
    // thing that makes the account real; without it there is an auth user
    // nobody owns.
    if (profileError || !profile) {
      await supabase.from('organisations').delete().eq('id', org.id)
      await rollback(`user_profile insert failed: ${profileError?.message ?? 'no row'}`)
      return NextResponse.json({ error: 'Failed to create your account.' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      orgId: org.id,
      needsSetup: true,
      // The address has to be confirmed before the session works. Say so
      // rather than dropping the person on a login form that refuses them.
      confirmationRequired: true,
    })
  } catch (err) {
    console.error('Signup error:', err)
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
