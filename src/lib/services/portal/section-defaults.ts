import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The portal sections a venue starts with.
 *
 * `portal_section_config` (migration 013) drives two coordinator
 * surfaces: /portal/section-settings, where visibility is set per
 * section, and the wedding portal preview, which renders one accordion
 * per configured section. Neither surface has a fallback, and until
 * 2026-09-15 nothing in the application ever inserted a row: the only
 * writer was supabase/seed-portal-sections.sql, for the four demo
 * venues. Every real venue therefore opened both pages to an empty
 * state, and the coordinator could not configure sections because there
 * were none to configure (§26 on Ashcombe Barn found it).
 *
 * This list is that seed file, in code, as the single source of the
 * defaults. Migration 416 backfills existing venues from the same
 * values; `ensurePortalSectionConfig` does it for a venue at read time,
 * so a venue created after the migration gets its rows on first touch.
 */
export interface DefaultPortalSection {
  section_key: string
  label: string
  description: string
  visibility: 'both' | 'admin_only' | 'off'
  sort_order: number
  icon: string
}

export const DEFAULT_PORTAL_SECTIONS: readonly DefaultPortalSection[] = [
  { section_key: 'dashboard', label: 'Dashboard', description: 'Overview of wedding progress and key dates', visibility: 'both', sort_order: 1, icon: 'LayoutDashboard' },
  { section_key: 'getting-started', label: 'Getting Started', description: 'Welcome guide and first steps for your planning', visibility: 'both', sort_order: 2, icon: 'Rocket' },
  { section_key: 'chat', label: 'Chat with Sage', description: 'Talk to your AI wedding planning assistant', visibility: 'both', sort_order: 3, icon: 'MessageCircle' },
  { section_key: 'wedding-details', label: 'Wedding Details', description: 'Core wedding info — date, colors, theme', visibility: 'both', sort_order: 4, icon: 'Heart' },
  { section_key: 'timeline', label: 'Timeline', description: 'Wedding day schedule and planning milestones', visibility: 'both', sort_order: 5, icon: 'Clock' },
  { section_key: 'budget', label: 'Budget', description: 'Track estimated vs actual costs', visibility: 'both', sort_order: 6, icon: 'DollarSign' },
  { section_key: 'guests', label: 'Guest List & RSVP', description: 'Manage guest list, meal choices, and RSVPs', visibility: 'both', sort_order: 7, icon: 'Users' },
  { section_key: 'seating', label: 'Seating Chart', description: 'Assign guests to tables and manage layout', visibility: 'both', sort_order: 8, icon: 'Armchair' },
  { section_key: 'checklist', label: 'Planning Checklist', description: 'Track tasks and milestones', visibility: 'both', sort_order: 9, icon: 'CheckSquare' },
  { section_key: 'vendors', label: 'Vendors & Contracts', description: 'Preferred vendors, contacts, and contracts', visibility: 'both', sort_order: 10, icon: 'Store' },
  { section_key: 'ceremony', label: 'Ceremony Order', description: 'Processional, readings, vows, and recessional', visibility: 'both', sort_order: 11, icon: 'BookOpen' },
  { section_key: 'party', label: 'Wedding Party', description: 'Bridal party, groomsmen, and roles', visibility: 'both', sort_order: 12, icon: 'UsersRound' },
  { section_key: 'beauty', label: 'Hair & Makeup', description: 'Beauty appointments and schedule', visibility: 'both', sort_order: 13, icon: 'Sparkles' },
  { section_key: 'transportation', label: 'Transportation', description: 'Shuttles, limos, and parking logistics', visibility: 'both', sort_order: 14, icon: 'Car' },
  { section_key: 'rooms', label: 'Room Assignments', description: 'Internal room and space assignments', visibility: 'admin_only', sort_order: 15, icon: 'DoorOpen' },
  { section_key: 'rehearsal', label: 'Rehearsal Dinner', description: 'Rehearsal dinner details and attendees', visibility: 'both', sort_order: 16, icon: 'UtensilsCrossed' },
  { section_key: 'decor', label: 'Decor Inventory', description: 'Track decor items, rentals, and setup notes', visibility: 'both', sort_order: 17, icon: 'Flower2' },
  { section_key: 'staffing', label: 'Staffing', description: 'Internal staffing assignments and schedules', visibility: 'admin_only', sort_order: 18, icon: 'HardHat' },
  { section_key: 'bar', label: 'Bar Planning', description: 'Drink menu, quantities, and bar setup', visibility: 'both', sort_order: 19, icon: 'Wine' },
  { section_key: 'allergies', label: 'Allergy Registry', description: 'Dietary restrictions and allergy tracking', visibility: 'both', sort_order: 20, icon: 'ShieldAlert' },
  { section_key: 'guest-care', label: 'Guest Care Notes', description: 'Internal notes about guest needs', visibility: 'admin_only', sort_order: 21, icon: 'HeartHandshake' },
  { section_key: 'inspo', label: 'Inspiration Gallery', description: 'Mood boards and design inspiration', visibility: 'both', sort_order: 22, icon: 'Lightbulb' },
  { section_key: 'photos', label: 'Photo Library', description: 'Upload and organize wedding photos', visibility: 'both', sort_order: 23, icon: 'Camera' },
  { section_key: 'worksheets', label: 'Planning Worksheets', description: 'Printable worksheets and planning templates', visibility: 'both', sort_order: 24, icon: 'FileText' },
  { section_key: 'venue-inventory', label: 'Venue Inventory', description: 'What the venue provides — tables, linens, etc.', visibility: 'both', sort_order: 25, icon: 'Package' },
  { section_key: 'stays', label: 'Accommodations', description: 'On-site and nearby lodging options', visibility: 'both', sort_order: 26, icon: 'Bed' },
  { section_key: 'website', label: 'Wedding Website', description: 'Build and customize your wedding website', visibility: 'both', sort_order: 27, icon: 'Globe' },
  { section_key: 'final-review', label: 'Final Review', description: 'Pre-wedding final walkthrough and confirmations', visibility: 'both', sort_order: 28, icon: 'ClipboardCheck' },
  { section_key: 'messages', label: 'Direct Messages', description: 'Message your coordinator directly', visibility: 'both', sort_order: 29, icon: 'MessagesSquare' },
  { section_key: 'couple-photo', label: 'Couple Photo', description: 'Upload your couple photo for the portal', visibility: 'both', sort_order: 30, icon: 'ImagePlus' },
  { section_key: 'resources', label: 'Resources & Downloads', description: 'Downloadable guides, checklists, and documents', visibility: 'both', sort_order: 31, icon: 'Download' },
  { section_key: 'booking', label: 'Book a Meeting', description: 'Schedule a call or tour with your coordinator', visibility: 'both', sort_order: 32, icon: 'CalendarPlus' },
]

/**
 * Give a venue its default section rows if it has none. Idempotent and
 * cheap: one count, and an insert only on the first touch. The unique
 * key (venue_id, section_key) makes a concurrent first touch harmless.
 * Returns the number of rows written.
 */
export async function ensurePortalSectionConfig(
  supabase: SupabaseClient,
  venueId: string,
): Promise<number> {
  const { count, error: countErr } = await supabase
    .from('portal_section_config')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  if (countErr) throw countErr
  if ((count ?? 0) > 0) return 0

  const rows = DEFAULT_PORTAL_SECTIONS.map((s) => ({ venue_id: venueId, ...s }))
  const { error } = await supabase
    .from('portal_section_config')
    .upsert(rows, { onConflict: 'venue_id,section_key', ignoreDuplicates: true })
  if (error) throw error
  return rows.length
}
