/**
 * Lightweight helpers around the canonical resolver. Used by entry paths
 * that already manage their own wedding-creation flow (notably the email
 * pipeline) and only need the person-side lookup chain.
 *
 * Why a separate file
 * -------------------
 * src/lib/services/identity/resolver.ts owns the `resolveIdentity` entry
 * point that always returns a (personId, weddingId) pair, creating one
 * if no match exists. Email-pipeline downstream creates the wedding
 * itself based on classification, so it needs a "find me the canonical
 * person" path that does NOT mint a row when the chain misses.
 *
 * This file imports the normalisation helpers from resolver.ts and
 * re-uses the same match-chain for the lookup-only case.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizeEmail,
  canonicaliseEmail,
  normalizePhone,
  resolveCanonicalPerson,
} from '@/lib/services/identity/resolver'

export interface CanonicalPersonHit {
  personId: string
  weddingId: string | null
}

/**
 * Run the canonical resolver's match-chain on (email, phone) and return
 * the canonical person if any chain step hits. Returns null on miss.
 *
 * Match chain:
 *   1. Email exact (lower + plus-addressing strip + venue-scoped)
 *   2. Email canonical (gmail dot/case stripping)
 *   3. Phone (E.164 normalize, both sides)
 *
 * Always chases merged_into_id to the canonical row.
 */
export async function findCanonicalPersonForEmail(
  supabase: SupabaseClient,
  venueId: string,
  email: string,
  phone: string | null
): Promise<CanonicalPersonHit | null> {
  // Step 1: email exact
  const norm = normalizeEmail(email)
  if (norm) {
    const { data: byEmail } = await supabase
      .from('people')
      .select('id, wedding_id, merged_into_id')
      .eq('venue_id', venueId)
      .ilike('email', norm)
      .is('merged_into_id', null)
      .order('created_at', { ascending: true })
      .limit(1)
    if (byEmail && byEmail[0]) {
      const personId = await resolveCanonicalPerson(supabase, byEmail[0].id as string)
      const { data: canon } = await supabase
        .from('people')
        .select('wedding_id')
        .eq('id', personId)
        .maybeSingle()
      return { personId, weddingId: (canon?.wedding_id as string | null) ?? (byEmail[0].wedding_id as string | null) ?? null }
    }
  }

  // Step 2: email canonical
  const canon = canonicaliseEmail(email)
  if (canon) {
    const { data: rows } = await supabase
      .from('people')
      .select('id, wedding_id, email, merged_into_id, created_at')
      .eq('venue_id', venueId)
      .not('email', 'is', null)
      .is('merged_into_id', null)
      .order('created_at', { ascending: true })
    if (rows) {
      for (const r of rows) {
        if (canonicaliseEmail(r.email as string | null) === canon) {
          const personId = await resolveCanonicalPerson(supabase, r.id as string)
          return { personId, weddingId: (r.wedding_id as string | null) ?? null }
        }
      }
    }
  }

  // Step 3: phone match
  const normPhone = normalizePhone(phone)
  if (normPhone) {
    const { data: rows } = await supabase
      .from('people')
      .select('id, wedding_id, phone, email, merged_into_id, created_at')
      .eq('venue_id', venueId)
      .not('phone', 'is', null)
      .is('merged_into_id', null)
      .order('created_at', { ascending: true })
    if (rows) {
      const candidates = rows.filter((r) => normalizePhone(r.phone as string | null) === normPhone)
      // Prefer the candidate with email already populated.
      const pick = candidates.find((c) => !!c.email) ?? candidates[0]
      if (pick) {
        const personId = await resolveCanonicalPerson(supabase, pick.id as string)
        return { personId, weddingId: (pick.wedding_id as string | null) ?? null }
      }
    }
  }

  return null
}
