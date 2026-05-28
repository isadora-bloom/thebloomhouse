/**
 * Per-section status loader for the couple-portal sidebar dots.
 *
 * 2026-05-26 (R1#1-followup sweep). Couples wanted a glance-able
 * indicator next to each sidebar item: nothing-started, in-progress,
 * or confirmed-done. Schema is already there (section_finalisations,
 * mig 009).
 *
 * Status derivation (couple's POV — staff sign-off ignored here):
 *   - 'green'  → section_finalisations.couple_signed_off = true
 *   - 'amber'  → has-data heuristic returns true (data exists)
 *   - null     → nothing to show (untouched OR section is read-only)
 *
 * Why null rather than 'grey': showing a dot on every item is
 * visually noisy. Rendering only when status is amber/green lets the
 * eye scan for what's in motion.
 *
 * Read-only / meta items (What's Next, Final Review, Venue Info,
 * Preferred Vendors, Recommended Buys, Inspiration, Resources,
 * Downloads, Stays, Messages, Privacy) deliberately have no status
 * row in SECTIONS — the sidebar omits dots for them.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Per-section status:
 *   - 'amber'   → has data, not yet signed off
 *   - 'green'   → couple has signed off (staff may or may not have)
 *   - 'confirmed' → couple AND staff both signed off
 *   - null      → empty / read-only / untouched
 *
 * 'confirmed' wins over 'green' on the dot render so couples see when
 * their coordinator has reviewed the section in addition to their own
 * sign-off.
 */
export type SectionStatus = 'amber' | 'green' | 'confirmed'

/**
 * Maps a sidebar slug to:
 *   - the `section_name` key used in section_finalisations
 *   - the SQL table + column to check for "has any data"
 *
 * Slugs match the sidebar `href` segment after the venue slug
 * (e.g. /couple/<slug>/budget → 'budget'). Keep this list in sync
 * with the sidebar nav structure.
 */
interface SectionDef {
  /** Sidebar URL slug (matches couple-sidebar href segment) */
  slug: string
  /** section_finalisations.section_name key. Reuse existing keys
   *  from final-review/page.tsx where possible. */
  finalisationKey: string
  /** Table to count rows on for has-data. */
  dataTable: string
}

export const SECTIONS: SectionDef[] = [
  // General — addresses is intentionally omitted: the `people` table
  // always has partner1/partner2 rows, so a count > 0 would fire amber
  // on every wedding. Detecting "has any address" would require a
  // column-presence check we're not wiring for v1.
  { slug: 'wedding-details', finalisationKey: 'wedding_details', dataTable: 'wedding_details' },
  { slug: 'budget',          finalisationKey: 'budget',          dataTable: 'budget_items' },
  { slug: 'timeline',        finalisationKey: 'timeline',        dataTable: 'timeline' },
  { slug: 'ceremony',        finalisationKey: 'ceremony',        dataTable: 'ceremony_order' },
  { slug: 'rehearsal',       finalisationKey: 'rehearsal',       dataTable: 'rehearsal_dinner' },

  // Vendors
  { slug: 'vendors',         finalisationKey: 'vendors',         dataTable: 'booked_vendors' },
  { slug: 'contracts',       finalisationKey: 'contracts',       dataTable: 'contracts' },
  { slug: 'bar',             finalisationKey: 'bar',             dataTable: 'bar_planning' },
  { slug: 'beauty',          finalisationKey: 'beauty',          dataTable: 'makeup_schedule' },
  { slug: 'decor',           finalisationKey: 'decor',           dataTable: 'decor_inventory' },
  { slug: 'photos',          finalisationKey: 'photos',          dataTable: 'photo_library' },
  { slug: 'transportation',  finalisationKey: 'transportation',  dataTable: 'shuttle_schedule' },
  { slug: 'staffing',        finalisationKey: 'staffing',        dataTable: 'staffing_assignments' },

  // Guests
  { slug: 'guests',          finalisationKey: 'guests',          dataTable: 'guest_list' },
  { slug: 'rsvp-settings',   finalisationKey: 'rsvp_settings',   dataTable: 'rsvp_config' },
  { slug: 'party',           finalisationKey: 'wedding_party',   dataTable: 'wedding_party' },
  { slug: 'allergies',       finalisationKey: 'allergies',       dataTable: 'allergy_registry' },
  { slug: 'guest-care',      finalisationKey: 'guest_care',      dataTable: 'guest_care_notes' },
  { slug: 'rooms',           finalisationKey: 'rooms',           dataTable: 'bedroom_assignments' },
  { slug: 'seating',         finalisationKey: 'seating',         dataTable: 'seating_assignments' },
  { slug: 'table-map',       finalisationKey: 'table_map',       dataTable: 'table_map_layouts' },
  { slug: 'tables',          finalisationKey: 'tables',          dataTable: 'wedding_tables' },
  { slug: 'ceremony-chairs', finalisationKey: 'ceremony_chairs', dataTable: 'ceremony_order' },

  // Inspo & Resources
  { slug: 'worksheets',      finalisationKey: 'worksheets',      dataTable: 'wedding_worksheets' },
  { slug: 'venue-inventory', finalisationKey: 'venue_inventory', dataTable: 'borrow_selections' },
  { slug: 'website',         finalisationKey: 'website',         dataTable: 'wedding_website_settings' },
]

const SLUG_TO_DEF = new Map<string, SectionDef>(SECTIONS.map((s) => [s.slug, s]))

export function getSectionDef(slug: string): SectionDef | undefined {
  return SLUG_TO_DEF.get(slug)
}

/**
 * Fetches per-section status for a wedding. Resolves green from
 * section_finalisations, then runs parallel HEAD counts for the
 * remaining sections to detect amber.
 *
 * One HEAD count per amber-candidate section, all in parallel. With
 * indices on wedding_id (which exist on every couple-data table),
 * each is sub-50ms; the bottleneck is round-trip latency, not the DB.
 */
export async function loadSectionStatuses(
  supabase: SupabaseClient,
  weddingId: string
): Promise<Record<string, SectionStatus>> {
  const result: Record<string, SectionStatus> = {}
  if (!weddingId) return result

  // Step 1: pull every row where at least one party signed off.
  // 'confirmed' = both columns true; 'green' = couple only.
  const { data: finalRows } = await supabase
    .from('section_finalisations')
    .select('section_name, couple_signed_off, staff_signed_off')
    .eq('wedding_id', weddingId)
    .or('couple_signed_off.eq.true,staff_signed_off.eq.true')

  const signoffByKey = new Map<string, { couple: boolean; staff: boolean }>()
  for (const row of finalRows ?? []) {
    const r = row as { section_name: string; couple_signed_off: boolean; staff_signed_off: boolean }
    signoffByKey.set(r.section_name, {
      couple: r.couple_signed_off === true,
      staff: r.staff_signed_off === true,
    })
  }

  // Mark every section whose finalisation key has been signed off.
  // Multiple slugs can share the same finalisationKey (rare, but
  // ceremony + ceremony-chairs used to; they now have unique keys).
  for (const def of SECTIONS) {
    const sign = signoffByKey.get(def.finalisationKey)
    if (!sign) continue
    if (sign.couple && sign.staff) result[def.slug] = 'confirmed'
    else if (sign.couple) result[def.slug] = 'green'
    // staff-only with no couple signoff → fall through to amber via
    // the has-data check below. Staff sign-off without couple's
    // agreement isn't an end-state from the couple's POV.
  }

  // Step 2: HEAD-count the remaining sections in parallel. Anything
  // already green/confirmed is skipped.
  const ambercandidates = SECTIONS.filter((s) => !result[s.slug])

  const counts = await Promise.all(
    ambercandidates.map((def) =>
      supabase
        .from(def.dataTable)
        .select('id', { count: 'exact', head: true })
        .eq('wedding_id', weddingId)
        .then((res) => ({ slug: def.slug, count: res.count ?? 0, error: res.error }))
        .then((r) => (r.error ? { slug: r.slug, count: 0 } : r))
    )
  )

  for (const { slug, count } of counts) {
    if (count > 0) result[slug] = 'amber'
  }

  return result
}

/**
 * Coordinator-flagged priorities for a wedding. Overrides the
 * time-aware recommendation when present. Read-only for couples;
 * coordinators write via /api/portal/weddings/[id]/priorities.
 *
 * Returns rows in sort_order (ascending). Empty array if none.
 */
export interface CoordinatorPriority {
  section_slug: string
  sort_order: number
  note: string | null
}

export async function loadCoordinatorPriorities(
  supabase: SupabaseClient,
  weddingId: string
): Promise<CoordinatorPriority[]> {
  if (!weddingId) return []
  const { data } = await supabase
    .from('wedding_priorities')
    .select('section_slug, sort_order, note')
    .eq('wedding_id', weddingId)
    .order('sort_order', { ascending: true })
  return (data ?? []) as CoordinatorPriority[]
}

/**
 * Time-aware "Now" recommendation. Returns the sidebar slugs the
 * couple should focus on at the current days-until-wedding. The
 * sidebar paints a small star next to these items.
 *
 * Conservative: 1-3 items per stage so the star stays meaningful.
 * Coordinator priorities (when present) override this default — see
 * loadCoordinatorPriorities.
 */
export function getRecommendedSectionSlugs(daysUntilWedding: number | null): Set<string> {
  if (daysUntilWedding === null) return new Set()
  if (daysUntilWedding < 0) return new Set(['day-of-memories'])
  if (daysUntilWedding <= 7) return new Set(['day-of', 'timeline', 'transportation'])
  if (daysUntilWedding <= 42) return new Set(['final-review', 'staffing', 'transportation'])
  if (daysUntilWedding <= 90) return new Set(['timeline', 'table-map', 'bar'])
  if (daysUntilWedding <= 180) return new Set(['rsvp-settings', 'photos', 'beauty'])
  if (daysUntilWedding <= 365) return new Set(['vendors', 'contracts', 'budget'])
  return new Set(['wedding-details', 'budget', 'checklist'])
}
