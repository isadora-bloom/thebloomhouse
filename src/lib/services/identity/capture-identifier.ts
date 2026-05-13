/**
 * Append an identifier to a wedding's historical identifier pool.
 *
 * Step 7 / A2 (2026-05-13, bloom-identity-resolution-doctrine.md).
 *
 * Why this exists
 * ---------------
 * The resolver matches against people.email and people.phone — live
 * columns that get OVERWRITTEN as new signals arrive. A returning
 * couple who switches phones, or whose Knot relay alias is later
 * replaced by their real gmail, loses the historical identifier on
 * the people row. couple_identity_profile.identifiers is the
 * append-only pool that preserves every observed identifier across
 * the wedding's lifetime, with source + timestamps so the resolver
 * (and audit) can trace identity continuity.
 *
 * Contract
 * --------
 * - Idempotent. Re-capturing an existing identifier updates only
 *   last_seen_at and (when present) source — never duplicates.
 * - NEVER throws. The pool is a forensic-record / future-match
 *   primitive; capture failures must not block the load-bearing
 *   resolve/mint path that called us.
 * - Append-only. We never remove an identifier from the pool. An
 *   identifier whose normalised value is no longer on people.email
 *   stays in the pool — that's the whole point.
 *
 * Wired call sites:
 *   - resolver.ts: every successful match or create fires this for
 *     the email/phone/name that arrived.
 *
 * Future-wired (Step 7b — matcher pool read):
 *   - findByEmailExact / findByPhone fall through to a pool scan
 *     when live people.email/phone miss. That's what makes the pool
 *     actually load-bearing for re-engagement matching.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

export type IdentifierType = 'email' | 'phone' | 'name_spelling' | 'social_handle'

export interface CaptureIdentifierInput {
  weddingId: string
  type: IdentifierType
  /** The raw observed value. Normalisation (lowercase email, E.164 phone)
   *  happens inside this helper so callers can hand over whatever shape
   *  the upstream signal carried. */
  value: string
  /** Where the identifier came from. Free-text for now — examples:
   *  'gmail_from_name', 'calendly_invitee', 'twilio_sms', 'crm_import',
   *  'manual_override'. */
  source: string
  supabase?: SupabaseClient
}

interface PoolEntry {
  type: IdentifierType
  value: string
  first_seen_at: string
  last_seen_at: string
  source: string
}

function normaliseEmail(v: string): string | null {
  const t = v.trim().toLowerCase()
  if (!t || !t.includes('@')) return null
  const at = t.indexOf('@')
  const local = t.slice(0, at)
  const domain = t.slice(at)
  const plus = local.indexOf('+')
  return (plus < 0 ? t : local.slice(0, plus) + domain)
}

function normalisePhone(v: string): string | null {
  const digits = v.replace(/\D+/g, '')
  if (digits.length < 10) return null
  if (digits.length === 10) return `+1${digits}`
  return `+${digits}`
}

function normaliseValue(type: IdentifierType, value: string): string | null {
  switch (type) {
    case 'email': return normaliseEmail(value)
    case 'phone': return normalisePhone(value)
    case 'name_spelling':
    case 'social_handle': {
      const t = value.trim()
      return t.length > 0 ? t : null
    }
  }
}

/**
 * Append (or refresh) one identifier on a wedding's pool. Never throws.
 *
 * Returns:
 *   { ok: true, action: 'added' | 'refreshed' | 'skipped' }
 *   { ok: false, reason: string }
 */
export async function captureIdentifier(
  input: CaptureIdentifierInput,
): Promise<{ ok: true; action: 'added' | 'refreshed' | 'skipped' } | { ok: false; reason: string }> {
  const { weddingId, type, value, source } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!weddingId || !value) return { ok: false, reason: 'missing weddingId/value' }
  const normalised = normaliseValue(type, value)
  if (!normalised) return { ok: false, reason: 'normalisation failed' }

  try {
    const { data: row, error: readErr } = await supabase
      .from('couple_identity_profile')
      .select('identifiers')
      .eq('wedding_id', weddingId)
      .maybeSingle()
    if (readErr) {
      // Most common reason: profile row doesn't exist yet (Pattern A
      // weddings before Wave 4 has minted a profile). Skip silently —
      // the next reconstructCoupleIdentity run will mint the row and
      // future captures will land.
      return { ok: false, reason: `read failed: ${readErr.message}` }
    }
    if (!row) {
      return { ok: false, reason: 'no profile row yet' }
    }

    const pool = Array.isArray(row.identifiers) ? (row.identifiers as PoolEntry[]) : []
    const existingIdx = pool.findIndex(
      (e) => e?.type === type && e?.value === normalised,
    )
    const now = new Date().toISOString()

    let nextPool: PoolEntry[]
    let action: 'added' | 'refreshed'
    if (existingIdx >= 0) {
      // Refresh last_seen_at + source. Preserve first_seen_at as the
      // earliest observation.
      const existing = pool[existingIdx]
      nextPool = pool.slice()
      nextPool[existingIdx] = {
        type,
        value: normalised,
        first_seen_at: existing.first_seen_at ?? now,
        last_seen_at: now,
        source,
      }
      action = 'refreshed'
    } else {
      nextPool = [
        ...pool,
        { type, value: normalised, first_seen_at: now, last_seen_at: now, source },
      ]
      action = 'added'
    }

    const { error: updateErr } = await supabase
      .from('couple_identity_profile')
      .update({ identifiers: nextPool, updated_at: new Date().toISOString() })
      .eq('wedding_id', weddingId)
    if (updateErr) {
      return { ok: false, reason: `update failed: ${updateErr.message}` }
    }
    return { ok: true, action }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Convenience wrapper for the common case in resolver.ts: capture
 * email + phone + display name in one call when a resolve succeeds.
 * Each one is fire-and-forget — failures log + continue.
 */
export function captureSignalIdentifiers(input: {
  weddingId: string
  email?: string | null
  phone?: string | null
  displayName?: string | null
  source: string
  supabase?: SupabaseClient
}): void {
  void (async () => {
    const promises: Array<Promise<unknown>> = []
    if (input.email) {
      promises.push(
        captureIdentifier({
          weddingId: input.weddingId,
          type: 'email',
          value: input.email,
          source: input.source,
          supabase: input.supabase,
        }),
      )
    }
    if (input.phone) {
      promises.push(
        captureIdentifier({
          weddingId: input.weddingId,
          type: 'phone',
          value: input.phone,
          source: input.source,
          supabase: input.supabase,
        }),
      )
    }
    if (input.displayName) {
      promises.push(
        captureIdentifier({
          weddingId: input.weddingId,
          type: 'name_spelling',
          value: input.displayName,
          source: input.source,
          supabase: input.supabase,
        }),
      )
    }
    await Promise.allSettled(promises)
  })()
}
