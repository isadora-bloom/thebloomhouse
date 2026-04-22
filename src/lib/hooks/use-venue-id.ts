'use client'

import { useVenueScope } from '@/lib/contexts/venue-scope-context'

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'

/**
 * Read the current venue ID.
 *
 * Backed by the VenueScopeProvider that wraps every platform route in
 * (platform)/layout.tsx — which resolves the venue SERVER-SIDE from the
 * bloom_venue cookie + user_profiles before any child renders. That makes
 * this hook:
 *   - Synchronous (no loading state)
 *   - Hydration-safe (SSR and CSR return the same value)
 *   - Race-free (no empty-string window before the scope-selector writes
 *     the cookie)
 *
 * Callers outside the (platform) layout (couple portal, marketing pages)
 * are not supported — useVenueScope() will throw to make misuse loud.
 */
export function useVenueId(): string {
  return useVenueScope().venueId
}

/**
 * For non-hook contexts (API routes, Node scripts) that read the cookie
 * header directly. Layout server components should prefer
 * resolvePlatformScope() in @/lib/api/resolve-platform-scope.
 */
export function getVenueIdFromCookie(cookieHeader?: string): string {
  if (!cookieHeader) return ''
  const cookies = cookieHeader.split('; ')
  const match = cookies.find((c) => c.startsWith('bloom_venue='))
  if (match) return match.split('=')[1]

  const isDemo = cookies.some((c) => c === 'bloom_demo=true')
  if (isDemo) return DEMO_VENUE_ID

  return ''
}
