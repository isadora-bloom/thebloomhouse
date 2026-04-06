'use client'

import { useMemo } from 'react'

export type ScopeLevel = 'venue' | 'group' | 'company'

export interface Scope {
  level: ScopeLevel
  venueId?: string
  groupId?: string
  venueName?: string
  groupName?: string
  companyName?: string
}

const DEFAULT_SCOPE: Scope = {
  level: 'venue',
  venueId: '22222222-2222-2222-2222-222222222201',
  venueName: 'Rixey Manor',
  companyName: 'The Crestwood Collection',
}

/**
 * Read the current scope from the bloom_scope cookie.
 * Returns the full scope object (level, venueId, groupId, names).
 */
export function useScope(): Scope {
  return useMemo(() => {
    if (typeof document === 'undefined') return DEFAULT_SCOPE
    try {
      const raw = document.cookie
        .split('; ')
        .find((c) => c.startsWith('bloom_scope='))
        ?.split('=')[1]
      if (!raw) return DEFAULT_SCOPE
      return { ...DEFAULT_SCOPE, ...JSON.parse(decodeURIComponent(raw)) }
    } catch {
      return DEFAULT_SCOPE
    }
  }, [])
}

/**
 * Get venue IDs that are in scope.
 * - venue: returns [venueId]
 * - group: needs group member lookup (caller provides)
 * - company: returns null (means "all venues")
 */
export function scopeVenueFilter(scope: Scope): string[] | null {
  if (scope.level === 'venue' && scope.venueId) return [scope.venueId]
  // For group/company, caller needs to resolve venue IDs from the group
  return null
}
