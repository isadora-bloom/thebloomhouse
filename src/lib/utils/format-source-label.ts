/**
 * Source-label formatter (T5-Rixey-UU / Stream UU, Bug E).
 *
 * Why this exists
 * ---------------
 * The leads page (and several other coordinator surfaces) was rendering
 * a mixed bag of source values: some Title-Cased ("The Knot",
 * "Website") via per-page sourceBadge() switches, some bare snake_case
 * leaking straight from the DB ("venue_calculator", "calendly", "other",
 * "direct"). The fix is a single canonical formatter every surface
 * shares.
 *
 * Doctrine
 * --------
 * - The DB enum stays snake_case forever — it's a code, not a label.
 * - Display layers ALWAYS go through formatSourceLabel().
 * - Add new sources to SOURCE_LABEL_OVERRIDES below; everything else
 *   falls through to the snake_case → Title-Case fallback.
 *
 * Note on Calendly / HoneyBook
 * ----------------------------
 * Stream TT is NULLing scheduling-tool sources (calendly, honeybook,
 * acuity, dubsado) on weddings.source because they're not real
 * first-touch values — they're just where the lead happened to land
 * last. We still render those values correctly here in case they show
 * up on historical or audit surfaces.
 */

const SOURCE_LABEL_OVERRIDES: Record<string, string> = {
  // Wedding-listing platforms
  the_knot: 'The Knot',
  wedding_wire: 'WeddingWire',
  weddingwire: 'WeddingWire',
  zola: 'Zola',
  here_comes_the_guide: 'Here Comes The Guide',

  // Web / direct
  website: 'Website',
  web_form: 'Website Form',
  venue_calculator: 'Venue Calculator',

  // Search / ads
  google: 'Google',
  google_business: 'Google Business',
  google_ads: 'Google Ads',

  // Social
  instagram: 'Instagram',
  pinterest: 'Pinterest',
  facebook: 'Facebook',
  reddit: 'Reddit',
  tiktok: 'TikTok',

  // Word-of-mouth / direct
  direct: 'Direct',
  referral: 'Referral',
  word_of_mouth: 'Word of Mouth',
  walk_in: 'Walk-in',
  phone: 'Phone',

  // Scheduling / contracting tools (TT will NULL these on weddings.source,
  // but render correctly until then + on historical surfaces).
  calendly: 'Calendly',
  acuity: 'Acuity',
  honeybook: 'HoneyBook',
  dubsado: 'Dubsado',

  // Catch-all
  other: 'Other',
  unknown: 'Unknown',
}

/**
 * Render a raw weddings.source / lead.source / .source enum value as a
 * human label.
 *
 * - null / undefined / empty → '—'
 * - known override key → mapped label
 * - otherwise → snake_case / kebab-case → Title Case
 */
export function formatSourceLabel(raw: string | null | undefined): string {
  if (!raw) return '—'
  const trimmed = String(raw).trim()
  if (!trimmed) return '—'

  const key = trimmed.toLowerCase()
  if (key in SOURCE_LABEL_OVERRIDES) return SOURCE_LABEL_OVERRIDES[key]!

  // Fallback: snake_case / kebab-case → Title Case.
  return trimmed
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Whether a raw value maps to a known canonical source key. Useful for
 * "did the formatter actually recognise this?" validation surfaces.
 */
export function isKnownSourceKey(raw: string | null | undefined): boolean {
  if (!raw) return false
  return String(raw).trim().toLowerCase() in SOURCE_LABEL_OVERRIDES
}
