/**
 * Which couple-portal pages a venue has switched on, and when they open.
 *
 * The venue edits `portal_section_config` (visibility + release_at) at
 * /portal/section-settings. Until 2026-09-17 the couple sidebar never
 * read it: the nav was a fixed list, so "off" did nothing on the couple
 * side. This maps every couple route to the section it belongs to, so
 * the sidebar and the page gate can both ask one question: is this
 * section open for the couple today?
 */

/** Couple route slug -> portal_section_config.section_key. */
const SLUG_TO_SECTION: Record<string, string> = {
  '': 'dashboard',
  'whats-next': 'dashboard',
  'getting-started': 'getting-started',
  chat: 'chat',
  'wedding-details': 'wedding-details',
  addresses: 'wedding-details',
  'venue-info': 'wedding-details',
  availability: 'wedding-details',
  timeline: 'timeline',
  'day-of': 'timeline',
  budget: 'budget',
  guests: 'guests',
  'rsvp-settings': 'guests',
  seating: 'seating',
  'table-map': 'seating',
  tables: 'seating',
  checklist: 'checklist',
  vendors: 'vendors',
  'preferred-vendors': 'vendors',
  contracts: 'vendors',
  ceremony: 'ceremony',
  'ceremony-chairs': 'ceremony',
  party: 'party',
  beauty: 'beauty',
  transportation: 'transportation',
  rooms: 'rooms',
  rehearsal: 'rehearsal',
  decor: 'decor',
  staffing: 'staffing',
  bar: 'bar',
  allergies: 'allergies',
  'guest-care': 'guest-care',
  inspo: 'inspo',
  photos: 'photos',
  'day-of-memories': 'photos',
  worksheets: 'worksheets',
  'venue-inventory': 'venue-inventory',
  picks: 'venue-inventory',
  stays: 'stays',
  website: 'website',
  'final-review': 'final-review',
  messages: 'messages',
  'couple-photo': 'couple-photo',
  resources: 'resources',
  downloads: 'resources',
  booking: 'booking',
  notes: 'dashboard',
}

/** Pages that are never gated: account, sign-in, privacy, the home page. */
const ALWAYS_OPEN = new Set(['', 'login', 'register', 'forgot-password', 'reset-password', 'privacy', 'notes', 'whats-next'])

export interface OpenSection {
  section_key: string
  label: string
  release_at: string | null
}

export function sectionKeyForSlug(slug: string): string | null {
  return SLUG_TO_SECTION[slug] ?? null
}

/**
 * True when the couple may see this route today. Unknown slugs (a page
 * that has no section entry) stay open, so a new page never vanishes by
 * accident; the venue switches sections off, not routes.
 */
export function isSlugOpen(slug: string, open: OpenSection[] | null, now: Date = new Date()): boolean {
  if (ALWAYS_OPEN.has(slug)) return true
  if (open === null) return true // config not loaded yet: don't flash a gate
  const key = sectionKeyForSlug(slug)
  if (!key) return true
  const row = open.find((s) => s.section_key === key)
  if (!row) return false
  if (row.release_at && new Date(row.release_at) > now) return false
  return true
}

/** The slug is the first path segment after the base: /couple/<venue>/<slug>/... */
export function slugFromPathname(pathname: string, base: string): string {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : pathname
  return rest.split('/').filter(Boolean)[0] ?? ''
}
