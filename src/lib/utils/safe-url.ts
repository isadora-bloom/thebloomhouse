/**
 * One check for "is this string safe to put in an href or a src?".
 *
 * S5 (2026-09-14 security audit, item 12).
 *
 * React escapes text. It does not validate URLs. `<a href={row.url}>`
 * with `javascript:alert(document.cookie)` in the column renders a link
 * that runs script in the couple's session when they click it, and the
 * column is coordinator-typed in some places and vendor-supplied in
 * others. `data:text/html,...` is the same attack wearing a different
 * scheme. Neither is a theoretical shape: both survive a copy-paste out
 * of a vendor's own site.
 *
 * The rule is an allowlist, because a denylist of schemes is a game you
 * lose to the next one someone invents. http and https, nothing else,
 * and no embedded credentials (`https://user:pass@host` renders as a
 * plausible host in a link preview and goes somewhere else).
 *
 * Returns null when the value cannot be trusted, so the caller can drop
 * the link rather than render a dead or dangerous one.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // A protocol-relative URL (//evil.example) inherits the page's scheme
  // and is a real destination, but it is almost never what a database
  // column meant to hold, so treat it as untrusted rather than guessing.
  if (trimmed.startsWith('//')) return null

  let parsed: URL
  try {
    // Bare domains ("rixeymanor.com") are common in hand-typed columns.
    // Give them https rather than dropping the link.
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null
  if (parsed.username || parsed.password) return null
  if (!parsed.hostname) return null

  return parsed.toString()
}

/**
 * Convenience for JSX: `href={safeHref(row.url)}` renders nothing
 * clickable when the value is not trustworthy, instead of `href="#"`
 * which looks like a working link that does nothing.
 */
export function safeHref(raw: unknown): string | undefined {
  return safeHttpUrl(raw) ?? undefined
}
