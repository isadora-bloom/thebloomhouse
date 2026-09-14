/**
 * Wedding id to couple, through the spine.
 *
 * Half the intel API surface is still addressed by a wedding id: the
 * URL segment is `[weddingId]`, the panel props carry `weddingId`, and
 * every link into those routes was written that way. Those routes then
 * did `from('weddings').select('venue_id').eq('id', weddingId)` twice
 * over: once to find the tenant, once to find the row. Two jobs, both
 * done against the table the spine replaced.
 *
 * `couples.source_wedding_id` (migration 346) is the spine's own
 * back-pointer to the wedding a couple was minted from, and
 * `uq_couples_source_wedding` makes `(venue_id, source_wedding_id)`
 * unique. So one `couples` read does both jobs at once:
 *
 *   - it maps the caller's wedding id onto the couple id every canonical
 *     reader is keyed on, and
 *   - it IS the tenancy check, because the row only comes back when the
 *     couple sits in a venue the caller already has.
 *
 * A wedding with no mirrored couple resolves to null, which a route
 * should report as "not in scope" rather than inventing an empty couple.
 * That is the honest answer: before the couple exists there is nothing
 * on the spine to say anything about.
 *
 * Injectable client, no service-role import, no network. Unit-tested in
 * ./__tests__/couple-key.test.ts against the in-memory fake.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CoupleKey {
  /** The spine id. Everything canonical is keyed on this. */
  coupleId: string
  venueId: string
  /** The wedding id the caller asked with. Echoed back so a batch
   *  lookup can be joined the other way round without a second map. */
  sourceWeddingId: string
  /** Display name, primary then partner. Null when the couple has
   *  neither, which happens on channel-scoped couples. */
  names: string | null
  primaryContactName: string | null
  partnerContactName: string | null
  lifecycleState: string | null
  weddingDate: string | null
  heatScore: number | null
}

const SELECT =
  'id, venue_id, source_wedding_id, primary_contact_name, partner_contact_name, lifecycle_state, wedding_date, heat_score, merged_into_id'

interface RawCoupleKeyRow {
  id: string
  venue_id: string
  source_wedding_id: string | null
  primary_contact_name: string | null
  partner_contact_name: string | null
  lifecycle_state: string | null
  wedding_date: string | null
  heat_score: number | null
  merged_into_id: string | null
}

/** Couple display name, primary then partner. Mirrors the couples list
 *  and `loadDailyList`, so one couple reads the same everywhere. */
function coupleNames(primary: string | null, partner: string | null): string | null {
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? null
}

function toKey(row: RawCoupleKeyRow): CoupleKey {
  return {
    coupleId: row.id,
    venueId: row.venue_id,
    sourceWeddingId: row.source_wedding_id as string,
    names: coupleNames(row.primary_contact_name, row.partner_contact_name),
    primaryContactName: row.primary_contact_name,
    partnerContactName: row.partner_contact_name,
    lifecycleState: row.lifecycle_state,
    weddingDate: row.wedding_date,
    heatScore: row.heat_score,
  }
}

/**
 * One wedding id, scoped to one venue.
 *
 * Returns null when the venue does not own a couple mirrored from that
 * wedding, and null for a merged-away couple: a tombstone is not an
 * identity, and a caller that follows the merge pointer should do it
 * deliberately rather than by accident.
 */
export async function loadCoupleKeyForWedding(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<CoupleKey | null> {
  if (!venueId || !weddingId) return null
  const { data } = await supabase
    .from('couples')
    .select(SELECT)
    .eq('venue_id', venueId)
    .eq('source_wedding_id', weddingId)
    .is('merged_into_id', null)
    .maybeSingle<RawCoupleKeyRow>()
  if (!data) return null
  return toKey(data)
}

/**
 * Many wedding ids, across one or more venues the caller already holds.
 *
 * Keyed by wedding id so a caller holding a list of wedding ids can map
 * straight across. A wedding with no couple is simply absent from the
 * map; there is no placeholder entry, because an empty couple would
 * render as a real one.
 */
export async function loadCoupleKeysForWeddings(
  supabase: SupabaseClient,
  venueIds: readonly string[],
  weddingIds: readonly string[],
): Promise<Map<string, CoupleKey>> {
  const out = new Map<string, CoupleKey>()
  if (venueIds.length === 0 || weddingIds.length === 0) return out
  const { data } = await supabase
    .from('couples')
    .select(SELECT)
    .in('venue_id', venueIds as string[])
    .in('source_wedding_id', weddingIds as string[])
    .is('merged_into_id', null)
  for (const row of (data ?? []) as RawCoupleKeyRow[]) {
    if (!row.source_wedding_id) continue
    out.set(row.source_wedding_id, toKey(row))
  }
  return out
}
