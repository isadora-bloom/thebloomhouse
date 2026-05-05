import type { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  tierMeetsMinimum,
  TIER_DISPLAY,
  type PlanTier,
} from '@/lib/auth/plan-tiers'
import { recordCounter } from '@/lib/observability/metrics'

// ---------------------------------------------------------------------------
// requirePlan — API-layer plan tier enforcement (PROJECT-AUDIT-V2 GAP-12).
//
// Reads the authenticated user's venue.plan_tier via Supabase. If the tier
// meets the required minimum, returns { ok: true }. Otherwise returns a
// discriminated-union failure with an HTTP status + message callers can
// surface directly.
//
// Demo mode (bloom_demo=true cookie) bypasses the check via an EXPLICIT
// `isDemo` early return — mirrors the behavior of usePlanTier on the
// client (which defaults to 'enterprise' for demo) and getPlatformAuth on
// the server. The bypass is explicit (not implicit) so a code-search for
// "demo bypass" lands here directly. The YC demo + any landing-page
// /demo flow walk through these endpoints with the cookie set; without
// this branch the demo coordinator's plan_tier lookup would fail (no
// venues row owned by the demo session).
//
// Every block path emits a `plan_gate_block` counter into metered_events
// so we can graph tier-bypass attempts per route. recordCounter is fire-
// and-forget; observability writes never fail the caller's request.
// ---------------------------------------------------------------------------

export type RequirePlanResult =
  | { ok: true; isDemo: boolean }
  | { ok: false; status: 401; message: string }
  | { ok: false; status: 402 | 403; message: string; requiredTier: PlanTier; currentTier: PlanTier }

/**
 * Resolve the route name from the request URL for metrics.
 * Falls back to '/api/unknown' if the URL can't be parsed.
 */
function routeNameFromRequest(request: NextRequest | Request | null): string {
  if (!request) return '/api/unknown'
  try {
    const url = new URL(request.url)
    return url.pathname
  } catch {
    return '/api/unknown'
  }
}

export async function requirePlan(
  request: NextRequest | Request | null,
  minTier: PlanTier
): Promise<RequirePlanResult> {
  const route = routeNameFromRequest(request)

  // Demo mode bypass — EXPLICIT early return. The bloom_demo cookie
  // unlocks every paid feature in the product (it's how the YC demo +
  // landing-page /demo entry work). Mirrors usePlanTier's default of
  // 'enterprise' on the client. Without this branch, demo coordinators
  // would 403 on /api/intel/* the moment they hit a paid feature.
  const cookieStore = await cookies()
  if (cookieStore.get('bloom_demo')?.value === 'true') {
    return { ok: true, isDemo: true }
  }

  // Resolve the authenticated user.
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    void recordCounter('plan_gate_block', {
      dimension: { tier: minTier, route, reason: 'unauthenticated' },
    })
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
    void recordCounter('plan_gate_block', {
      dimension: { tier: minTier, route, reason: 'no_profile' },
    })
    return { ok: false, status: 401, message: 'No profile associated with this account' }
  }

  let resolvedVenueId = profile.venue_id as string | null
  if (!resolvedVenueId) {
    const isAdmin = profile.role === 'org_admin' || profile.role === 'super_admin'
    if (!isAdmin || !profile.org_id) {
      void recordCounter('plan_gate_block', {
        dimension: { tier: minTier, route, reason: 'no_venue' },
      })
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
      void recordCounter('plan_gate_block', {
        dimension: { tier: minTier, route, reason: 'no_venue' },
      })
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
    return { ok: true, isDemo: false }
  }

  void recordCounter('plan_gate_block', {
    venueId: resolvedVenueId,
    dimension: {
      tier: minTier,
      route,
      reason: 'insufficient_tier',
      current_tier: currentTier,
    },
  })

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
