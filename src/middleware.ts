import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Routes that never require authentication
const PUBLIC_ROUTES = ['/welcome', '/login', '/signup', '/couple/login', '/demo', '/join']
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

    // Set cookies on the REQUEST so server components can read them during SSR
    const demoCookies = {
      bloom_demo: 'true',
      bloom_venue: '22222222-2222-2222-2222-222222222201',
      bloom_scope: JSON.stringify({
        level: 'venue',
        venueId: '22222222-2222-2222-2222-222222222201',
        venueName: 'Hawthorne Manor',
        companyName: 'The Crestwood Collection',
      }),
    }
    for (const [name, value] of Object.entries(demoCookies)) {
      request.cookies.set(name, value)
    }

    // Rewrite to the real path, forwarding the modified request
    response = NextResponse.rewrite(rewriteUrl, { request })

    // Also set cookies on the RESPONSE so the browser persists them
    const cookieOpts = { path: '/', maxAge: 86400 } as const
    for (const [name, value] of Object.entries(demoCookies)) {
      response.cookies.set(name, value, cookieOpts)
    }
    return response
  }

  // -----------------------------------------------------------------------
  // Demo mode: if bloom_demo cookie is set, skip auth checks
  // This lets people browse the full platform without signing in
  // -----------------------------------------------------------------------
  const isDemo = request.cookies.get('bloom_demo')?.value === 'true'
  if (isDemo) {
    return response
  }

  // -----------------------------------------------------------------------
  // 1. Create Supabase client that reads/writes cookies on the response
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
// ---------------------------------------------------------------------------
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
