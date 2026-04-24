import { cache } from 'react'
import { cookies } from 'next/headers'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// resolvePlatformScope
//
// Called from the (platform) layout on every platform-route render to
// determine which venue is in scope — SERVER-SIDE, before any child page
// runs its fetch.
//
// Resolution order:
//   1. Demo mode (bloom_demo cookie)        → Hawthorne
//   2. bloom_venue cookie, validated against the user's org_id
//   3. user_profiles.venue_id
//   4. For org_admin / super_admin: first venue in their org
//   5. null → caller redirects to /setup or /login
//
// Why SERVER-SIDE: client-only resolution (the old useVenueId hook)
// produces an SSR/CSR hydration mismatch and a race window where every
// child fetch fires with `venue_id=eq.` (empty string) before the cookie
// is read. Resolving in the layout makes venueId available synchronously
// on every render — no guards, no loading states, no hydration warning.
// ---------------------------------------------------------------------------

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'
const DEMO_ORG_ID = '11111111-1111-1111-1111-111111111111'
const DEMO_VENUE_NAME = 'Hawthorne Manor'
const DEMO_ORG_NAME = 'The Crestwood Collection'

export interface PlatformScope {
  venueId: string
  orgId: string | null
  isDemo: boolean
  venueName: string | null
  orgName: string | null
  /** Scope level chosen by the user — read from bloom_scope cookie. */
  level: 'venue' | 'group' | 'company'
  /** Group id, when level === 'group'. */
  groupId: string | null
  /** Group display name for ScopeIndicator — fetched inline for group scope. */
  groupName: string | null
}

/**
 * Parse the bloom_scope cookie safely. Returns level + groupId only;
 * venueId + venueName we still resolve through the usual code paths so
 * validation + fallbacks stay centralized.
 */
function parseScopeCookie(raw: string | undefined): { level: 'venue' | 'group' | 'company'; groupId: string | null } {
  if (!raw) return { level: 'venue', groupId: null }
  try {
    const parsed = JSON.parse(raw) as { level?: string; groupId?: string }
    if (parsed?.level === 'group' || parsed?.level === 'company') {
      return { level: parsed.level, groupId: (parsed.groupId as string | undefined) ?? null }
    }
    return { level: 'venue', groupId: null }
  } catch {
    return { level: 'venue', groupId: null }
  }
}

/**
 * Fetch venue + org names for the scope SSR-side. Kept as a tight helper
 * so resolvePlatformScope stays readable. Service-role client bypasses RLS
 * since this feeds the trusted layout, not user output.
 *
 * Wrapped in React.cache so multiple server components in one render pass
 * (layout + nested server components) reuse the same fetch. React.cache
 * scopes memoization to a single request — no cross-request pollution.
 */
const fetchNames = cache(
  async (
    venueId: string,
    orgId: string | null
  ): Promise<{ venueName: string | null; orgName: string | null }> => {
    const service = createServiceClient()
    const [vRes, oRes] = await Promise.all([
      service.from('venues').select('name').eq('id', venueId).maybeSingle(),
      orgId
        ? service.from('organisations').select('name').eq('id', orgId).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    return {
      venueName: (vRes.data?.name as string | undefined) ?? null,
      orgName: (oRes.data?.name as string | undefined) ?? null,
    }
  }
)

/**
 * Resolve groupName if level === 'group' and groupId is present + belongs
 * to the user's org. Null otherwise. Also React.cache-wrapped.
 */
const resolveGroupName = cache(
  async (groupId: string | null, profileOrgId: string | null): Promise<string | null> => {
    if (!groupId || !profileOrgId) return null
    const service = createServiceClient()
    const { data } = await service
      .from('venue_groups')
      .select('name, org_id')
      .eq('id', groupId)
      .maybeSingle()
    if (!data || data.org_id !== profileOrgId) return null
    return (data.name as string | undefined) ?? null
  }
)

export const resolvePlatformScope = cache(_resolvePlatformScope)

/**
 * Expand a scope into the list of venue_ids it covers. API routes use
 * this to turn a single `.eq('venue_id', ...)` hardcode into a scope-
 * aware `.in('venue_id', ids)` filter, so company-level users actually
 * get aggregate numbers instead of "the first venue".
 *
 *   venue  → [scope.venueId]
 *   group  → venues that are members of the chosen group (same org only)
 *   company → every venue in the user's org
 *
 * Returns [] when the resolution fails (no venues in org, stale group,
 * etc.) so callers can short-circuit to an empty-result response instead
 * of falling back to "all rows" via RLS.
 */
export const resolveScopeVenueIds = cache(async (): Promise<string[]> => {
  const scope = await resolvePlatformScope()
  if (!scope) return []
  const service = createServiceClient()

  if (scope.level === 'venue') return [scope.venueId]

  if (scope.level === 'group' && scope.groupId && scope.orgId) {
    const { data: group } = await service
      .from('venue_groups')
      .select('org_id')
      .eq('id', scope.groupId)
      .maybeSingle()
    if (!group || group.org_id !== scope.orgId) return [scope.venueId]
    const { data } = await service
      .from('venue_group_members')
      .select('venue_id')
      .eq('group_id', scope.groupId)
    return (data ?? []).map((r) => r.venue_id as string)
  }

  if (scope.level === 'company' && scope.orgId) {
    const { data } = await service
      .from('venues')
      .select('id')
      .eq('org_id', scope.orgId)
    return (data ?? []).map((v) => v.id as string)
  }

  return [scope.venueId]
})

async function _resolvePlatformScope(): Promise<PlatformScope | null> {
  const cookieStore = await cookies()
  const scopeCookie = parseScopeCookie(cookieStore.get('bloom_scope')?.value)

  // 1. Demo mode — no auth, no validation, Hawthorne. Names inline so
  // we avoid a DB roundtrip on every demo page.
  if (cookieStore.get('bloom_demo')?.value === 'true') {
    return {
      venueId: DEMO_VENUE_ID,
      orgId: DEMO_ORG_ID,
      isDemo: true,
      venueName: DEMO_VENUE_NAME,
      orgName: DEMO_ORG_NAME,
      level: scopeCookie.level,
      groupId: scopeCookie.groupId,
      groupName: null,
    }
  }

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const service = createServiceClient()
  const { data: profile } = await service
    .from('user_profiles')
    .select('venue_id, org_id, role')
    .eq('id', user.id)
    .maybeSingle()

  const profileOrgId = (profile?.org_id as string | null) ?? null
  const groupName = await resolveGroupName(scopeCookie.groupId, profileOrgId)

  const build = (venueId: string, names: { venueName: string | null; orgName: string | null }): PlatformScope => ({
    venueId,
    orgId: profileOrgId,
    isDemo: false,
    venueName: names.venueName,
    orgName: names.orgName,
    level: scopeCookie.level,
    groupId: scopeCookie.groupId,
    groupName,
  })

  // 2. Cookie venue — validate it belongs to the user's org before trusting.
  const cookieVenue = cookieStore.get('bloom_venue')?.value
  if (cookieVenue && profileOrgId) {
    const { data: v } = await service
      .from('venues')
      .select('id, org_id')
      .eq('id', cookieVenue)
      .maybeSingle()
    if (v && v.org_id === profileOrgId) {
      return build(v.id as string, await fetchNames(v.id as string, profileOrgId))
    }
    // Stale or cross-org cookie — ignore and fall through.
  }

  // 3. Profile venue.
  const profileVenue = (profile?.venue_id as string | null) ?? null
  if (profileVenue) {
    return build(profileVenue, await fetchNames(profileVenue, profileOrgId))
  }

  // 4. Admin fallback — first venue in org.
  const role = profile?.role as string | undefined
  if (profileOrgId && (role === 'org_admin' || role === 'super_admin')) {
    const { data: firstVenue } = await service
      .from('venues')
      .select('id')
      .eq('org_id', profileOrgId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (firstVenue?.id) {
      return build(firstVenue.id as string, await fetchNames(firstVenue.id as string, profileOrgId))
    }
  }

  // 5. No venue — caller decides whether to redirect to /setup or /login.
  return null
}
