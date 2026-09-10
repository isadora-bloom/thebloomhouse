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

/** Normalise one handle for one platform. Null when empty or malformed. */
export function normalizeHandle(platform: HandlePlatform, raw: string | null | undefined): string | null {
  if (!raw) return null
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
