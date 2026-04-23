/**
 * Canonical source enum + normalizeSource() helper.
 *
 * Every write of `weddings.source`, `wedding_touchpoints.source`, and
 * `auto_send_rules.source` funnels through this module so the database never
 * drifts to a form the CHECK constraint won't accept. Without this, the
 * codebase has historically emitted three spellings of WeddingWire
 * ('weddingwire', 'wedding_wire', 'wedding wire'), two of The Knot
 * ('the_knot', 'theknot'), plus free-form CSV input, all colliding with a
 * narrow eight-value CHECK.
 *
 * The canonical list here is the ONLY set the migration 086 CHECK permits.
 * Adding a new source = one entry here + one re-run of migration 086.
 */

export const CANONICAL_SOURCES = [
  'the_knot',
  'wedding_wire',
  'here_comes_the_guide',
  'zola',
  'honeybook',
  'google',
  'google_ads',
  'google_business',
  'instagram',
  'facebook',
  'pinterest',
  'tiktok',
  'venue_calculator',
  'website',
  'direct',
  'referral',
  'walk_in',
  'csv_import',
  'vendor_referral',
  'other',
] as const

export type CanonicalSource = (typeof CANONICAL_SOURCES)[number]

const CANONICAL_SET = new Set<string>(CANONICAL_SOURCES)

/**
 * Alias → canonical. Keys are already lowercased + snake_cased by the time
 * they hit this table (see normalizeSource). Any alias not present falls
 * through to 'other'.
 */
const ALIAS_TO_CANONICAL: Record<string, CanonicalSource> = {
  // The Knot
  the_knot: 'the_knot',
  theknot: 'the_knot',
  knot: 'the_knot',
  the_knot_com: 'the_knot',
  // WeddingWire
  wedding_wire: 'wedding_wire',
  weddingwire: 'wedding_wire',
  ww: 'wedding_wire',
  weddingwire_com: 'wedding_wire',
  // Here Comes The Guide
  here_comes_the_guide: 'here_comes_the_guide',
  hctg: 'here_comes_the_guide',
  herecomestheguide: 'here_comes_the_guide',
  // Zola
  zola: 'zola',
  zola_com: 'zola',
  // HoneyBook
  honeybook: 'honeybook',
  honeybook_com: 'honeybook',
  // Google family
  google: 'google',
  google_search: 'google',
  google_my_business: 'google_business',
  google_business: 'google_business',
  gmb: 'google_business',
  google_ads: 'google_ads',
  googleads: 'google_ads',
  adwords: 'google_ads',
  google_analytics: 'google',
  // Social
  instagram: 'instagram',
  ig: 'instagram',
  insta: 'instagram',
  facebook: 'facebook',
  fb: 'facebook',
  pinterest: 'pinterest',
  pin: 'pinterest',
  tiktok: 'tiktok',
  tik_tok: 'tiktok',
  // Venue-owned
  venue_calculator: 'venue_calculator',
  calculator: 'venue_calculator',
  pricing_calculator: 'venue_calculator',
  interactive_calculator: 'venue_calculator',
  website: 'website',
  our_website: 'website',
  web: 'website',
  site: 'website',
  // Direct / email
  direct: 'direct',
  direct_email: 'direct',
  email: 'direct',
  phone: 'direct',
  call: 'direct',
  // Referral
  referral: 'referral',
  vendor: 'vendor_referral',
  vendor_referral: 'vendor_referral',
  // Walk-in
  walk_in: 'walk_in',
  walkin: 'walk_in',
  // CSV / other
  csv: 'csv_import',
  csv_import: 'csv_import',
  import: 'csv_import',
  manual: 'csv_import',
  other: 'other',
  unknown: 'other',
  null: 'other',
  undefined: 'other',
  '': 'other',
}

/**
 * Normalize a raw source string to a canonical value. Lowercases, replaces
 * whitespace and punctuation with underscores, strips duplicates, and maps
 * through the alias table. Unknown values become 'other' — never a silent
 * CHECK failure.
 *
 * Pass null/undefined to get 'other'. Pass an already-canonical value to get
 * it back unchanged.
 */
export function normalizeSource(raw: string | null | undefined): CanonicalSource {
  if (raw === null || raw === undefined) return 'other'

  const key = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')

  if (CANONICAL_SET.has(key)) return key as CanonicalSource
  if (key in ALIAS_TO_CANONICAL) return ALIAS_TO_CANONICAL[key]
  return 'other'
}

/**
 * Returns true if a string is already a canonical source. Useful for guard
 * clauses at read-sites that don't want to call normalizeSource a second time.
 */
export function isCanonicalSource(v: string | null | undefined): v is CanonicalSource {
  return typeof v === 'string' && CANONICAL_SET.has(v)
}
