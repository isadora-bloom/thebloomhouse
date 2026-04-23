'use client'

import { createContext, useContext, type ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Venue scope context
//
// The venue in scope is resolved ONCE, on the server, in the (platform)
// layout — via cookie + user_profiles. It is passed into this provider at
// the top of every platform route so child client components can read it
// synchronously without re-reading the cookie, without racing the
// scope-selector, and without an SSR/CSR hydration mismatch.
//
// If no venue could be resolved the layout redirects before rendering,
// which is why `venueId` is always a non-empty string here.
// ---------------------------------------------------------------------------

export interface VenueScope {
  venueId: string
  orgId: string | null
  /** Venue name resolved server-side — avoids SSR/CSR hydration mismatch in ScopeIndicator. */
  venueName: string | null
  /** Org name resolved server-side — for company-scope display. */
  orgName: string | null
  /** User-chosen scope level ('venue'|'group'|'company'). Resolved from bloom_scope cookie server-side. */
  level: 'venue' | 'group' | 'company'
  /** Group id when level='group', resolved server-side. */
  groupId: string | null
  /** Group name when level='group', resolved server-side. */
  groupName: string | null
}

const VenueScopeContext = createContext<VenueScope | null>(null)

export function VenueScopeProvider({
  venueId,
  orgId,
  venueName,
  orgName,
  level,
  groupId,
  groupName,
  children,
}: {
  venueId: string
  orgId: string | null
  venueName?: string | null
  orgName?: string | null
  level?: 'venue' | 'group' | 'company'
  groupId?: string | null
  groupName?: string | null
  children: ReactNode
}) {
  return (
    <VenueScopeContext.Provider
      value={{
        venueId,
        orgId,
        venueName: venueName ?? null,
        orgName: orgName ?? null,
        level: level ?? 'venue',
        groupId: groupId ?? null,
        groupName: groupName ?? null,
      }}
    >
      {children}
    </VenueScopeContext.Provider>
  )
}

/**
 * Read the venue scope. MUST be rendered inside a platform route — callers
 * outside the (platform) layout (couple portal, marketing pages) won't have
 * the provider and this will throw. That is intentional: if it returned
 * `''` we'd be right back where we started with the empty-venue-id bug.
 */
export function useVenueScope(): VenueScope {
  const ctx = useContext(VenueScopeContext)
  if (!ctx) {
    throw new Error(
      'useVenueScope() used outside VenueScopeProvider. Wrap your route in the (platform) layout.'
    )
  }
  return ctx
}
