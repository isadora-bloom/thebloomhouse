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

function clearScopeCookie() {
  if (typeof document === 'undefined') return
  document.cookie = 'bloom_scope=; path=/; max-age=0'
}

/**
 * Read the current scope.
 *
 * Resolution order on mount:
 * 1. Demo mode cookie → DEMO_SCOPE (Hawthorne Manor), no validation
 * 2. bloom_scope cookie → seeded as initial value, then validated against
 *    the authed user's org. If the cookie's venue doesn't belong to the
 *    user's org, it is discarded and re-resolved from user_profiles.
 * 3. No cookie → resolved from user_profiles (async).
 * 4. Unauthenticated → stale cookie cleared, EMPTY_SCOPE returned.
 *
 * Why: a year-long cookie was previously trusted forever, so a user who
 * had a demo session (Hawthorne) would keep seeing demo data even after
 * logging into a real account.
 */
export function useScope(): Scope & { loading: boolean } {
  const initial = useMemo<Scope | null>(() => {
    if (isDemoMode()) {
      // Respect the bloom_scope cookie if it's set (demo entry can choose
      // company-level for platform or venue-level for couple portal). Fall
      // back to the Hawthorne venue scope for older demo sessions that never
      // wrote the cookie.
      return readScopeFromCookie() ?? DEMO_SCOPE
    }
    return readScopeFromCookie()
  }, [])

  const [scope, setScope] = useState<Scope | null>(initial)
  // Always validate on mount unless we're in demo mode (terminal).
  const [loading, setLoading] = useState<boolean>(!isDemoMode())

  useEffect(() => {
    if (isDemoMode()) {
      setLoading(false)
      return
    }
    let cancelled = false
    const cookieScope = readScopeFromCookie()

    async function resolve() {
      try {
        const supabase = createClient()
        const {
          data: { user },
        } = await supabase.auth.getUser()
        if (cancelled) return
        if (!user) {
          // Unauthed: drop any stale scope from a previous logged-in session.
          if (cookieScope) {
            clearScopeCookie()
            setScope(null)
          }
          setLoading(false)
          return
        }

        const { data: profile } = await supabase
          .from('user_profiles')
          .select('venue_id, org_id, role')
          .eq('id', user.id)
          .maybeSingle()
        if (cancelled) return

        // If a cookie exists, only keep it when its venue is inside the
        // user's org. This catches demo→real transitions and venue
        // deletions without forcing every page to revalidate on its own.
        if (cookieScope?.venueId && profile?.org_id) {
          const { data: cookieVenue } = await supabase
            .from('venues')
            .select('org_id')
            .eq('id', cookieScope.venueId)
            .maybeSingle()
          if (cancelled) return
          if (cookieVenue?.org_id === profile.org_id) {
            setLoading(false)
            return
          }
          // Stale — fall through to re-resolve, then overwrite cookie.
        }

        // Resolve venue: prefer profile.venue_id, then fall back to first
        // venue in org for org-level admins (mirrors server auth-helpers).
        let resolvedVenueId = (profile?.venue_id as string | undefined) ?? null
        if (!resolvedVenueId && profile?.org_id) {
          const isAdmin = profile.role === 'org_admin' || profile.role === 'super_admin'
          if (isAdmin) {
            const { data: firstVenue } = await supabase
              .from('venues')
              .select('id')
              .eq('org_id', profile.org_id as string)
              .order('created_at', { ascending: true })
              .limit(1)
              .maybeSingle()
            resolvedVenueId = (firstVenue?.id as string | undefined) ?? null
          }
        }
        if (!resolvedVenueId) {
          // Profile exists but no venue access. Clear any stale cookie so
          // we don't keep pointing at a venue they can't see.
          if (cookieScope) {
            clearScopeCookie()
            setScope(null)
          }
          setLoading(false)
          return
        }

        const { data: venue } = await supabase
          .from('venues')
          .select('name, org_id, organisations(name)')
          .eq('id', resolvedVenueId)
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
          venueId: resolvedVenueId,
          orgId: (profile?.org_id as string | undefined) || (venue?.org_id as string | undefined) || undefined,
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
    // Intentionally runs only on mount — revalidation happens once per
    // page load, not on every scope mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
