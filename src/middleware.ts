import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import {
  signDemoToken,
  DEMO_VENUE_ID as DEMO_TOKEN_VENUE_ID,
  DEMO_TOKEN_COOKIE,
  DEMO_HINT_COOKIE,
  demoTokenCookieOptions,
  demoHintCookieOptions,
} from '@/lib/services/demo-token'

// Routes that never require authentication
const PUBLIC_ROUTES = ['/welcome', '/login', '/signup', '/forgot-password', '/reset-password', '/couple/login', '/demo', '/join']
const PUBLIC_PREFIXES = ['/api/', '/_next/', '/demo/']

// The dashboard at / requires auth or demo. Unauthed users get sent to /welcome.
const DASHBOARD_ROUTE = '/'

// Platform routes require coordinator/manager/admin role
const PLATFORM_PREFIXES = ['/agent', '/intel', '/portal', '/settings', '/onboarding', '/setup', '/super-admin']

// Couple routes (path-based in dev)
const COUPLE_PREFIX = '/couple'

function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'))) return true
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  // Static file extensions
  if (/\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$/.test(pathname)) return true
  return false
}

function isPlatformRoute(pathname: string): boolean {
  return PLATFORM_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  let response = NextResponse.next({ request })

  // -----------------------------------------------------------------------
  // Demo routes: /demo/* → rewrite to the real route with demo cookies
  // e.g. /demo/agent/inbox → /agent/inbox (with bloom_demo=true cookie)
  // This makes every demo page crawlable without JS / manual cookie setup.
  // -----------------------------------------------------------------------
  if (pathname.startsWith('/demo/')) {
    const realPath = pathname.replace(/^\/demo/, '') || '/'
    const rewriteUrl = request.nextUrl.clone()
    rewriteUrl.pathname = realPath

    // Couple portal is per-wedding so scope pins to Hawthorne. Platform
    // routes (everything else) default to venue-level Hawthorne too — NOT
    // company-level. Sage's Brain nav (settings/personality/knowledge/etc,
    // see nav-config.ts) marks its sections `venueOnly: true`, and
    // sidebar-v2.tsx hides any venueOnly section when scopeLevel !== 'venue'
    // (shouldShowSection). Company-level scope on demo platform routes was
    // hiding all of Sage's Brain end to end ("Essential 0 / All 0"). The
    // company/group selector (ScopeIndicator, top bar) still reads live
    // venues/org from Supabase and lets a demo visitor switch to company
    // scope by hand — this only changes the *default* on entry.
    const demoScope = {
      level: 'venue',
      venueId: DEMO_TOKEN_VENUE_ID,
      orgId: '11111111-1111-1111-1111-111111111111',
      venueName: 'Hawthorne Manor',
      companyName: 'The Crestwood Collection',
    }

    // Mint a signed, HttpOnly demo token — same as the /demo entry Server
    // Action (see src/app/demo/page.tsx) — so deep links like /demo/pulse
    // or /demo/intel/dashboard pass server-side auth. Before this fix the
    // rewrite only set the legacy `bloom_demo=true` value cookie, which
    // isDemoMode() / requirePlan() / resolvePlatformScope() never trust —
    // they verify the signed bloom_demo_token via verifyDemoToken(). A
    // deep link landed on a page whose data loaders saw no verified token,
    // so they fell through the "not authenticated" branch and redirected
    // to /login, even though the legacy cookie was present.
    const demoToken = signDemoToken({ demoVenueId: DEMO_TOKEN_VENUE_ID })

    // Set cookies on the REQUEST so server components can read them during SSR
    const demoCookies = {
      bloom_demo: 'true',
      bloom_venue: DEMO_TOKEN_VENUE_ID,
      bloom_scope: JSON.stringify(demoScope),
      [DEMO_TOKEN_COOKIE]: demoToken,
      [DEMO_HINT_COOKIE]: '1',
    }
    for (const [name, value] of Object.entries(demoCookies)) {
      request.cookies.set(name, value)
    }

    // Rewrite to the real path, forwarding the modified request
    response = NextResponse.rewrite(rewriteUrl, { request })

    // Also set cookies on the RESPONSE so the browser persists them. The
    // legacy trio keeps its existing 24h flat maxAge; the signed token and
    // its UI hint reuse the same cookie options the /demo Server Action
    // uses (demoTokenCookieOptions / demoHintCookieOptions) so both entry
    // paths mint an identical cookie shape.
    const cookieOpts = { path: '/', maxAge: 86400 } as const
    response.cookies.set('bloom_demo', demoCookies.bloom_demo, cookieOpts)
    response.cookies.set('bloom_venue', demoCookies.bloom_venue, cookieOpts)
    response.cookies.set('bloom_scope', demoCookies.bloom_scope, cookieOpts)
    response.cookies.set(DEMO_TOKEN_COOKIE, demoToken, demoTokenCookieOptions())
    response.cookies.set(DEMO_HINT_COOKIE, '1', demoHintCookieOptions())
    return response
  }

  // -----------------------------------------------------------------------
  // Build the Supabase client up front. We need to check auth whether or
  // not we're about to honour the demo cookie, because the demo + auth
  // collision is the primary data-bleed vector and we want to resolve it
  // at the earliest point.
  // -----------------------------------------------------------------------
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Apply cookies to the request (for downstream server components)
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value)
          })
          // Apply cookies to the response (for the browser)
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  // IMPORTANT: Use getUser() not getSession() — it validates with the
  // Supabase Auth server and refreshes the token. This is the secure pattern.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // -----------------------------------------------------------------------
  // Demo mode vs auth session: the collision
  //
  // If bloom_demo=true and NO auth session: this is a legit anonymous demo
  // visitor. Skip auth checks, let them browse.
  //
  // If bloom_demo=true and AN auth session exists: this is the 24-hour
  // bleed vector. The /demo entry route at /app/demo/page.tsx now signs
  // the user out before setting demo cookies, but existing sessions (from
  // before this fix shipped, or from a race where a tab re-authed after
  // demo entry) may still carry both cookies. When they do, the browser's
  // Supabase client attaches the auth token to every query, RLS returns
  // the user's real venue data, and the demo cookie pins a foreign scope
  // on top. Result: real data leaks into demo views, demo data is invisible.
  //
  // Resolution: auth wins. Clear the demo cookies and fall through to the
  // authenticated flow below. The user sees their real venue cleanly.
  // -----------------------------------------------------------------------
  // Two cookie shapes resolve to "this is a demo session":
  //   - bloom_demo=true        : legacy value cookie set by the /demo/*
  //                              rewrite path at the top of this middleware.
  //   - bloom_demo_hint=1      : non-HttpOnly hint set by the new signed-token
  //                              flow in /demo Server Action (see demo-token.ts).
  //                              Pairs with the HttpOnly bloom_demo_token; the
  //                              hint exists specifically so Edge middleware
  //                              (which can't call node:crypto / verifyDemoToken)
  //                              can recognise the session without seeing the
  //                              signature. Anyone can set this in DevTools, but
  //                              downstream auth-helpers verify the signed token
  //                              on every server-side data read, so flipping
  //                              the hint without the signed token still leaves
  //                              the user with no real-data access.
  // 2026-05-08 fix: pre-fix middleware only checked the legacy cookie, so
  // /demo entry (which sets the new pair) hit the no-auth branch and bounced
  // through /welcome → /login redirect loops.
  const isDemo =
    request.cookies.get('bloom_demo')?.value === 'true' ||
    request.cookies.get('bloom_demo_hint')?.value === '1'
  if (isDemo && !user) {
    return response
  }
  if (isDemo && user) {
    const clear = { path: '/', maxAge: 0 } as const
    // Clear ALL demo cookies, both shapes. Pre-2026-05-08 only the
    // legacy three were cleared; bloom_demo_token (HMAC-signed) and
    // bloom_demo_hint survived and getPlatformAuth was still seeing
    // a valid signed token → demo wins → coordinator's real venue data
    // gets crossed with the demo identity. Clearing all four resolves
    // to "auth wins" cleanly.
    response.cookies.set('bloom_demo', '', clear)
    response.cookies.set('bloom_scope', '', clear)
    response.cookies.set('bloom_venue', '', clear)
    response.cookies.set('bloom_demo_token', '', clear)
    response.cookies.set('bloom_demo_hint', '', clear)
    // Also clear from the in-flight request so downstream server components
    // in this same request don't observe the stale demo cookie.
    request.cookies.delete('bloom_demo')
    request.cookies.delete('bloom_scope')
    request.cookies.delete('bloom_venue')
    request.cookies.delete('bloom_demo_token')
    request.cookies.delete('bloom_demo_hint')
  }

  // -----------------------------------------------------------------------
  // 2. Handle subdomain routing (production couple portal)
  // -----------------------------------------------------------------------
  const hostname = request.headers.get('host') || ''
  const isProduction = process.env.NODE_ENV === 'production'

  // Check for venue subdomain: e.g., hawthorne-manor.bloomhouse.ai
  // In dev we use path-based routing instead
  const baseDomain = process.env.NEXT_PUBLIC_BASE_DOMAIN || 'bloomhouse.ai'
  const subdomain = extractSubdomain(hostname, baseDomain)

  if (subdomain && isProduction) {
    // This is a couple portal request via subdomain
    // Set venue slug cookie so the couple layout can read it
    response.cookies.set('venue-slug', subdomain, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      secure: true,
    })

    // If not authenticated, redirect to couple login
    if (!user && pathname !== '/login') {
      const loginUrl = request.nextUrl.clone()
      loginUrl.pathname = '/login'
      return NextResponse.redirect(loginUrl)
    }

    // If authenticated, verify couple role
    if (user) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      if (profile?.role !== 'couple') {
        // Not a couple user — redirect to login
        const loginUrl = request.nextUrl.clone()
        loginUrl.pathname = '/login'
        return NextResponse.redirect(loginUrl)
      }
    }

    // Subdomain requests serve from the (couple) route group
    return response
  }

  // -----------------------------------------------------------------------
  // 3. Public routes — pass through
  // -----------------------------------------------------------------------
  if (isPublicRoute(pathname)) {
    return response
  }

  // -----------------------------------------------------------------------
  // 4. Couple routes (path-based, dev mode): /couple/*
  // -----------------------------------------------------------------------
  if (pathname.startsWith(COUPLE_PREFIX)) {
    // The couple login and registration pages are always public
    // Matches /couple/login, /couple/[slug]/login, and /couple/[slug]/register
    if (pathname === '/couple/login' || /^\/couple\/[^/]+\/(login|register)\/?$/.test(pathname)) {
      return response
    }

    if (!user) {
      const loginUrl = request.nextUrl.clone()
      loginUrl.pathname = '/couple/login'
      return NextResponse.redirect(loginUrl)
    }

    // Verify couple role
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'couple') {
      const loginUrl = request.nextUrl.clone()
      loginUrl.pathname = '/couple/login'
      return NextResponse.redirect(loginUrl)
    }

    // Extract venue slug from path: /couple/hawthorne-manor/dashboard → hawthorne-manor
    const couplePathMatch = pathname.match(/^\/couple\/([^/]+)/)
    if (couplePathMatch) {
      response.cookies.set('venue-slug', couplePathMatch[1], {
        path: '/',
        httpOnly: false,
        sameSite: 'lax',
        secure: false,
      })
    }

    return response
  }

  // -----------------------------------------------------------------------
  // 5. Platform routes — require coordinator/manager/admin
  // -----------------------------------------------------------------------
  if (isPlatformRoute(pathname)) {
    if (!user) {
      const loginUrl = request.nextUrl.clone()
      loginUrl.pathname = '/login'
      loginUrl.searchParams.set('redirect', pathname)
      return NextResponse.redirect(loginUrl)
    }

    // Check role
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    const platformRoles = ['super_admin', 'org_admin', 'venue_manager', 'coordinator', 'readonly']
    if (!profile || !platformRoles.includes(profile.role)) {
      // User exists but doesn't have a platform role
      const loginUrl = request.nextUrl.clone()
      loginUrl.pathname = '/login'
      return NextResponse.redirect(loginUrl)
    }

    return response
  }

  // -----------------------------------------------------------------------
  // 6. Dashboard at / — auth/demo gets through, unauthed → /welcome
  // -----------------------------------------------------------------------
  if (pathname === DASHBOARD_ROUTE) {
    if (!user) {
      const welcomeUrl = request.nextUrl.clone()
      welcomeUrl.pathname = '/welcome'
      return NextResponse.redirect(welcomeUrl)
    }
    return response
  }

  // -----------------------------------------------------------------------
  // 7. Other routes — require any authenticated user
  // -----------------------------------------------------------------------
  if (!user) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    return NextResponse.redirect(loginUrl)
  }

  return response
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract subdomain from hostname.
 * e.g., "hawthorne-manor.bloomhouse.ai" with baseDomain "bloomhouse.ai" → "hawthorne-manor"
 * Returns null if no subdomain or if it's "www" or "app".
 */
function extractSubdomain(hostname: string, baseDomain: string): string | null {
  // Strip port for local dev
  const host = hostname.split(':')[0]

  if (!host.endsWith(baseDomain)) return null

  const prefix = host.slice(0, -(baseDomain.length + 1)) // +1 for the dot
  if (!prefix || prefix === 'www' || prefix === 'app') return null

  return prefix
}

// ---------------------------------------------------------------------------
// Matcher — skip static assets for performance
//
// runtime: 'nodejs' — the /demo/* branch above now calls signDemoToken(),
// which uses node:crypto (createHmac / randomBytes). That module isn't
// available on the default Edge runtime. Node.js middleware is stable on
// Next.js 16 (no experimental flag needed); everything else in this file
// (createServerClient from @supabase/ssr, NextResponse) already runs fine
// under the Node runtime, so this is a safe whole-file switch, not a
// demo-only carve-out.
// ---------------------------------------------------------------------------
export const config = {
  runtime: 'nodejs',
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
