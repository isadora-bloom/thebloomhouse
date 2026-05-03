/**
 * Series-label formatter (T5-Rixey-YY / Stream YY, Z3).
 *
 * Why this exists
 * ---------------
 * The correlation engine + narration surface render channel ids
 * (`fred_CPIAUCSL`, `the_knot_signals`, `inquiries`) directly into
 * card titles + bodies. Two prior helpers (humanChannel in
 * correlation-engine.ts and a duplicate in correlation-narration.ts)
 * each formatted them differently — Stream YY caught labels like
 * "S&P 500" rendered properly cased alongside "30y mortgage rate" /
 * "unemployment rate" / "consumer sentiment" in lowercase.
 *
 * Doctrine
 * --------
 * - The internal channel key stays snake_case forever — it's the
 *   correlation engine's join key, not a label.
 * - Display layers (titles, bodies, list rows) ALWAYS go through
 *   formatSeriesLabel().
 * - Add new channels to SERIES_LABELS below; everything else falls
 *   through to a Title-Case fallback that also handles known platform
 *   names (The Knot, WeddingWire, etc.).
 *
 * Companion to formatSourceLabel (Stream UU). That one normalises
 * weddings.source enum values; this one normalises correlation-engine
 * channel ids. They overlap on platform names but the input domains
 * are disjoint.
 */

const SERIES_LABELS: Record<string, string> = {
  // FRED macro indicators — match the Bloomberg/CNBC presentation that
  // coordinators are most likely to recognise.
  fred_CPIAUCSL: 'CPI (Inflation)',
  fred_MORTGAGE30US: '30-Year Mortgage Rate',
  fred_SP500: 'S&P 500',
  fred_UNRATE: 'Unemployment Rate',
  fred_UMCSENT: 'Consumer Sentiment',

  // Internal venue series — the engine writes one row per inquiry,
  // tour event, booking. Coordinator-readable names.
  inquiries: 'Inquiries',
  tours_scheduled: 'Tours Scheduled',
  tours_completed: 'Tours Completed',
  bookings: 'Bookings',

  // Tangential signals (`{platform}_signals`). The fallback handles
  // unknown platforms; these are the explicit overrides for the ones
  // we know coordinators care about.
  the_knot_signals: 'The Knot Storefront Activity',
  wedding_wire_signals: 'WeddingWire Storefront Activity',
  weddingwire_signals: 'WeddingWire Storefront Activity',
  zola_signals: 'Zola Storefront Activity',
  here_comes_the_guide_signals: 'Here Comes The Guide Activity',
  pinterest_signals: 'Pinterest Activity',
  instagram_signals: 'Instagram Activity',
  facebook_signals: 'Facebook Activity',
  tiktok_signals: 'TikTok Activity',
  reddit_signals: 'Reddit Activity',
  google_signals: 'Google Search Activity',
  google_business_signals: 'Google Business Activity',
  google_ads_signals: 'Google Ads Activity',
  website_signals: 'Website Activity',
  website_form_signals: 'Website Form Submissions',
  web_form_signals: 'Website Form Submissions',
  honeybook_signals: 'HoneyBook Activity',
  calendly_signals: 'Calendly Activity',
  other_signals: 'Other Source Activity',

  // Cultural moments (single channel — venue-confirmed cultural events
  // queue from /intel/cultural-moments).
  cultural_moments: 'Cultural Moments',
}

/**
 * Platform-name corrections applied when neither the override map nor
 * a known prefix matches. Catches unmapped marketing_metric channels of
 * shape `{source}_{metric}` (e.g. `the_knot_profile_views`).
 */
const PLATFORM_CASING: Array<[RegExp, string]> = [
  [/\bthe knot\b/i, 'The Knot'],
  [/\bwedding wire\b/i, 'WeddingWire'],
  [/\bweddingwire\b/i, 'WeddingWire'],
  [/\binstagram\b/i, 'Instagram'],
  [/\bfacebook\b/i, 'Facebook'],
  [/\bpinterest\b/i, 'Pinterest'],
  [/\btiktok\b/i, 'TikTok'],
  [/\breddit\b/i, 'Reddit'],
  [/\bzola\b/i, 'Zola'],
  [/\bgoogle analytics\b/i, 'Google Analytics'],
  [/\bgoogle business\b/i, 'Google Business'],
  [/\bgoogle ads\b/i, 'Google Ads'],
  [/\bgoogle\b/i, 'Google'],
  [/\bhoneybook\b/i, 'HoneyBook'],
  [/\bcalendly\b/i, 'Calendly'],
  [/\bacuity\b/i, 'Acuity'],
  [/\bdubsado\b/i, 'Dubsado'],
]

/**
 * Render a raw correlation-engine channel id as a coordinator-readable
 * label.
 *
 * - null / undefined / empty → '—'
 * - known override key → mapped label
 * - `fred_<id>` → 'FRED <id>' fallback for unmapped FRED series
 * - `calendar_<category>` → '<category> (calendar)'
 * - otherwise → snake_case → Title Case with platform-name corrections
 */
export function formatSeriesLabel(raw: string | null | undefined): string {
  if (!raw) return '—'
  const trimmed = String(raw).trim()
  if (!trimmed) return '—'

  if (trimmed in SERIES_LABELS) return SERIES_LABELS[trimmed]!

  // FRED fallback — engine may add new series IDs before this map
  // catches up.
  if (trimmed.startsWith('fred_')) {
    const id = trimmed.slice('fred_'.length)
    return `FRED ${id}`
  }

  // Calendar series — `calendar_<category>` of dynamic shape (us /
  // us_<state> / us_<state>_<metro>).
  if (trimmed.startsWith('calendar_')) {
    const cat = trimmed.slice('calendar_'.length).replace(/_/g, ' ')
    return `${cat} (calendar)`
  }

  // Title-case fallback with platform-name corrections.
  const titled = trimmed
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')

  let corrected = titled
  for (const [pattern, replacement] of PLATFORM_CASING) {
    corrected = corrected.replace(pattern, replacement)
  }
  return corrected
}

/**
 * Signal-class taxonomy (Stream YY, Z1). Used by the correlation
 * engine to rank insights for surfacing AND by the UI filter (Z4).
 *
 * - macro: FRED indicators (CPI, mortgage, S&P 500, unemployment,
 *   consumer sentiment) and the calendar/cultural-moment channels
 *   that operate as exogenous market signals.
 * - venue: internal venue series the venue itself produces — inquiries,
 *   tours, bookings, marketing-metric exports the venue uploaded.
 * - social: tangential_signals from social platforms (Pinterest, IG,
 *   FB, TikTok, Reddit). Distinct from `venue` because their lead-time
 *   profile is faster (viral) and their causal direction with respect
 *   to macro is downstream.
 */
export type SignalClass = 'macro' | 'venue' | 'social'

const SOCIAL_PLATFORMS = new Set([
  'pinterest',
  'instagram',
  'facebook',
  'tiktok',
  'reddit',
  'youtube',
])

/**
 * Classify a correlation-engine channel id into the signal-class
 * taxonomy. Keep in sync with the engine's buildSeries channel naming.
 */
export function classifySeries(raw: string | null | undefined): SignalClass {
  if (!raw) return 'venue'
  const trimmed = String(raw).trim().toLowerCase()
  if (!trimmed) return 'venue'

  // External Context channels — all macro.
  if (trimmed.startsWith('fred_')) return 'macro'
  if (trimmed.startsWith('calendar_')) return 'macro'
  if (trimmed === 'cultural_moments') return 'macro'

  // tangential_signals: `{platform}_signals`. Social platforms get
  // their own class; others (the_knot_signals, website_signals,
  // honeybook_signals, etc.) are venue-internal.
  if (trimmed.endsWith('_signals')) {
    const platform = trimmed.slice(0, -'_signals'.length)
    if (SOCIAL_PLATFORMS.has(platform)) return 'social'
    return 'venue'
  }

  // Everything else (inquiries, tours, bookings, marketing_metric
  // `{source}_{metric}` channels) is venue-internal.
  return 'venue'
}

/**
 * Pair-class taxonomy. Combines the two channels' signal-classes into
 * the canonical pair label the engine uses for ranking + UI filtering.
 *
 * Order-independent: macro × venue and venue × macro both return
 * 'macro_x_venue'.
 */
export type PairClass =
  | 'macro_x_macro'
  | 'macro_x_venue'
  | 'macro_x_social'
  | 'venue_x_venue'
  | 'venue_x_social'
  | 'social_x_social'

export function classifyPair(
  a: string | null | undefined,
  b: string | null | undefined,
): PairClass {
  const ca = classifySeries(a)
  const cb = classifySeries(b)
  // Sorted alphabetic so the pair-class is order-independent.
  const [first, second] = [ca, cb].sort() as [SignalClass, SignalClass]
  return `${first}_x_${second}` as PairClass
}

/**
 * Per-pair-class rank multiplier (Stream YY, Z1). Multiplied against
 * |r| × 100 to produce intelligence_insights.surface_priority.
 *
 * - macro × macro → 0.4 (sink — coordinators don't act on these,
 *   though we still surface them for the economically-curious)
 * - macro × venue → 1.5 (boost — Bloom's USP signal)
 * - social × venue → 1.3 (boost — viral leading indicator)
 * - venue × venue → 1.2 (modest boost — internal funnel insight)
 * - macro × social → 1.0 (neutral — directional but downstream)
 * - social × social → 1.0 (neutral)
 */
export function rankMultiplierForPair(pair: PairClass): number {
  switch (pair) {
    case 'macro_x_macro': return 0.4
    case 'macro_x_venue': return 1.5
    case 'venue_x_social': return 1.3
    case 'venue_x_venue': return 1.2
    case 'macro_x_social': return 1.0
    case 'social_x_social': return 1.0
    default: return 1.0
  }
}

/**
 * Class-aware lag set (Stream YY, Z5). Different cross-channel
 * relationships have different propagation timescales:
 *
 * - macro × macro: Fed transmission timescales — months, not days.
 * - macro × venue: slow consumer behaviour — mortgage rate change
 *   takes months to show up in inquiry volume.
 * - venue × social: viral / fast — Pinterest spike → inquiry within
 *   days, not months.
 * - venue × venue: funnel timescales — inquiry → tour → booking.
 *
 * Pre-Stream-YY the engine used a fixed `[0, 3, 5, 7, 14]` for every
 * pair, which meant macro relationships got reported at 14d lag (the
 * largest in the set) — incorrect for the Rixey "mortgage rate
 * affects wedding inquiries" demo.
 */
export function lagsForPair(pair: PairClass): number[] {
  switch (pair) {
    case 'macro_x_macro':
      return [0, 30, 60, 90]
    case 'macro_x_venue':
      return [0, 30, 60, 90, 180]
    case 'macro_x_social':
      return [0, 30, 60, 90]
    case 'venue_x_social':
      return [0, 7, 14, 30]
    case 'social_x_social':
      return [0, 7, 14, 30]
    case 'venue_x_venue':
      return [0, 7, 14, 30]
    default:
      return [0, 7, 14, 30]
  }
}
