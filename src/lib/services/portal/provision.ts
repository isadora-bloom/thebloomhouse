/**
 * Couple-portal provisioning.
 *
 * When a wedding is booked, the coordinator should be able to open and
 * hold its portal from day one, and be able to invite the couple whenever
 * they choose. Provisioning makes a wedding portal-ready:
 *
 *   1. event_code — a short human reference for the wedding's portal.
 *      A coordinator can read it down the phone. It is NOT a credential:
 *      see the invite-token helpers below and migration 391.
 *   2. wedding_details shell — a single row so the coordinator opens a
 *      real portal record, not a blank insert-on-first-write.
 *
 * Idempotent: a wedding that already has an event_code + a
 * wedding_details row is left untouched. Safe to call on every booked
 * transition and again at invite time.
 *
 * Never throws — provisioning is best-effort; a failure here must not
 * fail the booking or the invite.
 *
 * This module is also the single home for couple-invite token minting and
 * for the two pure decision functions the register endpoint runs. They
 * live here rather than in the route so they can be unit tested without a
 * database, and so there is one implementation rather than four.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

export interface ProvisionResult {
  event_code: string | null
  wedding_details_created: boolean
}

function codePrefix(slug: string | null | undefined): string {
  const letters = (slug ?? '').replace(/[^a-zA-Z]/g, '')
  return (letters.slice(0, 3) || 'BLM').toUpperCase()
}

/**
 * The one event-code generator.
 *
 * There used to be four: this file, the two portal wedding pages (one of
 * which wrote the code straight from the browser and never checked the
 * result) and the mint-wedding route. Four copies of a format is four
 * places to change it and three places to get it subtly wrong.
 *
 * Format: three letters of the venue slug, a hyphen, three digits. Short
 * enough to read aloud. Not secret, and nothing should treat it as such.
 */
export function generateEventCode(slug: string | null | undefined): string {
  return `${codePrefix(slug)}-${Math.floor(100 + Math.random() * 900)}`
}

// ---------------------------------------------------------------------------
// Couple invite tokens (migration 391)
// ---------------------------------------------------------------------------

/** sha256 of an invite token, lower-case hex. Only the hash is ever stored. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex')
}

/**
 * Mint a fresh invite token. 128 bits from the system CSPRNG, hex encoded,
 * so the plaintext is 32 characters and is not worth guessing. The caller
 * puts `token` in the emailed link and stores `tokenHash`.
 */
export function mintInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(16).toString('hex')
  return { token, tokenHash: hashInviteToken(token) }
}

/** The columns of couple_invites the register endpoint needs. */
export interface CoupleInviteRow {
  id: string
  venue_id: string
  wedding_id: string
  email: string
  expires_at: string
  used_at: string | null
}

export type InviteRejectReason =
  | 'missing_token'
  | 'not_found'
  | 'already_used'
  | 'expired'
  | 'email_mismatch'
  | 'venue_mismatch'

export type InviteCheck =
  | { ok: true }
  | { ok: false; reason: InviteRejectReason; message: string }

/**
 * Is this invite good for this person, right now?
 *
 * Deliberately pure: hand it the row and the claim, get back a verdict.
 * The messages are the ones a couple sees, so they say what to do next
 * without saying which check failed. An attacker learning "that token
 * exists but belongs to someone else" is a small leak, and there is no
 * reason to hand it over.
 */
export function validateCoupleInvite(
  invite: CoupleInviteRow | null | undefined,
  claim: {
    token: string | null | undefined
    email: string
    venueId?: string | null
    now?: Date
  },
): InviteCheck {
  const generic =
    'This invitation link is not valid. Ask your venue to send you a fresh one.'

  if (!claim.token || !claim.token.trim()) {
    return {
      ok: false,
      reason: 'missing_token',
      message:
        'This page needs the link from your invitation email. Open that link, or ask your venue to resend it.',
    }
  }
  if (!invite) return { ok: false, reason: 'not_found', message: generic }
  if (invite.used_at) {
    return {
      ok: false,
      reason: 'already_used',
      message:
        'This invitation has already been used. If that was you, sign in instead. If not, ask your venue for a new link.',
    }
  }

  const now = claim.now ?? new Date()
  const expiresAt = new Date(invite.expires_at)
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      reason: 'expired',
      message: 'This invitation has expired. Ask your venue to send you a fresh one.',
    }
  }

  if (invite.email.trim().toLowerCase() !== claim.email.trim().toLowerCase()) {
    return {
      ok: false,
      reason: 'email_mismatch',
      message:
        'This invitation was sent to a different email address. Register with the address your venue invited, or ask them to resend it.',
    }
  }

  if (claim.venueId && invite.venue_id !== claim.venueId) {
    return { ok: false, reason: 'venue_mismatch', message: generic }
  }

  return { ok: true }
}

export type RegisterRejectReason =
  | 'wedding_not_bookable'
  | 'account_cap'
  | 'email_already_registered'

export type RegisterCheck =
  | { ok: true; partnerNumber: 1 | 2 }
  | { ok: false; reason: RegisterRejectReason; message: string }

/** Wedding statuses whose couple may hold a portal account. */
const REGISTERABLE_STATUSES = new Set(['booked', 'completed'])

/**
 * Everything the register endpoint decides once the invite has checked out.
 *
 * Cap at two accounts: two partners is the supported case. A planner who
 * needs their own login is a coordinator-side action, not a third partner.
 */
export function checkRegistrationEligibility(input: {
  weddingStatus: string | null | undefined
  coupleAccountCount: number
  emailAlreadyRegistered: boolean
}): RegisterCheck {
  if (!input.weddingStatus || !REGISTERABLE_STATUSES.has(input.weddingStatus)) {
    return {
      ok: false,
      reason: 'wedding_not_bookable',
      message: 'This wedding is not open for portal accounts yet. Your venue can help.',
    }
  }
  if (input.emailAlreadyRegistered) {
    return {
      ok: false,
      reason: 'email_already_registered',
      message:
        'An account with this email already exists for this wedding. Sign in instead.',
    }
  }
  if (input.coupleAccountCount >= 2) {
    return {
      ok: false,
      reason: 'account_cap',
      message:
        'Both partner accounts are already registered for this wedding. If you need help, contact your venue.',
    }
  }
  return { ok: true, partnerNumber: input.coupleAccountCount === 0 ? 1 : 2 }
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export async function provisionCouplePortal(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<ProvisionResult> {
  const result: ProvisionResult = {
    event_code: null,
    wedding_details_created: false,
  }
  try {
    const { data: wedding } = await supabase
      .from('weddings')
      .select('id, venue_id, event_code')
      .eq('id', weddingId)
      .maybeSingle()
    if (!wedding) return result

    const venueId = wedding.venue_id as string
    result.event_code = (wedding.event_code as string | null) ?? null

    // 1. Ensure a unique event_code.
    if (!result.event_code) {
      const { data: venue } = await supabase
        .from('venues')
        .select('slug')
        .eq('id', venueId)
        .maybeSingle()
      const slug = (venue as { slug?: string } | null)?.slug ?? null
      for (let attempt = 0; attempt < 25; attempt++) {
        const candidate = generateEventCode(slug)
        // .is('event_code', null) guard: if a concurrent write set the code
        // first this updates zero rows AND returns no error, so the old code
        // here happily reported a candidate that was never written.
        // .select() is what tells the two cases apart.
        const { data: updated, error } = await supabase
          .from('weddings')
          .update({ event_code: candidate })
          .eq('id', weddingId)
          .is('event_code', null)
          .select('event_code')
        if (!error && Array.isArray(updated) && updated.length > 0) {
          result.event_code =
            (updated[0] as { event_code?: string }).event_code ?? candidate
          break
        }
        // Anything other than a unique violation is a real failure, so stop.
        // 23505 = the candidate collided with another wedding's code.
        if (error && error.code !== '23505') break
        // Zero rows and no error means somebody else won the race. Take
        // their code rather than minting a second one.
        const { data: reread } = await supabase
          .from('weddings')
          .select('event_code')
          .eq('id', weddingId)
          .maybeSingle()
        const existing =
          (reread as { event_code?: string | null } | null)?.event_code ?? null
        if (existing) {
          result.event_code = existing
          break
        }
      }
    }

    // 2. Ensure the wedding_details shell row.
    const { data: details } = await supabase
      .from('wedding_details')
      .select('id')
      .eq('wedding_id', weddingId)
      .maybeSingle()
    if (!details) {
      const { error } = await supabase
        .from('wedding_details')
        .insert({ venue_id: venueId, wedding_id: weddingId })
      if (!error) result.wedding_details_created = true
    }

    return result
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'portal.provision_failed',
      data: {
        wedding_id: weddingId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return result
  }
}
