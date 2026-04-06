'use client'

import { useMemo } from 'react'

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'

/**
 * Read the current venue ID from the bloom_venue cookie.
 * Falls back to demo venue ID if no cookie is set.
 */
export function useVenueId(): string {
  return useMemo(() => {
    if (typeof document === 'undefined') return DEMO_VENUE_ID
    try {
      const match = document.cookie
        .split('; ')
        .find((c) => c.startsWith('bloom_venue='))
      return match ? match.split('=')[1] : DEMO_VENUE_ID
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
