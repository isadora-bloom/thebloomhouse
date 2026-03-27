import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Routes that don't require authentication
const PUBLIC_ROUTES = ['/login', '/signup', '/api/cron', '/api/webhooks']

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/')
  )
}

export async function middleware(request: NextRequest) {
  // Allow public routes through without auth check
  if (isPublicRoute(request.nextUrl.pathname)) {
    return NextResponse.next()
  }

  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Update request cookies (for downstream server components)
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )

          // Create a new response with updated cookies
          supabaseResponse = NextResponse.next({
            request,
          })

          // Set cookies on the response (for the browser)
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // IMPORTANT: Do not use supabase.auth.getSession() in middleware.
  // getUser() sends a request to the Supabase Auth server to revalidate
  // the session and refresh the token if needed. This is the secure pattern.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    // Redirect unauthenticated users to login
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Return the response with refreshed auth cookies
  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all routes under the (platform) group:
     * /agent/*, /intel/*, /portal/*, /settings/*
     * Also catch the root platform page
     * Exclude static files and Next.js internals
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
