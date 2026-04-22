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

export interface PlatformScope {
  venueId: string
  orgId: string | null
  isDemo: boolean
}

export async function resolvePlatformScope(): Promise<PlatformScope | null> {
  const cookieStore = await cookies()

  // 1. Demo mode — no auth, no validation, Hawthorne.
  if (cookieStore.get('bloom_demo')?.value === 'true') {
    return { venueId: DEMO_VENUE_ID, orgId: DEMO_ORG_ID, isDemo: true }
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

  // 2. Cookie venue — validate it belongs to the user's org before trusting.
  const cookieVenue = cookieStore.get('bloom_venue')?.value
  if (cookieVenue && profileOrgId) {
    const { data: v } = await service
      .from('venues')
      .select('id, org_id')
      .eq('id', cookieVenue)
      .maybeSingle()
    if (v && v.org_id === profileOrgId) {
      return { venueId: v.id as string, orgId: profileOrgId, isDemo: false }
    }
    // Stale or cross-org cookie — ignore and fall through.
  }

  // 3. Profile venue.
  const profileVenue = (profile?.venue_id as string | null) ?? null
  if (profileVenue) {
    return { venueId: profileVenue, orgId: profileOrgId, isDemo: false }
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
      return { venueId: firstVenue.id as string, orgId: profileOrgId, isDemo: false }
    }
  }

  // 5. No venue — caller decides whether to redirect to /setup or /login.
  return null
}
