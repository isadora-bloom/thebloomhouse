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
import { verifyDemoToken, DEMO_TOKEN_COOKIE } from '@/lib/services/demo-token'

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
//
// Plan-tier cache: a 30-second in-process Map-based cache eliminates the
// 4 DB round-trips (auth.getUser + user_profiles + optional org venues
// query + venues.plan_tier) on every gated API request. Cache is keyed
// on userId, holds the resolved PlanTier for 30 seconds, then evicts.
// Demo sessions are excluded — they don't have a real userId and return
// early before any DB work.
//
// IMPORTANT: This cache is per-process. On Vercel Fluid Compute all
// invocations in the same warm instance share the Map. This is fine —
// plan-tier changes (upgrades/downgrades) propagate within 30 seconds, and
// the cache is on the resolved tier (not auth tokens), so a token refresh
// doesn't cause stale reads.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 30-second in-memory plan-tier cache (no external dependency).
// ---------------------------------------------------------------------------

const TIER_CACHE_TTL_MS = 30_000
const TIER_CACHE_MAX_SIZE = 1_000

interface TierCacheEntry {
  tier: PlanTier
  expiresAt: number
}

const tierCache = new Map<string, TierCacheEntry>()

function getCachedTier(userId: string): PlanTier | null {
  const entry = tierCache.get(userId)
  if (!entry || Date.now() > entry.expiresAt) {
    tierCache.delete(userId)
    return null
  }
  return entry.tier
}

function setCachedTier(userId: string, tier: PlanTier): void {
  // Evict expired entries when the cache grows large. A Map.forEach
  // delete-while-iterating is safe in V8 for entries visited before
  // the current cursor.
  if (tierCache.size >= TIER_CACHE_MAX_SIZE) {
    const now = Date.now()
    for (const [k, v] of tierCache) {
      if (now > v.expiresAt) tierCache.delete(k)
    }
  }
  tierCache.set(userId, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS })
}

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

  // Demo mode bypass — EXPLICIT early return. A valid HMAC-signed
  // bloom_demo_token cookie (HttpOnly, server-minted) unlocks every paid
  // feature in the product for the YC demo and landing-page /demo flows.
  // Raw cookie forgery (DevTools) no longer works because the unsigned
  // `bloom_demo=true` value is never checked here.
  const cookieStore = await cookies()
  const demoVerify = verifyDemoToken(cookieStore.get(DEMO_TOKEN_COOKIE)?.value)
  if (demoVerify.ok) {
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

  // Cache hit — skip the 4 DB hops entirely.
  const cachedTier = getCachedTier(user.id)
  if (cachedTier !== null) {
    if (tierMeetsMinimum(cachedTier, minTier)) {
      return { ok: true, isDemo: false }
    }
    void recordCounter('plan_gate_block', {
      dimension: { tier: minTier, route, reason: 'insufficient_tier', current_tier: cachedTier },
    })
    return {
      ok: false,
      status: 403,
      message: `Upgrade to ${TIER_DISPLAY[minTier].name} to access this feature`,
      requiredTier: minTier,
      currentTier: cachedTier,
    }
  }

  // Cache miss — resolve via DB. Look up the user's venue and the venue's
  // plan tier. For org-level admins with no venue scoped, fall back to the
  // first venue in their org (mirrors getPlatformAuth).
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
    .select('plan_tier, subscription_status, past_due_since, updated_at')
    .eq('id', resolvedVenueId)
    .single()

  const currentTier = (venue?.plan_tier as PlanTier | undefined) ?? 'solo'

  // ---------------------------------------------------------------------------
  // 7-day past-due grace period (Fix 5 / Wave B)
  //
  // When subscription_status = 'past_due' we grant a 7-day grace window
  // before downgrading access, so a coordinator mid-tour isn't locked out
  // the moment the first payment attempt fails. Stripe typically retries
  // over several days, so this window aligns with their retry schedule.
  //
  // past_due_since is stamped by the webhook on the first past_due event
  // for the current billing cycle and cleared when the subscription
  // returns to active. If it's NULL (e.g. the migration ran after the
  // webhook already fired), we fall back to updated_at as a conservative
  // proxy. If that too is absent, the grace period is treated as expired
  // to avoid granting access indefinitely on bad data.
  //
  // Venues in past_due are intentionally NOT written to the tier cache so
  // every request re-checks the DB. This ensures the grace-window
  // expiration is respected within the 7-day window without waiting for
  // the 30-second cache TTL.
  // ---------------------------------------------------------------------------
  if (venue?.subscription_status === 'past_due') {
    const pastDueSince = venue.past_due_since ?? venue.updated_at
    const gracePeriodMs = 7 * 24 * 60 * 60 * 1000
    if (pastDueSince && Date.now() - new Date(pastDueSince).getTime() < gracePeriodMs) {
      // Still within the 7-day grace window — allow the current tier.
      // Do NOT populate the tier cache: we need to re-check status on every
      // request so the expiry is enforced at day-boundary precision.
      return { ok: true, isDemo: false }
    }
    // Grace period expired. Pricing v2 has no free tier, so the prior
    // "treat as solo" fallback would always pass the new pre_opening
    // minimum gate — round-5 audit caught this as a free-platform hole.
    // Fail closed instead: the venue must update payment before
    // accessing gated features. Returns 402 so the client can route
    // to /settings/billing rather than show a generic 403.
    void recordCounter('plan_gate_block', {
      venueId: resolvedVenueId,
      dimension: { tier: minTier, route, reason: 'past_due_grace_expired', current_tier: currentTier },
    })
    return {
      ok: false,
      status: 402,
      message: 'Your subscription is past due. Update your payment method to restore access.',
      requiredTier: minTier,
      currentTier,
    }
  }

  // Canceled subscriptions (Round-5 audit fix). The webhook stamps
  // subscription_status='canceled' on customer.subscription.deleted but
  // also sets plan_tier='solo' (the placeholder baseline). Without this
  // explicit branch, a canceled venue keeps full platform access for
  // free until they re-subscribe. Fail closed; the venue can still hit
  // /settings/billing (which is gated separately) to re-subscribe.
  if (venue?.subscription_status === 'canceled') {
    void recordCounter('plan_gate_block', {
      venueId: resolvedVenueId,
      dimension: { tier: minTier, route, reason: 'subscription_canceled', current_tier: currentTier },
    })
    return {
      ok: false,
      status: 402,
      message: 'Your subscription has ended. Subscribe to restore access.',
      requiredTier: minTier,
      currentTier,
    }
  }

  // Populate cache before returning so subsequent requests within 30s skip
  // the DB round-trips entirely. (Past-due venues skip this — see above.)
  setCachedTier(user.id, currentTier)

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
