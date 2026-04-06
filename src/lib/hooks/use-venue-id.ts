'use client'

import { useMemo } from 'react'

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'

/**
 * Read the current venue ID from the bloom_venue cookie.
 * Falls back to demo venue ID only if in demo mode.
 */
export function useVenueId(): string {
  return useMemo(() => {
    if (typeof document === 'undefined') return DEMO_VENUE_ID
    try {
      const cookies = document.cookie.split('; ')
      const match = cookies.find((c) => c.startsWith('bloom_venue='))
      if (match) return match.split('=')[1]

      // Only fall back to demo venue if in demo mode
      const isDemo = cookies.some((c) => c === 'bloom_demo=true')
      if (isDemo) return DEMO_VENUE_ID

      return '' // Real user with no venue selected yet
    } catch {
      return DEMO_VENUE_ID
    }
  }, [])
}

/**
 * For non-hook contexts (API routes, server components), read directly.
 */
export function getVenueIdFromCookie(cookieHeader?: string): string {
  if (!cookieHeader) return DEMO_VENUE_ID
  const match = cookieHeader.split('; ').find((c) => c.startsWith('bloom_venue='))
  return match ? match.split('=')[1] : DEMO_VENUE_ID
}
