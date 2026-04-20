import type { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  tierMeetsMinimum,
  TIER_DISPLAY,
  type PlanTier,
} from '@/lib/auth/plan-tiers'

// ---------------------------------------------------------------------------
// requirePlan — API-layer plan tier enforcement
//
// Reads the authenticated user's venue.plan_tier via Supabase. If the tier
// meets the required minimum, returns { ok: true }. Otherwise returns a
// discriminated-union failure with an HTTP status + message callers can
// surface directly.
//
// Demo mode (bloom_demo=true cookie) bypasses the check — mirrors the
// behavior of usePlanTier on the client and getPlatformAuth on the server.
// ---------------------------------------------------------------------------

export type RequirePlanResult =
  | { ok: true }
  | { ok: false; status: 401; message: string }
  | { ok: false; status: 402 | 403; message: string; requiredTier: PlanTier; currentTier: PlanTier }

export async function requirePlan(
  // Accepted for future use (e.g. pulling specific headers). Currently unused.
  _request: NextRequest | Request | null,
  minTier: PlanTier
): Promise<RequirePlanResult> {
  // Demo mode always passes — demo has access to everything.
  const cookieStore = await cookies()
  if (cookieStore.get('bloom_demo')?.value === 'true') {
    return { ok: true }
  }

  // Resolve the authenticated user.
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { ok: false, status: 401, message: 'Unauthorized' }
  }

  // Look up the user's venue and the venue's plan tier. For org-level
  // admins with no venue scoped, fall back to the first venue in their org
  // (mirrors getPlatformAuth).
  const service = createServiceClient()
  const { data: profile } = await service
    .from('user_profiles')
    .select('venue_id, org_id, role')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return { ok: false, status: 401, message: 'No profile associated with this account' }
  }

  let resolvedVenueId = profile.venue_id as string | null
  if (!resolvedVenueId) {
    const isAdmin = profile.role === 'org_admin' || profile.role === 'super_admin'
    if (!isAdmin || !profile.org_id) {
      return { ok: false, status: 401, message: 'No venue associated with this account' }
    }
    const { data: firstVenue } = await service
      .from('venues')
      .select('id')
      .eq('org_id', profile.org_id as string)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    resolvedVenueId = (firstVenue?.id as string | undefined) ?? null
    if (!resolvedVenueId) {
      return { ok: false, status: 401, message: 'No venue associated with this account' }
    }
  }

  const { data: venue } = await service
    .from('venues')
    .select('plan_tier')
    .eq('id', resolvedVenueId)
    .single()

  const currentTier = (venue?.plan_tier as PlanTier | undefined) ?? 'starter'

  if (tierMeetsMinimum(currentTier, minTier)) {
    return { ok: true }
  }

  const display = TIER_DISPLAY[minTier]
  return {
    ok: false,
    status: 403,
    message: `Upgrade to ${display.name} to access this feature`,
    requiredTier: minTier,
    currentTier,
  }
}

// ---------------------------------------------------------------------------
// Helper — builds a NextResponse JSON payload matching the shape documented
// in GAP-12: { error, required_tier, message }. Status codes:
//   401 — not authenticated
//   403 — authenticated but on a lower plan
// ---------------------------------------------------------------------------

export function planErrorBody(result: Exclude<RequirePlanResult, { ok: true }>) {
  if (result.status === 401) {
    return { error: 'unauthorized', message: result.message }
  }
  return {
    error: 'plan_required',
    required_tier: result.requiredTier,
    current_tier: result.currentTier,
    message: result.message,
  }
}
