'use client'

import { useMemo } from 'react'

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'

/**
 * Read the current venue ID from cookies.
 *
 * Resolution order:
 * 1. SSR (no document) → '' (empty string, never demo)
 * 2. bloom_venue cookie set → that venue ID
 * 3. Demo mode cookie set → demo venue ID
 * 4. Real user with no cookie → '' (caller must handle empty)
 *
 * Empty string is the safe fallback: queries against '' won't accidentally
 * fetch demo data for real users.
 */
export function useVenueId(): string {
  return useMemo(() => {
    if (typeof document === 'undefined') return ''
    try {
      const cookies = document.cookie.split('; ')
      const match = cookies.find((c) => c.startsWith('bloom_venue='))
      if (match) return match.split('=')[1]

      const isDemo = cookies.some((c) => c === 'bloom_demo=true')
      if (isDemo) return DEMO_VENUE_ID

      return ''
    } catch {
      return ''
    }
  }, [])
}

/**
 * For non-hook contexts (API routes, server components), read directly.
 * Returns empty string when no cookie or only when not in demo mode.
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
