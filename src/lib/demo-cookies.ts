/**
 * Client-side helper to clear ALL demo cookies in one call.
 *
 * Called from auth pages (login / signup / reset-password / register /
 * join) and the user-menu sign-out so a coordinator who authenticates
 * while still carrying a demo session ends up cleanly authed without
 * the demo identity surviving in the background. The middleware does
 * the same clear server-side as the canonical fix; this is
 * belt-and-braces for navigation paths that don't traverse middleware
 * (same-route SPA transitions, certain form-action redirects).
 *
 * Cookies cleared:
 *   - bloom_demo          legacy value cookie (middleware /demo/* rewrite)
 *   - bloom_scope         legacy scope cookie
 *   - bloom_venue         legacy venue id cookie
 *   - bloom_demo_hint     non-HttpOnly hint set by /demo Server Action
 *
 * NOT cleared client-side:
 *   - bloom_demo_token    HttpOnly. Browsers reject any document.cookie
 *                         assignment for HttpOnly cookies; only the
 *                         server can clear it (middleware does this in
 *                         the auth-wins branch, POST /demo/exit does it
 *                         on request). Listing it here would look like
 *                         coverage we don't actually have.
 *
 * Anything that means "leave the demo" (the banner's X, sign-out) calls
 * `endDemoSession()` below, which does this clear AND asks the server to
 * expire the token. The banner used to call only this function, so the
 * token outlived the exit for its full 24 hours and the next sign-in on
 * that machine answered for Hawthorne Manor (§20 scenario 3, 2026-09-16).
 */
export function clearDemoCookiesClientSide(): void {
  if (typeof document === 'undefined') return
  const opts = 'path=/; max-age=0'
  document.cookie = `bloom_demo=; ${opts}`
  document.cookie = `bloom_scope=; ${opts}`
  document.cookie = `bloom_venue=; ${opts}`
  document.cookie = `bloom_demo_hint=; ${opts}`
}

/**
 * End the demo session properly: client-side cookies now, HttpOnly token
 * via POST /demo/exit. Never throws; leaving the demo must not be blocked
 * by a cookie round trip, and the middleware's auth-wins clear is still
 * behind it.
 */
export async function endDemoSession(): Promise<void> {
  clearDemoCookiesClientSide()
  try {
    await fetch('/demo/exit', { method: 'POST' })
  } catch {
    // Nothing to tell the user; the caller's navigation still happens.
  }
}
