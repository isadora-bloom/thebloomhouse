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
 *                         the auth-wins branch). Listing it here would
 *                         look like coverage we don't actually have.
 */
export function clearDemoCookiesClientSide(): void {
  if (typeof document === 'undefined') return
  const opts = 'path=/; max-age=0'
  document.cookie = `bloom_demo=; ${opts}`
  document.cookie = `bloom_scope=; ${opts}`
  document.cookie = `bloom_venue=; ${opts}`
  document.cookie = `bloom_demo_hint=; ${opts}`
}
