/**
 * Source-label formatter (T5-Rixey-UU / Stream UU, Bug E +
 * T5-Rixey-VV / Stream VV, Y6 Untracked rollup +
 * T5-Rixey-DDD / Stream DDD, Bug 5 root-fix).
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
 * Stream DDD root-fix
 * -------------------
 * Stream VV introduced UNTRACKED_LABEL = 'Untracked / Pre-Bloom' for
 * the Source Quality scorecard and a handful of /intel/sources panels,
 * but the lead-detail page still rendered "Unknown" for null sources
 * because formatSourceLabel returned '—' for null and SourceBadgeEditable
 * pulled that label through verbatim. Stream DDD hoists the substitution
 * INTO formatSourceLabel itself so every surface — current and future —
 * automatically renders 'Untracked / Pre-Bloom' instead of '—' or
 * 'Unknown' or raw nulls. The /intel/sources page-local helper was
 * removed in favour of importing UNTRACKED_LABEL + isUntrackedKey from
 * here (single source of truth).
 *
 * Doctrine
 * --------
 * - The DB enum stays snake_case forever — it's a code, not a label.
 * - Display layers ALWAYS go through formatSourceLabel().
 * - Add new sources to SOURCE_LABEL_OVERRIDES below; everything else
 *   falls through to the snake_case → Title-Case fallback.
 * - null / empty / 'unknown' / '(unknown)' all render as
 *   UNTRACKED_LABEL — they're the same architectural bucket
 *   (bookings whose original inquiry email predates Gmail OAuth or
 *   whose source never resolved).
 *
 * Note on Calendly / HoneyBook
 * ----------------------------
 * Stream TT is NULLing scheduling-tool sources (calendly, honeybook,
 * acuity, dubsado) on weddings.source because they're not real
 * first-touch values — they're just where the lead happened to land
 * last. We still render those values correctly here in case they show
 * up on historical or audit surfaces.
 */

/**
 * Display label for sources that resolve to "no real attribution":
 * null, empty string, 'unknown', '(unknown)'. The label surfaces the
 * actionable framing (run a Gmail backfill, re-attribute scheduling
 * tools) rather than the blank "Unknown" — those leads pre-date our
 * lead-side data capture and are recoverable, not unknowable.
 */
export const UNTRACKED_LABEL = 'Untracked / Pre-Bloom'

/**
 * Tooltip for the Untracked bucket. Use on any surface that renders
 * UNTRACKED_LABEL where there's room for a tooltip — coordinators
 * routinely ask "what does Untracked mean?" and the tooltip points
 * them at the recovery actions.
 */
export const UNTRACKED_TOOLTIP =
  "These bookings completed before we had lead-side data (Calendly Q7, web-form, or backfilled Gmail). Run a Gmail historical backfill or click 'Re-attribute Scheduling-Tool Bookings' to try to attribute."

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
}

/**
 * Whether a raw source value should be treated as Untracked (no real
 * attribution captured). Returns true for null / undefined / empty /
 * 'unknown' / '(unknown)'. Stream DDD: hoisted out of /intel/sources
 * page-local code so every render site shares the rule.
 */
export function isUntrackedKey(raw: string | null | undefined): boolean {
  if (!raw) return true
  const k = String(raw).trim().toLowerCase()
  return k === '' || k === 'unknown' || k === '(unknown)'
}

/**
 * Render a raw weddings.source / lead.source / .source enum value as a
 * human label.
 *
 * - null / undefined / empty / 'unknown' / '(unknown)' → UNTRACKED_LABEL
 * - known override key → mapped label
 * - otherwise → snake_case / kebab-case → Title Case
 *
 * Stream DDD: previously returned '—' for null/empty. That fallback
 * leaked as "—" on the leads page and "Unknown" on lead-detail (via
 * SourceBadgeEditable's null branch which read formatSourceLabel(null)).
 * Both surfaces now show the unified "Untracked / Pre-Bloom" label
 * with no caller changes.
 */
export function formatSourceLabel(raw: string | null | undefined): string {
  if (isUntrackedKey(raw)) return UNTRACKED_LABEL
  // isUntrackedKey already handled null/empty so raw is non-empty here.
  const trimmed = String(raw).trim()
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
