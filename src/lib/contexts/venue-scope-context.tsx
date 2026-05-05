'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'

// ---------------------------------------------------------------------------
// Venue scope context (GAP-09)
//
// One source of truth for the current scope (venue / group / company),
// hydrated from a SERVER-resolved value in (platform)/layout.tsx and then
// mutable client-side without a full page reload.
//
// Why this exists
// ---------------
// Old shape: the scope was duplicated across two cookies (`bloom_venue`,
// `bloom_scope`) read by an empty-deps `useEffect`. After a switch we
// fired `window.location.reload()` because the hooks couldn't observe the
// cookie write. That gave a 200-400ms white-flash and the GAP-09 race
// where API calls in flight at the moment of switch resolved against the
// old venue.
//
// New shape: the provider holds the scope in React state. The
// scope-switcher calls `setScope({...})` which:
//   1. updates the in-memory store synchronously — every consumer of
//      `useVenueScope()` re-renders on the next React tick
//   2. writes the cookies (so SSR and middleware stay consistent on the
//      next navigation, and so the next page load picks up the right
//      venue)
//   3. calls `router.refresh()` so server components re-render with the
//      new cookie value and the RSC tree reconciles with the client.
//
// Callers OUTSIDE the (platform) layout (couple portal, marketing pages)
// don't have the provider — `useVenueScope()` throws to make misuse
// loud. Use `getVenueIdFromCookie()` for read-only Node contexts.
// ---------------------------------------------------------------------------

export type ScopeLevel = 'venue' | 'group' | 'company'

export interface VenueScope {
  /**
   * Always non-empty for level='venue'. For level='group' / 'company' the
   * platform layout still pre-resolves a "primary" venueId (the user's
   * profile.venue_id or the org's first venue) so per-venue components
   * (e.g. /portal/* config pages) keep working when the user switches
   * scope upwards. Pages that need to aggregate across venues should
   * read `level` first and call `resolveScopeVenueIds` server-side.
   */
  venueId: string
  orgId: string | null
  /** Venue display name resolved server-side at hydrate time. */
  venueName: string | null
  /** Org display name resolved server-side. */
  orgName: string | null
  /** User-chosen scope level. */
  level: ScopeLevel
  /** Group id, when level==='group'. */
  groupId: string | null
  /** Group display name, when level==='group'. */
  groupName: string | null
  /**
   * Per-venue AI assistant name from venue_ai_config.ai_name. Resolved
   * server-side so coordinator-facing UI ("Ivy's Brain", "Aria sees…")
   * doesn't hardcode "Sage". T5-β.2.
   */
  aiName: string
  /** True when the platform layout was hit via the demo cookie. */
  isDemo: boolean
}

/**
 * Patch that the scope switcher hands to `setScope`. Anything left
 * undefined is preserved from the previous state.
 */
export interface ScopePatch {
  level?: ScopeLevel
  venueId?: string
  venueName?: string | null
  orgId?: string | null
  orgName?: string | null
  groupId?: string | null
  groupName?: string | null
  aiName?: string | null
}

interface ScopeStore {
  scope: VenueScope
  setScope: (patch: ScopePatch) => void
}

const VenueScopeContext = createContext<ScopeStore | null>(null)

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 // 1 year

/**
 * Serialize the scope for the bloom_scope cookie. Field order and key
 * names mirror the legacy shape so the server-side parser
 * (`resolvePlatformScope.parseScopeCookie`) keeps working without a
 * migration.
 */
function buildScopeCookieValue(scope: VenueScope): string {
  return JSON.stringify({
    level: scope.level,
    venueId: scope.venueId,
    venueName: scope.venueName,
    orgId: scope.orgId,
    groupId: scope.groupId,
    groupName: scope.groupName,
    companyName: scope.orgName, // legacy key the server still reads
  })
}

function writeScopeCookies(scope: VenueScope): void {
  if (typeof document === 'undefined') return
  document.cookie = `bloom_scope=${encodeURIComponent(buildScopeCookieValue(scope))}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`
  // bloom_venue is a separate cookie because middleware + a handful of
  // legacy server callers read it directly without parsing JSON.
  document.cookie = `bloom_venue=${scope.venueId}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`
}

export interface VenueScopeProviderProps {
  /** SSR-resolved venue id. Always non-empty. */
  venueId: string
  orgId: string | null
  venueName?: string | null
  orgName?: string | null
  level?: ScopeLevel
  groupId?: string | null
  groupName?: string | null
  aiName?: string | null
  isDemo?: boolean
  children: ReactNode
}

export function VenueScopeProvider({
  venueId,
  orgId,
  venueName,
  orgName,
  level,
  groupId,
  groupName,
  aiName,
  isDemo,
  children,
}: VenueScopeProviderProps) {
  const router = useRouter()

  const initial = useMemo<VenueScope>(
    () => ({
      venueId,
      orgId,
      venueName: venueName ?? null,
      orgName: orgName ?? null,
      level: level ?? 'venue',
      groupId: groupId ?? null,
      groupName: groupName ?? null,
      aiName: (aiName && aiName.trim()) || 'your AI assistant',
      isDemo: Boolean(isDemo),
    }),
    [venueId, orgId, venueName, orgName, level, groupId, groupName, aiName, isDemo],
  )

  const [scope, setScopeState] = useState<VenueScope>(initial)

  // Track the most recent initial we wrote into state, so we can tell
  // when the SSR-resolved scope diverges from what we have in memory
  // (e.g. middleware cleared the demo cookie, profile.venue_id changed
  // out of band, or a parallel tab logged the user out and back in).
  // When that happens we adopt the server value — that's the new truth.
  const lastSyncedRef = useRef<VenueScope>(initial)

  useEffect(() => {
    if (lastSyncedRef.current === initial) return
    lastSyncedRef.current = initial
    setScopeState((prev) => {
      // Skip the sync when the in-memory value already matches the
      // new SSR value (the common case: setScope→cookie write→
      // router.refresh→same layout re-render). Comparing by value
      // rather than reference because `initial` is a fresh object.
      if (
        prev.venueId === initial.venueId &&
        prev.level === initial.level &&
        prev.groupId === initial.groupId &&
        prev.aiName === initial.aiName &&
        prev.orgId === initial.orgId
      ) {
        return prev
      }
      return initial
    })
  }, [initial])

  const setScope = useCallback(
    (patch: ScopePatch) => {
      setScopeState((prev) => {
        // Guard against no-op updates so we don't burn a router.refresh()
        // round-trip when the user clicks the venue they're already on.
        const nextLevel = patch.level ?? prev.level
        const nextVenueId = patch.venueId ?? prev.venueId
        const nextGroupId = patch.groupId === undefined ? prev.groupId : patch.groupId
        const noChange =
          nextLevel === prev.level &&
          nextVenueId === prev.venueId &&
          nextGroupId === prev.groupId
        if (noChange) return prev

        const next: VenueScope = {
          ...prev,
          level: nextLevel,
          venueId: nextVenueId,
          venueName: patch.venueName === undefined ? prev.venueName : patch.venueName,
          orgId: patch.orgId === undefined ? prev.orgId : patch.orgId,
          orgName: patch.orgName === undefined ? prev.orgName : patch.orgName,
          groupId: nextGroupId,
          groupName: patch.groupName === undefined ? prev.groupName : patch.groupName,
          aiName:
            patch.aiName === undefined
              ? prev.aiName
              : (patch.aiName && patch.aiName.trim()) || 'your AI assistant',
        }

        writeScopeCookies(next)
        // Re-render server components against the new cookie. This is
        // the bridge that keeps SSR data consistent with the in-memory
        // store on the very next paint — no full reload, no flash.
        // router.refresh() is a no-op on the initial mount while
        // hydration is still in flight, so we schedule it on the next
        // microtask to avoid the "Cannot update a component while
        // rendering a different component" warning.
        Promise.resolve().then(() => router.refresh())
        return next
      })
    },
    [router],
  )

  const value = useMemo<ScopeStore>(() => ({ scope, setScope }), [scope, setScope])

  return <VenueScopeContext.Provider value={value}>{children}</VenueScopeContext.Provider>
}

/**
 * Read the venue scope. MUST be rendered inside a platform route — callers
 * outside the (platform) layout (couple portal, marketing pages) won't
 * have the provider and this will throw. Intentional: a default would
 * silently regress the empty-venue-id bug we paid GAP-09 to fix.
 */
export function useVenueScope(): VenueScope {
  const ctx = useContext(VenueScopeContext)
  if (!ctx) {
    throw new Error(
      'useVenueScope() used outside VenueScopeProvider. Wrap your route in the (platform) layout.',
    )
  }
  return ctx.scope
}

/**
 * Mutate the venue scope. Use from the scope switcher and from any page
 * that lets the coordinator pick a venue (settings landing,
 * intel/portfolio, intel/benchmark). Updates propagate synchronously to
 * every `useVenueScope()` consumer; cookies + RSC refresh follow.
 */
export function useScopeMutator(): (patch: ScopePatch) => void {
  const ctx = useContext(VenueScopeContext)
  if (!ctx) {
    throw new Error(
      'useScopeMutator() used outside VenueScopeProvider. Wrap your route in the (platform) layout.',
    )
  }
  return ctx.setScope
}
