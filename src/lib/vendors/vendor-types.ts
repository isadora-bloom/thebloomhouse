/**
 * One vocabulary for vendor categories and vendor attributes.
 *
 * Why this file exists: the couple-facing `/preferred-vendors` page kept
 * its own `Record<string, {label, color}>` keyed on exact lowercase
 * strings, and the staff editor at `/portal/vendors` wrote Title Case
 * ones from a hardcoded array. Neither knew about the other. On
 * 2026-09-17 the live table held 28 rows across 4 venues using
 * `photography` and `photographer`, `florals` and `florist`, `catering`
 * and `caterer`, plus `cake`, `music`, `videography` and `bartender` —
 * and 13 of the 28 rendered to couples as "Other", in an "Other" pill
 * sitting next to the correctly-labelled one. Category filtering was
 * filtering on dirt.
 *
 * So: canonical keys here, synonyms folded in here, labels and colours
 * here, and both surfaces read this. Migration 417 folds the existing
 * rows onto the canonical keys and stops the staff editor writing new
 * spellings.
 *
 * The lockdown that matters is `vendorTypeLabel`: an unrecognised value
 * is humanised from its own text rather than collapsed into "Other", so
 * the next spelling nobody predicted still reads as itself.
 */

export interface VendorTypeConfig {
  label: string
  /** Hex, used for the pill and the category dot on the couple page. */
  color: string
}

/**
 * The canonical categories. Keys are lowercase snake_case and are what
 * gets written to `vendor_recommendations.vendor_type`.
 *
 * `music` sits alongside `dj` and `band` on purpose. A venue that typed
 * "music" did not tell us which one it meant, and guessing would put a
 * string quartet under a disco ball.
 */
export const VENDOR_TYPES: Record<string, VendorTypeConfig> = {
  photographer: { label: 'Photographer', color: '#5D7A7A' },
  videographer: { label: 'Videographer', color: '#7D8471' },
  florist: { label: 'Florist', color: '#B8908A' },
  dj: { label: 'DJ', color: '#A6894A' },
  band: { label: 'Band', color: '#8B6914' },
  music: { label: 'Music', color: '#9A7B4F' },
  caterer: { label: 'Caterer', color: '#2D8A4E' },
  baker: { label: 'Cake / Bakery', color: '#D97706' },
  bartender: { label: 'Bar / Bartending', color: '#0E7490' },
  officiant: { label: 'Officiant', color: '#6B7280' },
  planner: { label: 'Planner', color: '#3B82F6' },
  rentals: { label: 'Rentals / Decor', color: '#7C3AED' },
  hair_makeup: { label: 'Hair & Makeup', color: '#EC4899' },
  transportation: { label: 'Transportation', color: '#0891B2' },
  lighting: { label: 'Lighting', color: '#F59E0B' },
  stationery: { label: 'Stationery', color: '#6366F1' },
  other: { label: 'Other', color: '#9CA3AF' },
}

/** Canonical keys in the order the staff editor should offer them. */
export const VENDOR_TYPE_KEYS = Object.keys(VENDOR_TYPES)

/**
 * Spellings seen in the wild, or plainly the same trade under another
 * name, mapped onto a canonical key.
 *
 * Only unambiguous folds belong here. `sound` and `av` are absent
 * because neither is obviously lighting, and a wrong fold is worse than
 * an unrecognised value now that unrecognised values label themselves.
 */
const VENDOR_TYPE_SYNONYMS: Record<string, string> = {
  // photography
  photography: 'photographer',
  photo: 'photographer',
  photos: 'photographer',
  // video
  videography: 'videographer',
  video: 'videographer',
  cinematographer: 'videographer',
  cinematography: 'videographer',
  // flowers
  florals: 'florist',
  floral: 'florist',
  flowers: 'florist',
  florists: 'florist',
  // food
  catering: 'caterer',
  caterers: 'caterer',
  food: 'caterer',
  food_truck: 'caterer',
  // cake
  cake: 'baker',
  cakes: 'baker',
  bakery: 'baker',
  baking: 'baker',
  desserts: 'baker',
  dessert: 'baker',
  // bar
  bar: 'bartender',
  bartending: 'bartender',
  bartenders: 'bartender',
  bar_service: 'bartender',
  // music (kept distinct from dj / band)
  live_music: 'music',
  musician: 'music',
  musicians: 'music',
  ceremony_music: 'music',
  // beauty
  hair: 'hair_makeup',
  makeup: 'hair_makeup',
  hair_and_makeup: 'hair_makeup',
  hmua: 'hair_makeup',
  beauty: 'hair_makeup',
  // planning
  coordinator: 'planner',
  planning: 'planner',
  day_of_coordinator: 'planner',
  wedding_planner: 'planner',
  // hire
  rental: 'rentals',
  decor: 'rentals',
  furniture: 'rentals',
  // paper
  stationer: 'stationery',
  stationary: 'stationery',
  invitations: 'stationery',
  // wheels
  transport: 'transportation',
  shuttle: 'transportation',
  limo: 'transportation',
  // words
  celebrant: 'officiant',
  minister: 'officiant',
  uplighting: 'lighting',
}

/** Lowercase, collapse separators, so `Hair & Makeup` meets `hair_makeup`. */
function slugifyType(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/&/g, '_')
    .replace(/[\s\-/]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/**
 * Fold a stored `vendor_type` onto its canonical key.
 *
 * An unrecognised value comes back slugified rather than as `other`, so
 * grouping and filtering still treat it as its own category and
 * `vendorTypeLabel` can show it by name. Empty input is `other`.
 */
export function normaliseVendorType(raw: string | null | undefined): string {
  if (!raw) return 'other'
  const slug = slugifyType(raw)
  if (!slug) return 'other'
  if (slug in VENDOR_TYPES) return slug
  const folded = VENDOR_TYPE_SYNONYMS[slug]
  if (folded) return folded
  // Handle a trailing plural of a canonical key (`officiants`).
  if (slug.endsWith('s') && slug.slice(0, -1) in VENDOR_TYPES) return slug.slice(0, -1)
  return slug
}

/** Title Case a slug for display: `food_truck` → `Food Truck`. */
function humaniseType(slug: string): string {
  return slug
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * What a couple should see for this category. Canonical keys get their
 * curated label; anything else gets its own text back, never "Other".
 */
export function vendorTypeLabel(raw: string | null | undefined): string {
  const key = normaliseVendorType(raw)
  return VENDOR_TYPES[key]?.label ?? humaniseType(key)
}

/** Pill / dot colour. Unrecognised categories get the neutral grey. */
export function vendorTypeColor(raw: string | null | undefined): string {
  const key = normaliseVendorType(raw)
  return VENDOR_TYPES[key]?.color ?? VENDOR_TYPES.other.color
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/**
 * The facts a venue can record about a vendor, ported from the Rixey
 * portal's `TOGGLES` (`src/components/PreferredVendors.jsx`).
 *
 * Rixey's fourth toggle was "3+ Rixey weddings", labelled "Rixey
 * veteran" on the card. Bloom serves any venue, so the wording is
 * venue-agnostic while the column name stays `has_multiple_events` for
 * when the standalone vendor network merges in.
 *
 * `special_offer` is not a flag. It is a question about another column,
 * so it carries its own test the way Rixey's did.
 */
export interface VendorAttributeSource {
  is_local?: boolean | null
  is_budget_friendly?: boolean | null
  has_multiple_events?: boolean | null
  special_offer?: string | null
  offer_expires_at?: string | null
}

export interface VendorAttribute {
  /** Column name, or `special_offer` for the derived one. */
  key: string
  /** Wording on the filter toggle. */
  filterLabel: string
  /** Wording on the card badge. Null means it shows no badge. */
  badgeLabel: string | null
  /** Tailwind classes for the badge. */
  badgeClass: string
  /** True when this vendor has the attribute. */
  test: (v: VendorAttributeSource) => boolean
}

/**
 * A special offer only counts while it has not expired.
 *
 * `offer_expires_at` is a `date` column, so it names a calendar day and
 * not an instant, and it is compared as one. The page used to do
 * `new Date(offer_expires_at) >= new Date()`, which parses a bare
 * `2026-09-17` as midnight UTC and compares it against the moment of
 * rendering: the offer went dark part-way through its last day, or the
 * whole of it, depending on which side of UTC the couple was sitting.
 * Lexicographic comparison of two YYYY-MM-DD strings has no such seam.
 */
export function hasLiveOffer(v: VendorAttributeSource): boolean {
  if (!v.special_offer) return false
  if (!v.offer_expires_at) return true

  const expiresOn = v.offer_expires_at.slice(0, 10)
  // An expiry we cannot read should not silently retire a live offer;
  // the venue typed something, so show it and let them correct it.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return true

  const now = new Date()
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')

  // Runs through the end of the named day.
  return expiresOn >= today
}

export const VENDOR_ATTRIBUTES: VendorAttribute[] = [
  {
    key: 'special_offer',
    filterLabel: 'Offer for couples',
    badgeLabel: null,
    badgeClass: 'bg-amber-100 text-amber-700',
    test: hasLiveOffer,
  },
  {
    key: 'is_local',
    filterLabel: 'Local',
    badgeLabel: 'Local',
    badgeClass: 'bg-blue-100 text-blue-700',
    test: (v) => v.is_local === true,
  },
  {
    key: 'is_budget_friendly',
    filterLabel: 'Budget-friendly',
    badgeLabel: 'Budget-friendly',
    badgeClass: 'bg-green-100 text-green-700',
    test: (v) => v.is_budget_friendly === true,
  },
  {
    key: 'has_multiple_events',
    filterLabel: 'Has worked here before',
    badgeLabel: 'Knows the venue',
    badgeClass: 'bg-purple-100 text-purple-700',
    test: (v) => v.has_multiple_events === true,
  },
]
