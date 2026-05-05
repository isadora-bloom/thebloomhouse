'use client'

import { useVenueScope, useScopeMutator } from '@/lib/contexts/venue-scope-context'

export type ScopeLevel = 'venue' | 'group' | 'company'

/**
 * Legacy `Scope` shape preserved for backwards compatibility with the
 * ~50 call sites that destructure `scope.venueId`, `scope.companyName`,
 * etc. New code should use `useVenueScope()` directly.
 */
export interface Scope {
  level: ScopeLevel
  venueId?: string
  groupId?: string
  orgId?: string
  venueName?: string
  groupName?: string
  companyName?: string
}

/**
 * Read the current scope.
 *
 * Backed by `VenueScopeProvider` (resolved server-side in
 * (platform)/layout.tsx — see `lib/api/resolve-platform-scope.ts`),
 * which means:
 *   - `loading` is always `false` (the provider waited for the
 *     server resolution before rendering children)
 *   - The value is hydration-safe (SSR and CSR are identical)
 *   - The value updates synchronously when `useScopeMutator()` writes
 *     the cookie — no `window.location.reload()` is needed and there
 *     is no empty-deps `useEffect` race window (GAP-09).
 *
 * `loading` is kept on the return type so existing callers that gate
 * fetches on it (`if (scope.loading) return`) keep compiling. They are
 * harmless no-ops now and can be cleaned up incrementally.
 */
export function useScope(): Scope & { loading: boolean } {
  const v = useVenueScope()
  return {
    level: v.level,
    venueId: v.venueId,
    groupId: v.groupId ?? undefined,
    orgId: v.orgId ?? undefined,
    venueName: v.venueName ?? undefined,
    groupName: v.groupName ?? undefined,
    // Legacy alias — server stores this as `orgName` but the client
    // historically read `companyName`.
    companyName: v.orgName ?? undefined,
    loading: false,
  }
}

/**
 * Imperative scope switcher. Re-export of `useScopeMutator` so call
 * sites that reach for `useScope` for everything can import a single
 * symbol from one module.
 */
export { useScopeMutator }

/**
 * Get venue IDs that are in scope.
 * - venue: returns [venueId]
 * - group: needs group member lookup (caller provides)
 * - company: returns null (means "all venues")
 */
export function scopeVenueFilter(scope: Scope): string[] | null {
  if (scope.level === 'venue' && scope.venueId) return [scope.venueId]
  return null
}
