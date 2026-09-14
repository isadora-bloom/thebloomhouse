/**
 * W66 — the small spine reader that API routes use when all they have is
 * a legacy wedding id.
 *
 * Why this exists
 * ---------------
 * The canonical six in `src/lib/intel/canonical.ts` answer the big
 * questions (a venue overview, a couple journey, a daily list). A lot of
 * route handlers want something much smaller: the couple's names, their
 * addresses, their wedding date. Before W66 each of those routes reached
 * into `weddings` + `people` and assembled the display name its own way,
 * which is exactly the "one question, three answers" problem the W2
 * ratchet was put up to stop.
 *
 * So: one reader, one display-name rule, spine only. It reads `couples`
 * and nothing else. A wedding id reaches the spine through
 * `couples.source_wedding_id`, the Phase-A back-reference (migration
 * 346). Merged-away couples (migration 379's `merged_into_id`) are
 * tombstones and are never returned.
 *
 * Honest-empty, never fake: a wedding with no mirrored couple returns
 * null, and the caller renders "Unknown" rather than inventing a name.
 * It does NOT fall back to `weddings` / `people` — a silent fallback
 * would put the legacy read straight back where it was.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** One couple as the spine holds it, in the shape a route wants. */
export interface CoupleMirror {
  coupleId: string
  venueId: string
  /** `couples.source_wedding_id` — the legacy row this couple mirrors. */
  weddingId: string | null
  lifecycleState: string | null
  weddingDate: string | null
  primaryName: string | null
  primaryEmail: string | null
  primaryPhone: string | null
  partnerName: string | null
  partnerEmail: string | null
  partnerPhone: string | null
}

interface RawCoupleRow {
  id: string
  venue_id: string
  source_wedding_id: string | null
  lifecycle_state: string | null
  wedding_date: string | null
  primary_contact_name: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
  partner_contact_name: string | null
  partner_contact_email: string | null
  partner_contact_phone: string | null
}

const COUPLE_COLUMNS =
  'id, venue_id, source_wedding_id, lifecycle_state, wedding_date, ' +
  'primary_contact_name, primary_contact_email, primary_contact_phone, ' +
  'partner_contact_name, partner_contact_email, partner_contact_phone'

/** Supabase `.in()` takes a URL-encoded list; keep each page small enough
 *  that a thousand-wedding sweep does not build a request nobody can log. */
const IN_CHUNK = 150

function toMirror(row: RawCoupleRow): CoupleMirror {
  return {
    coupleId: row.id,
    venueId: row.venue_id,
    weddingId: row.source_wedding_id ?? null,
    lifecycleState: row.lifecycle_state ?? null,
    weddingDate: row.wedding_date ?? null,
    primaryName: row.primary_contact_name ?? null,
    primaryEmail: row.primary_contact_email ?? null,
    primaryPhone: row.primary_contact_phone ?? null,
    partnerName: row.partner_contact_name ?? null,
    partnerEmail: row.partner_contact_email ?? null,
    partnerPhone: row.partner_contact_phone ?? null,
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * The couple mirroring one legacy wedding, or null when the spine has
 * none. `venueId`, when given, is enforced — a wedding id from another
 * tenant resolves to null, never to their row.
 */
export async function loadCoupleByWedding(
  supabase: SupabaseClient,
  weddingId: string | null | undefined,
  venueId?: string | null,
): Promise<CoupleMirror | null> {
  if (!weddingId) return null
  let q = supabase
    .from('couples')
    .select(COUPLE_COLUMNS)
    .eq('source_wedding_id', weddingId)
    .is('merged_into_id', null)
    .limit(1)
  if (venueId) q = q.eq('venue_id', venueId)
  const { data } = await q
  const row = ((data ?? []) as unknown as RawCoupleRow[])[0]
  return row ? toMirror(row) : null
}

/**
 * The same lookup for a batch of wedding ids, keyed by wedding id. Ids
 * with no mirrored couple are simply absent from the map — the caller
 * decides what "no couple on the spine" looks like on its surface.
 */
export async function loadCouplesByWeddings(
  supabase: SupabaseClient,
  weddingIds: readonly string[],
  venueId?: string | null,
): Promise<Map<string, CoupleMirror>> {
  const out = new Map<string, CoupleMirror>()
  const ids = Array.from(new Set(weddingIds.filter(Boolean)))
  if (ids.length === 0) return out
  for (const page of chunk(ids, IN_CHUNK)) {
    let q = supabase
      .from('couples')
      .select(COUPLE_COLUMNS)
      .in('source_wedding_id', page)
      .is('merged_into_id', null)
    if (venueId) q = q.eq('venue_id', venueId)
    const { data } = await q
    for (const row of (data ?? []) as unknown as RawCoupleRow[]) {
      if (row.source_wedding_id && !out.has(row.source_wedding_id)) {
        out.set(row.source_wedding_id, toMirror(row))
      }
    }
  }
  return out
}

/**
 * Couples whose wedding day falls inside an inclusive date window, in one
 * or more lifecycle states. Dates are ISO `YYYY-MM-DD`, the shape
 * `couples.wedding_date` stores.
 */
export async function loadCouplesByWeddingDate(
  supabase: SupabaseClient,
  venueId: string,
  fromDate: string,
  toDate: string,
  lifecycleStates: readonly string[] = ['booked', 'completed'],
): Promise<CoupleMirror[]> {
  if (!venueId || !fromDate || !toDate) return []
  const { data } = await supabase
    .from('couples')
    .select(COUPLE_COLUMNS)
    .eq('venue_id', venueId)
    .in('lifecycle_state', [...lifecycleStates])
    .gte('wedding_date', fromDate)
    .lte('wedding_date', toDate)
    .is('merged_into_id', null)
  return ((data ?? []) as unknown as RawCoupleRow[]).map(toMirror)
}

/**
 * Couples in a venue whose primary or partner name matches `name`
 * case-insensitively. Used where a route only has a human name to go on
 * (a review byline, say) and wants the couple behind it. Returns every
 * match so the caller can refuse to guess when there is more than one.
 */
export async function findCouplesByName(
  supabase: SupabaseClient,
  venueId: string,
  name: string,
  limit = 5,
): Promise<CoupleMirror[]> {
  const trimmed = (name ?? '').trim()
  if (!venueId || trimmed.length < 3) return []
  // % and _ are wildcards in LIKE and legal in a name; escape before the
  // value goes anywhere near the filter grammar.
  const escaped = trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)
  const { data } = await supabase
    .from('couples')
    .select(COUPLE_COLUMNS)
    .eq('venue_id', venueId)
    .or(`primary_contact_name.ilike.%${escaped}%,partner_contact_name.ilike.%${escaped}%`)
    .is('merged_into_id', null)
    .limit(limit)
  return ((data ?? []) as unknown as RawCoupleRow[]).map(toMirror)
}

/**
 * The one display-name rule. "Alex & Sam" when both partners are known,
 * the single name when only one is, null when neither. Never "Unknown" —
 * that is a rendering choice and belongs to the surface.
 */
export function coupleDisplayName(couple: CoupleMirror | null): string | null {
  if (!couple) return null
  const primary = (couple.primaryName ?? '').trim()
  const partner = (couple.partnerName ?? '').trim()
  // A primary name that already reads as a pair ("Alex & Sam") is left
  // alone rather than doubled up with the partner column.
  if (primary && partner && !primary.toLowerCase().includes(partner.toLowerCase())) {
    return `${primary} & ${partner}`
  }
  return primary || partner || null
}

/** Every address on file for the couple, de-duplicated, lower-cased. */
export function coupleEmails(couple: CoupleMirror | null): string[] {
  if (!couple) return []
  const seen = new Set<string>()
  for (const raw of [couple.primaryEmail, couple.partnerEmail]) {
    const e = (raw ?? '').trim().toLowerCase()
    if (e) seen.add(e)
  }
  return Array.from(seen)
}

/**
 * How many partners the spine knows about: 1 for a solo contact, 2 once
 * a partner name is on file, null when the couple is not on the spine at
 * all (so a surface can hide the pill rather than claim "solo").
 */
export function partnerCount(couple: CoupleMirror | null): 1 | 2 | null {
  if (!couple) return null
  const primary = (couple.primaryName ?? '').trim()
  const partner = (couple.partnerName ?? '').trim()
  if (partner) return 2
  return primary ? 1 : null
}
