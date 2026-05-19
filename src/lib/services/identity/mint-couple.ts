/**
 * lockAndMintCouple — Tier 8 / T8.1a.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 ("Don't skip #1") +
 * Appendix C §C.3 ("Advisory-locked — pg_try_advisory_xact_lock around
 * every couple mint; loser re-reads and attaches").
 *
 * This is the TypeScript half of the advisory-locked mint. The lock +
 * re-check + INSERT must share one transaction, so all of that lives in
 * the `lock_and_mint_couple` Postgres function (migration 359). This
 * file is the thin caller: it computes the lock key from the signal's
 * strongest stable identifier and hands the RPC the identity fields.
 *
 * The tracer.ts header promised a `lockAndUpsertCouple` helper "see
 * below" that never existed. This is that helper, named for what it
 * actually does (mint a channel-scoped couple, not upsert an anchor).
 *
 * NOT yet wired into the sweep — that is T8.1b. T8.1a ships the mint
 * primitive; T8.1b routes identity-sufficient unmatched signals into it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { canonicaliseEmail, normalizePhone } from './resolver'
import type { NormalizedSignal } from './sources/types'

export interface MintCoupleResult {
  /** couples.id of the minted-or-matched couple. Null only on a
   *  pathological RPC return (logged by the caller). */
  coupleId: string | null
  /** True when a new channel-scoped couple row was inserted; false when
   *  the signal attached to a couple that already existed. */
  minted: boolean
  /** True when a new touchpoint row was inserted; false when this exact
   *  signal had already been swept (idempotent rerun). */
  touchpointInserted: boolean
  /** touchpoints.id of the attached touchpoint. Set on a fresh insert
   *  and on an idempotent re-hit; null only on a pathological return. */
  touchpointId: string | null
}

/**
 * The advisory-lock key for a signal: its strongest stable identifier,
 * in priority order. Two signals that resolve to the same key serialise
 * against each other so they cannot double-mint.
 *
 *   email   — fully race-safe (RPC re-checks couples by email)
 *   phone   — fully race-safe (RPC re-checks couples by phone)
 *   handle  — serialised but may still mint two channel-scoped couples
 *             under concurrency; the matcher coalesces them later
 *   signal  — the floor; the key equals the touchpoint dedup key, so
 *             the RPC's touchpoint re-check is itself the race guard
 */
export function computeLockKey(signal: NormalizedSignal): string {
  const email =
    canonicaliseEmail(signal.primary_email ?? null) ??
    canonicaliseEmail(signal.partner_email ?? null)
  if (email) return `email:${email}`

  const phone =
    normalizePhone(signal.primary_phone ?? null) ??
    normalizePhone(signal.partner_phone ?? null)
  if (phone) return `phone:${phone}`

  const hint = (signal.identity_hint ?? '').trim().toLowerCase()
  if (hint) return `handle:${signal.channel}:${hint}`

  return `signal:${signal.channel}:${signal.external_id}`
}

/**
 * Has this signal got enough identity to MINT a couple (vs. drop to a
 * Fragment)? Appendix C §C.2: "inquiry with sufficient identity → a
 * Couple; without → a Fragment."
 *
 * This gates MINTING a NEW couple only. A signal that fails it can
 * still be ATTACHED to an existing couple by the matcher — the email
 * / phone still travel on the signal for that.
 *
 * Gmail is special-cased. It is the noisiest channel — vendor blasts,
 * platform notifications (Zola/Knot alerts), the venue's own mail. An
 * orphan Gmail signal mints a couple ONLY if the author classifier
 * positively tagged the sender a couple. Vendor / platform / operator
 * / sage / still-unclassified senders stay Fragments until classified
 * — that is what stopped "Novela", "Signature Event Rentals" and
 * raw-phone-number rows landing in the couples list.
 *
 * Other channels (knot / calendly / instagram) need a reachable email
 * OR a real two-token name. A bare phone with no name is NOT enough —
 * it only ever produced a couple literally named "5715551234".
 */
export function hasSufficientIdentity(signal: NormalizedSignal): boolean {
  if (signal.channel === 'gmail') {
    return signal.author_class === 'couple'
  }
  if (signal.primary_email || signal.partner_email) return true
  const name = (signal.primary_name ?? '').trim()
  return name.split(/\s+/).filter(Boolean).length >= 2
}

/**
 * Mint (or attach to) a channel-scoped couple for one signal, then
 * attach the signal's touchpoint — atomically, under an advisory lock.
 *
 * Throws on RPC error (the caller's stage wraps it into a
 * tracer_run_events 'failed' row so a resume retries the batch).
 */
export async function lockAndMintCouple(
  supabase: SupabaseClient,
  venueId: string,
  signal: NormalizedSignal,
): Promise<MintCoupleResult> {
  // couples.primary_contact_name is NOT NULL. Mirror the fallback chain
  // mirror-couple.ts uses: name → handle → email → phone → placeholder.
  const primaryName =
    signal.primary_name?.trim() ||
    signal.identity_hint?.trim() ||
    signal.primary_email ||
    signal.primary_phone ||
    'Unnamed couple'

  const { data, error } = await supabase.rpc('lock_and_mint_couple', {
    p_venue_id: venueId,
    p_lock_key: computeLockKey(signal),
    p_channel: signal.channel,
    p_external_id: signal.external_id,
    p_signal_tier: signal.signal_tier,
    p_action_type: signal.action_type,
    p_occurred_at: signal.occurred_at,
    p_raw_payload: signal.raw_payload ?? null,
    p_primary_name: primaryName,
    p_primary_email: signal.primary_email ?? null,
    p_primary_phone: signal.primary_phone ?? null,
    p_partner_name: signal.partner_name ?? null,
    p_partner_email: signal.partner_email ?? null,
    p_partner_phone: signal.partner_phone ?? null,
    p_wedding_date: signal.wedding_date ?? null,
    p_channel_scope: signal.channel,
  })

  if (error) throw new Error(`lock_and_mint_couple: ${error.message}`)

  // RETURNS TABLE → supabase-js returns an array of one row.
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        couple_id: string | null
        minted: boolean
        touchpoint_inserted: boolean
        touchpoint_id: string | null
      }
    | null
    | undefined
  if (!row) {
    return {
      coupleId: null,
      minted: false,
      touchpointInserted: false,
      touchpointId: null,
    }
  }
  return {
    coupleId: row.couple_id ?? null,
    minted: Boolean(row.minted),
    touchpointInserted: Boolean(row.touchpoint_inserted),
    touchpointId: row.touchpoint_id ?? null,
  }
}
