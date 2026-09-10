/**
 * demo-reseed — the venue guard.
 *
 * The reseed deletes rows. The only thing standing between it and a real
 * venue's five years of history is this check, so it hard-fails rather
 * than skipping: an unknown id, a missing venue, or a venue whose
 * `is_demo` flag is anything other than `true` aborts the run before the
 * first delete. Same posture as `scripts/phase2-remerge-operator-columns.mjs`.
 *
 * Two layers, deliberately:
 *   1. Static — the id must be one of the four Crestwood ids compiled
 *      into `roster.ts`. Catches a typo before a connection is opened.
 *   2. Live — `venues.is_demo` must be true for every one of them.
 *      Catches the case where someone flipped the flag off, or where the
 *      ids were reused on another project.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { DEMO_VENUE_IDS } from './roster'

export interface VenueGuardRow {
  id: string
  name: string | null
  is_demo: boolean | null
}

export interface VenueGuardResult {
  ok: boolean
  rows: VenueGuardRow[]
  problems: string[]
}

/** Layer 1. Pure, no IO. */
export function assertKnownDemoVenueIds(venueIds: readonly string[]): void {
  const known = new Set(DEMO_VENUE_IDS)
  const strays = venueIds.filter((id) => !known.has(id))
  if (strays.length > 0) {
    throw new Error(
      `demo-reseed: refusing to run. These venue ids are not Crestwood demo venues: ${strays.join(', ')}`,
    )
  }
  if (venueIds.length === 0) {
    throw new Error('demo-reseed: refusing to run against an empty venue list.')
  }
}

/** Layer 2. Reads `venues`. Returns the finding rather than throwing so
 *  the caller can print it before deciding. */
export async function checkVenuesAreDemo(
  supabase: SupabaseClient,
  venueIds: readonly string[],
): Promise<VenueGuardResult> {
  const { data, error } = await supabase
    .from('venues')
    .select('id, name, is_demo')
    .in('id', venueIds as string[])

  if (error) {
    return {
      ok: false,
      rows: [],
      problems: [`could not read venues: ${error.message}`],
    }
  }

  const rows = (data ?? []) as VenueGuardRow[]
  const problems: string[] = []
  const byId = new Map(rows.map((r) => [r.id, r]))

  for (const id of venueIds) {
    const row = byId.get(id)
    if (!row) {
      problems.push(`venue ${id} does not exist`)
      continue
    }
    if (row.is_demo !== true) {
      problems.push(
        `venue ${id} (${row.name ?? 'unnamed'}) has is_demo=${String(row.is_demo)}, not true`,
      )
    }
  }

  return { ok: problems.length === 0, rows, problems }
}

/** Both layers, throwing on any failure. This is what the applier calls. */
export async function assertDemoVenues(
  supabase: SupabaseClient,
  venueIds: readonly string[],
): Promise<VenueGuardRow[]> {
  assertKnownDemoVenueIds(venueIds)
  const result = await checkVenuesAreDemo(supabase, venueIds)
  if (!result.ok) {
    throw new Error(
      `demo-reseed: refusing to run. ${result.problems.join('; ')}`,
    )
  }
  return result.rows
}
