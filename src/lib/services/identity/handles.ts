/**
 * Handle normalisation. One rule for every platform so a handle pasted
 * from a followers list, typed on the inquiry form, or parsed from a
 * profile URL all compare equal. Wave 3, HANDLE-IDENTITY-SPEC.md.
 *
 *   "@Rosie.Hoyle"                       -> "rosie.hoyle"
 *   "https://instagram.com/rosie.hoyle/" -> "rosie.hoyle"
 *   "instagram.com/rosie.hoyle?igsh=abc" -> "rosie.hoyle"
 *   "  "                                 -> null
 *
 * Platform rules are deliberately small. Instagram and TikTok allow
 * letters, digits, underscore and dot; Twitter allows letters, digits and
 * underscore; Pinterest and Facebook are letters, digits, dot and dash.
 * Anything else, including whitespace inside the handle, is rejected.
 * A rejected handle returns null so a caller never stores junk.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HandlePlatform } from './sources/types'

const PROFILE_HOSTS: Record<HandlePlatform, string[]> = {
  instagram: ['instagram.com', 'www.instagram.com'],
  tiktok: ['tiktok.com', 'www.tiktok.com'],
  facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com'],
  pinterest: ['pinterest.com', 'www.pinterest.com', 'pin.it'],
  twitter: ['twitter.com', 'x.com', 'www.twitter.com', 'www.x.com'],
  knot: ['theknot.com', 'www.theknot.com'],
  weddingwire: ['weddingwire.com', 'www.weddingwire.com'],
  zola: ['zola.com', 'www.zola.com'],
}

const SHAPE: Record<HandlePlatform, RegExp> = {
  instagram: /^[a-z0-9._]{1,30}$/,
  tiktok: /^[a-z0-9._]{1,24}$/,
  facebook: /^[a-z0-9.-]{1,50}$/,
  pinterest: /^[a-z0-9.-]{1,30}$/,
  twitter: /^[a-z0-9_]{1,15}$/,
  knot: /^[a-z0-9._-]{1,64}$/,
  weddingwire: /^[a-z0-9._-]{1,64}$/,
  zola: /^[a-z0-9._-]{1,64}$/,
}

/** Path segments that are pages, not people. A profile URL parse that
 *  lands on one of these is not a handle (W29 finding, 2026-09-11). */
const RESERVED_SEGMENTS = new Set([
  'p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'tv',
  'marketplace', 'sharer', 'share', 'profile.php', 'groups', 'events', 'pages',
  'photo', 'photos', 'watch', 'video', 'videos', 'hashtag', 'tag', 'tags',
  'pin', 'search', 'login', 'signup', 'help', 'about', 'legal', 'privacy',
  'terms', 'home', 'i', 'intent', 'status', 'discover', 'foryou', 'music',
  'vendors', 'wedding-vendors', 'registry', 'wedding-planning', 'expert-advice',
])

/** Normalise one handle for one platform. Null when empty, malformed, an
 *  unknown platform, or a reserved page segment. Never throws. */
export function normalizeHandle(platform: HandlePlatform, raw: string | null | undefined): string | null {
  if (!raw) return null
  if (!(platform in SHAPE)) return null
  let h = raw.trim().toLowerCase()
  if (!h) return null

  // Profile URL → path segment. Accept with or without scheme.
  const urlish = /^(?:https?:\/\/)?([a-z0-9.-]+)\/([^/?#]+)/.exec(h)
  if (urlish && PROFILE_HOSTS[platform].includes(urlish[1])) {
    h = urlish[2]
    // TikTok profile paths carry the @ in the URL.
    if (h.startsWith('@')) h = h.slice(1)
  }

  if (h.startsWith('@')) h = h.slice(1)
  h = h.replace(/\/+$/, '')
  if (RESERVED_SEGMENTS.has(h)) return null
  return SHAPE[platform].test(h) ? h : null
}

/** Normalise a whole map, dropping empties and malformed entries. */
export function normalizeHandles(
  input: Partial<Record<HandlePlatform, string | null | undefined>> | null | undefined,
): Partial<Record<HandlePlatform, string>> | null {
  if (!input) return null
  const out: Partial<Record<HandlePlatform, string>> = {}
  for (const key of Object.keys(input) as HandlePlatform[]) {
    const v = normalizeHandle(key, input[key])
    if (v) out[key] = v
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Wave 5 (W36): normalise a form's worth of handle inputs, reporting which
 * platforms failed rather than silently dropping them the way
 * `normalizeHandles` does. Used by the venue-settings "Your social
 * handles" save so a junk value (a page link, stray punctuation, the
 * wrong platform's shape) is rejected with a message instead of vanishing.
 * A blank field is not an error.
 */
export function normalizeHandleInputs(
  input: Partial<Record<HandlePlatform, string>>,
): { handles: Partial<Record<HandlePlatform, string>>; invalid: HandlePlatform[] } {
  const handles: Partial<Record<HandlePlatform, string>> = {}
  const invalid: HandlePlatform[] = []
  for (const key of Object.keys(input) as HandlePlatform[]) {
    const raw = (input[key] ?? '').trim()
    if (!raw) continue
    const normalized = normalizeHandle(key, raw)
    if (!normalized) {
      invalid.push(key)
      continue
    }
    handles[key] = normalized
  }
  return { handles, invalid }
}

/** True when two handle maps share at least one platform with the same
 *  value. Platform-scoped on purpose: "rosie" on Instagram and "rosie" on
 *  TikTok are not evidence of the same person. */
export function handlesIntersect(
  a: Partial<Record<HandlePlatform, string>> | null | undefined,
  b: Partial<Record<HandlePlatform, string>> | null | undefined,
): HandlePlatform | null {
  if (!a || !b) return null
  for (const key of Object.keys(a) as HandlePlatform[]) {
    if (a[key] && b[key] && a[key] === b[key]) return key
  }
  return null
}

/**
 * Wave 5 (W36, NOVEMBER-PLAN.md): a venue's own handle pasted above a
 * couple's quoted reply, or appearing beside a genuine prospect in a
 * screenshot, is not evidence about the couple. Remove any (platform,
 * handle) pair from `handles` that equals the venue's own handle on the
 * same platform.
 *
 * Followers lists need no special case: a venue does not follow itself,
 * and if its own handle ever turned up there this same removal applies.
 */
export function stripVenueHandles(
  handles: Partial<Record<HandlePlatform, string>> | null | undefined,
  venueHandles: Partial<Record<HandlePlatform, string>> | null | undefined,
): Partial<Record<HandlePlatform, string>> | null {
  if (!handles) return null
  if (!venueHandles) return handles
  const out: Partial<Record<HandlePlatform, string>> = {}
  for (const key of Object.keys(handles) as HandlePlatform[]) {
    const value = handles[key]
    if (!value) continue
    if (venueHandles[key] === value) continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Platforms `platform_configs` (migration 324) covers. A strict subset of
 *  HandlePlatform — the legacy table predates knot/weddingwire/zola/twitter
 *  handles and never will hold them. */
const LEGACY_PLATFORM_CONFIG_PLATFORMS: HandlePlatform[] = [
  'instagram', 'tiktok', 'facebook', 'pinterest',
]

const VENUE_HANDLES_TTL_MS = 10 * 60 * 1000
const venueHandlesCache = new Map<
  string,
  { at: number; handles: Partial<Record<HandlePlatform, string>> | null }
>()

/**
 * The venue's own handles. Canonical source is `venue_config.social_handles`
 * (migration 403). `platform_configs.venue_handle` (migration 324) is the
 * legacy source — the per-platform social-integration config that predates
 * the venue-wide handle map. Where venue_config has nothing for a platform
 * legacy still holds, the legacy value is normalised and copied across once
 * (a best-effort write that never blocks the caller), so the two agree from
 * then on and every future read comes straight from venue_config.
 *
 * Cached ten minutes per venue: this is read on every inbound email and
 * every vision-candidate batch, and a venue's own handles change rarely.
 */
export async function getVenueSocialHandles(
  supabase: SupabaseClient,
  venueId: string,
): Promise<Partial<Record<HandlePlatform, string>> | null> {
  const hit = venueHandlesCache.get(venueId)
  if (hit && Date.now() - hit.at < VENUE_HANDLES_TTL_MS) return hit.handles

  const handles = await loadVenueSocialHandles(supabase, venueId)
  venueHandlesCache.set(venueId, { at: Date.now(), handles })
  return handles
}

async function loadVenueSocialHandles(
  supabase: SupabaseClient,
  venueId: string,
): Promise<Partial<Record<HandlePlatform, string>> | null> {
  const { data: configRow } = await supabase
    .from('venue_config')
    .select('social_handles')
    .eq('venue_id', venueId)
    .maybeSingle()
  const current =
    normalizeHandles(
      (configRow as { social_handles?: Record<string, string | null> | null } | null)
        ?.social_handles ?? null,
    ) ?? {}

  const { data: legacyRows } = await supabase
    .from('platform_configs')
    .select('platform, venue_handle')
    .eq('venue_id', venueId)
    .in('platform', LEGACY_PLATFORM_CONFIG_PLATFORMS)

  const toCopy: Partial<Record<HandlePlatform, string>> = {}
  for (const row of (legacyRows ?? []) as Array<{ platform: string; venue_handle: string | null }>) {
    const platform = row.platform as HandlePlatform
    if (current[platform]) continue // venue_config already holds this platform; it wins
    const normalized = normalizeHandle(platform, row.venue_handle)
    if (normalized) toCopy[platform] = normalized
  }

  const merged = { ...current, ...toCopy }

  if (Object.keys(toCopy).length > 0) {
    try {
      await supabase.from('venue_config').update({ social_handles: merged }).eq('venue_id', venueId)
    } catch (err) {
      console.warn(`[handles] legacy venue_handle copy failed for venue ${venueId}:`, err)
    }
  }

  return Object.keys(merged).length > 0 ? merged : null
}
