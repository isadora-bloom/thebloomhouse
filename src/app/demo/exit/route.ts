import { NextResponse } from 'next/server'
import { DEMO_TOKEN_COOKIE, DEMO_HINT_COOKIE } from '@/lib/services/demo-token'

/**
 * POST (or GET) /demo/exit — end a demo session properly.
 *
 * S5 (2026-09-14 security audit, item 12).
 *
 * `clearDemoCookiesClientSide` clears the three legacy value cookies and
 * the hint. It cannot clear `bloom_demo_token`, and says so in its own
 * doc comment: the token is HttpOnly, and a browser ignores any
 * `document.cookie` assignment for an HttpOnly cookie. So signing out of
 * a demo left the one cookie that actually grants demo access sitting in
 * the browser for its full 24 hours, on whatever machine that was — a
 * laptop at a trade stand, a borrowed phone, a shared desk.
 *
 * Only the server can expire it, which is what this route is for. The
 * user menu calls it on sign-out; it is also navigable by hand, which is
 * useful when someone needs to get a demo off a machine quickly.
 *
 * Deliberately unauthenticated: it removes access, it does not grant it,
 * and requiring a session to end a session is how people end up stuck.
 */

function clearedResponse(res: NextResponse): NextResponse {
  const expire = {
    path: '/',
    maxAge: 0,
    expires: new Date(0),
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
  }
  // HttpOnly matches how each was set; a mismatch leaves the original in
  // place in some browsers.
  res.cookies.set(DEMO_TOKEN_COOKIE, '', { ...expire, httpOnly: true })
  res.cookies.set(DEMO_HINT_COOKIE, '', { ...expire, httpOnly: false })
  // The legacy trio too, so one call is the whole job and the client-side
  // helper is belt-and-braces rather than load-bearing.
  res.cookies.set('bloom_demo', '', { ...expire, httpOnly: false })
  res.cookies.set('bloom_venue', '', { ...expire, httpOnly: false })
  res.cookies.set('bloom_scope', '', { ...expire, httpOnly: false })
  return res
}

export async function POST() {
  return clearedResponse(NextResponse.json({ ok: true }))
}

/** Hand-navigable version: clears, then lands on the login page. */
export async function GET(request: Request) {
  const url = new URL('/login', request.url)
  return clearedResponse(NextResponse.redirect(url, 303))
}
