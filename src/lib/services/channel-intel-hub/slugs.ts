/**
 * Bloom House — Wave 25 channel slug ↔ platform mapping.
 *
 * Anchor docs:
 *   - feedback_deep_fix_vs_bandaid.md (one deterministic normaliser
 *     across the hub — UI never branches on string variants)
 *
 * attribution_events.source_platform has historical variants ("the_knot"
 * / "theknot" / "theknot.com"). The hub collapses those into a single
 * kebab-case slug ('the-knot') for routing AND back into a single
 * canonical platform key ('the_knot') for queries.
 */

/** Display labels per canonical platform. */
const DISPLAY_LABELS: Record<string, string> = {
  the_knot: 'The Knot',
  weddingwire: 'WeddingWire',
  hctg: 'Here Comes The Guide',
  zola: 'Zola',
  junebug: 'Junebug Weddings',
  brides_com: 'Brides.com',
  carats_cake: "Carats & Cake",
  style_me_pretty: 'Style Me Pretty',
  honeybook: 'HoneyBook',
  calendly: 'Calendly',
  instagram: 'Instagram',
  pinterest: 'Pinterest',
  tiktok: 'TikTok',
  google: 'Google',
  google_ads: 'Google Ads',
  google_business: 'Google Business Profile',
  facebook: 'Facebook',
  ai_tool: 'AI Tools',
  referral: 'Referral',
  vendor: 'Vendor',
  friend: 'Word of Mouth',
  direct: 'Direct',
  website: 'Website',
  unknown: 'Unknown',
}

/**
 * Normalise a raw source_platform string from attribution_events into a
 * canonical key. Same logic as channel-truth/data-loader normalisePlatform
 * but extended to cover more sources for the hub.
 */
export function normalisePlatform(raw: string | null | undefined): string {
  if (!raw) return 'unknown'
  const s = raw.toLowerCase().trim()
  // Strip protocol/domain noise.
  const stripped = s.replace(/^https?:\/\//, '').replace(/\.com$/, '').replace(/\.co$/, '')

  // Knot variants
  if (stripped === 'theknot' || stripped === 'the_knot' || stripped === 'the-knot') return 'the_knot'
  // WW variants
  if (stripped === 'weddingwire' || stripped === 'wedding_wire' || stripped === 'wedding-wire')
    return 'weddingwire'
  // HCTG
  if (stripped === 'hctg' || stripped === 'here_comes_the_guide' || stripped === 'herecomestheguide')
    return 'hctg'
  // Listing aggregators
  if (stripped === 'brides' || stripped === 'brides_com' || stripped === 'brides-com')
    return 'brides_com'
  if (stripped === 'caratscake' || stripped === 'carats_cake' || stripped === 'carats-cake')
    return 'carats_cake'
  if (stripped === 'stylemepretty' || stripped === 'style_me_pretty' || stripped === 'style-me-pretty')
    return 'style_me_pretty'
  // Tools
  if (stripped === 'google_business' || stripped === 'gbp' || stripped === 'google-business-profile')
    return 'google_business'
  if (stripped === 'google_ads' || stripped === 'googleads' || stripped === 'google-ads')
    return 'google_ads'

  // Default — keep as canonical token (snake_case)
  return stripped.replace(/-/g, '_')
}

/** Canonical platform key → URL kebab-case slug. */
export function platformToSlug(platform: string): string {
  return normalisePlatform(platform).replace(/_/g, '-')
}

/** URL slug → canonical platform key. */
export function slugToPlatform(slug: string): string {
  return slug.replace(/-/g, '_').toLowerCase()
}

/** Friendly display label for a platform key. */
export function platformDisplayLabel(platform: string | null | undefined): string {
  const key = normalisePlatform(platform)
  return DISPLAY_LABELS[key] ?? prettifyToken(key)
}

function prettifyToken(token: string): string {
  if (!token) return 'Unknown'
  return token
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Listing platforms whose CAC math is most distorted by broadcast intent.
 * Used as a hint for the comparison page to highlight which channels'
 * Real CAC vs Apparent CAC delta is likely largest.
 */
export const BROADCAST_CAPABLE_PLATFORMS: ReadonlySet<string> = new Set([
  'the_knot',
  'weddingwire',
  'hctg',
  'zola',
  'brides_com',
  'junebug',
])

/**
 * Channels that map to marketing_spend_records.channel for CAC math.
 * Free-text on the spend side, so we use a contains-match heuristic.
 */
export function platformSpendChannelMatch(
  platform: string,
  spendChannel: string | null | undefined,
): boolean {
  if (!spendChannel) return false
  const c = spendChannel.toLowerCase()
  const p = normalisePlatform(platform)
  if (p === 'the_knot') return c.includes('knot')
  if (p === 'weddingwire') return c.includes('weddingwire') || c.includes('wedding_wire')
  if (p === 'hctg') return c.includes('hctg') || c.includes('here_comes_the_guide')
  if (p === 'google_ads') return c.includes('google') && c.includes('ad')
  if (p === 'google_business') return c.includes('google_business') || c.includes('gbp')
  if (p === 'google') return c.includes('google') && !c.includes('ad')
  if (p === 'instagram') return c.includes('instagram') || c.includes('meta')
  if (p === 'facebook') return c.includes('facebook') || c.includes('meta')
  if (p === 'pinterest') return c.includes('pinterest')
  if (p === 'tiktok') return c.includes('tiktok')
  if (p === 'honeybook') return c.includes('honeybook')
  return c.includes(p)
}
