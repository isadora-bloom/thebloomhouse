'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export type ScopeLevel = 'venue' | 'group' | 'company'

export interface Scope {
  level: ScopeLevel
  venueId?: string
  groupId?: string
  orgId?: string
  venueName?: string
  groupName?: string
  companyName?: string
}

const DEMO_SCOPE: Scope = {
  level: 'venue',
  venueId: '22222222-2222-2222-2222-222222222201',
  orgId: '11111111-1111-1111-1111-111111111111',
  venueName: 'Hawthorne Manor',
  companyName: 'The Crestwood Collection',
}

const EMPTY_SCOPE: Scope = {
  level: 'venue',
}

function readScopeFromCookie(): Scope | null {
  if (typeof document === 'undefined') return null
  try {
    const raw = document.cookie
      .split('; ')
      .find((c) => c.startsWith('bloom_scope='))
      ?.split('=')[1]
    if (!raw) return null
    return JSON.parse(decodeURIComponent(raw)) as Scope
  } catch {
    return null
  }
}

function isDemoMode(): boolean {
  if (typeof document === 'undefined') return false
  return document.cookie.split('; ').some((c) => c === 'bloom_demo=true')
}

function writeScopeToCookie(scope: Scope) {
  if (typeof document === 'undefined') return
  document.cookie = `bloom_scope=${encodeURIComponent(JSON.stringify(scope))}; path=/; max-age=${60 * 60 * 24 * 365}`
}

/**
 * Read the current scope.
 *
 * Resolution order:
 * 1. Demo mode cookie → DEMO_SCOPE (Hawthorne Manor)
 * 2. bloom_scope cookie → parsed scope
 * 3. Authenticated user, no cookie → resolved from user_profiles (async),
 *    returns EMPTY_SCOPE with loading:true until resolved
 * 4. Unauthenticated, no cookie → EMPTY_SCOPE with loading:false
 *
 * Returns the Scope shape directly so existing call sites work unchanged,
 * with an extra `loading` flag for pages that want to show a spinner.
 */
export function useScope(): Scope & { loading: boolean } {
  const initial = useMemo<Scope | null>(() => {
    if (isDemoMode()) return DEMO_SCOPE
    return readScopeFromCookie()
  }, [])

  const [scope, setScope] = useState<Scope | null>(initial)
  const [loading, setLoading] = useState<boolean>(initial === null)

  useEffect(() => {
    if (scope !== null) return
    let cancelled = false

    async function resolve() {
      try {
        const supabase = createClient()
        const {
          data: { user },
        } = await supabase.auth.getUser()
        if (cancelled) return
        if (!user) {
          setLoading(false)
          return
        }

        const { data: profile } = await supabase
          .from('user_profiles')
          .select('venue_id, org_id')
          .eq('id', user.id)
          .maybeSingle()
        if (cancelled) return

        if (!profile?.venue_id) {
          setLoading(false)
          return
        }

        const { data: venue } = await supabase
          .from('venues')
          .select('name, org_id, organisations(name)')
          .eq('id', profile.venue_id as string)
          .maybeSingle()
        if (cancelled) return

        const orgRel = venue?.organisations as
          | { name?: string }
          | { name?: string }[]
          | null
          | undefined
        const orgName = Array.isArray(orgRel) ? orgRel[0]?.name : orgRel?.name

        const newScope: Scope = {
          level: 'venue',
          venueId: profile.venue_id as string,
          orgId: (profile.org_id as string | undefined) || (venue?.org_id as string | undefined) || undefined,
          venueName: (venue?.name as string | undefined) ?? undefined,
          companyName: orgName ?? undefined,
        }

        writeScopeToCookie(newScope)
        setScope(newScope)
        setLoading(false)
      } catch {
        if (!cancelled) setLoading(false)
      }
    }

    resolve()
    return () => {
      cancelled = true
    }
  }, [scope])

  return {
    ...(scope ?? EMPTY_SCOPE),
    loading,
  }
}

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
