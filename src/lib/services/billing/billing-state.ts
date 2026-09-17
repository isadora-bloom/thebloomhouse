/**
 * billing-state — resolves what a venue's billing is ACTUALLY entitled to,
 * as opposed to the bare `venues.plan_tier` column (which defaults to
 * 'solo' at the DB level and never expires on its own — see migration 215
 * and migration 395).
 *
 * Why this exists
 * ----------------
 * The 2026-09-08 two-month-readiness audit found billing was decorative:
 * a venue that never enters a card keeps full Solo-tier access forever
 * because plan_tier's DB default is 'solo', not because anyone decided
 * they should have it. There was no trial concept at all: no expiry, no
 * banner, no distinction in the UI between "paying" and "never paid."
 *
 * `trial` here is an APP-LAYER state, not a PlanTier value. PlanTier
 * (src/lib/auth/plan-tiers.ts) stays a closed 5-tier ladder used by
 * requirePlan's minimum-tier gate and by Stripe checkout/webhook — adding
 * a sixth member to that union would ripple into every Record<PlanTier,_>
 * across the app (CAPACITY_LIMITS, TIER_RANK, TIER_DISPLAY, the pricing
 * page, the webhook's tier mapper) for a distinction those call sites
 * don't need. A venue is "on trial" here precisely when it has never had
 * a real Stripe subscription (stripe_subscription_id IS NULL) — Stripe's
 * own 'trialing' subscription_status is a different thing (it requires a
 * card on file) and is handled entirely by require-plan.ts already.
 *
 * Consumers:
 *   - src/app/api/billing/trial-status/route.ts — the banner + billing page
 *   - src/lib/services/email/autonomous-sender.ts — forces auto-send off
 *     once the trial has expired with no subscription
 *   - src/lib/services/billing/capacity-enforcement.ts — picks which
 *     CAPACITY_LIMITS row applies to a never-subscribed venue
 *
 * Since 2026-09-17 an expired trial also FREEZES the account (migration
 * 417). That is not decided here: public.venue_is_frozen() in the
 * database is the rule, and src/lib/services/billing/venue-freeze.ts is
 * how the app asks it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { CAPACITY_LIMITS, type PlanTier, type CapacityLimits } from '@/lib/auth/plan-tiers'

/** Trial length applied to a venue with no trial_ends_at recorded at all
 *  (defensive fallback only — migration 395's DB default + backfill mean
 *  every venue should already have one). Keep in sync with the comment
 *  on migration 395 and the DB column default. */
export const TRIAL_LENGTH_DAYS = 14

export interface BillingState {
  venueId: string
  /** The committed plan_tier column value (defaults 'solo' — see header). */
  storedTier: PlanTier
  /** True when the venue has never had a Stripe subscription. */
  isTrial: boolean
  trialEndsAt: string | null
  /** True only when isTrial AND trialEndsAt has passed. A subscribed
   *  venue is never "expired" here, even if it later cancels — the
   *  canceled/past_due states are require-plan.ts's job. */
  trialExpired: boolean
  daysRemaining: number | null
  subscriptionStatus: string | null
  /** The capacity row that actually applies: the venue's stored tier once
   *  it has ever subscribed, or the pre_opening (smallest, cheapest) tier
   *  as the honest baseline for a venue that has never paid. */
  effectiveCapacity: CapacityLimits
}

interface VenueBillingRow {
  plan_tier: string | null
  subscription_status: string | null
  stripe_subscription_id: string | null
  trial_ends_at: string | null
}

const KNOWN_TIERS = new Set<PlanTier>(['pre_opening', 'solo', 'growth', 'multi', 'enterprise'])

function coerceTier(value: string | null): PlanTier {
  return value && KNOWN_TIERS.has(value as PlanTier) ? (value as PlanTier) : 'solo'
}

/**
 * Reads the venue's billing row and resolves the honest state. Never
 * throws — a lookup failure resolves to "not on trial, not expired" so a
 * DB hiccup never blocks the platform (the failure IS logged by the
 * caller's own error handling where relevant). The hard block on an
 * expired trial is the freeze (venue-freeze.ts, migration 417), which
 * doesn't read this.
 */
export async function resolveBillingState(
  venueId: string,
  supabase?: SupabaseClient,
): Promise<BillingState> {
  const client = supabase ?? createServiceClient()

  const empty: BillingState = {
    venueId,
    storedTier: 'solo',
    isTrial: false,
    trialEndsAt: null,
    trialExpired: false,
    daysRemaining: null,
    subscriptionStatus: null,
    effectiveCapacity: CAPACITY_LIMITS.solo,
  }

  if (!venueId) return empty

  // .limit(1) rather than .single()/.maybeSingle() — deliberately, so this
  // query shape matches the generic Supabase mock builder already used by
  // src/lib/services/__tests__/autonomous-sender.test.ts (which only
  // implements select/eq/gte/in/limit/then). A venue lookup miss there
  // resolves to an empty array, i.e. the `empty` fallback above, which is
  // exactly "not on trial" — the same fail-open behaviour as a real DB
  // miss.
  let data: unknown
  try {
    const result = await client
      .from('venues')
      .select('plan_tier, subscription_status, stripe_subscription_id, trial_ends_at')
      .eq('id', venueId)
      .limit(1)
    data = result.data
  } catch (err) {
    console.error('[billing-state] venue lookup failed:', err instanceof Error ? err.message : err)
    return empty
  }

  const row = (Array.isArray(data) ? data[0] : data) as VenueBillingRow | undefined
  if (!row) return empty

  const storedTier = coerceTier(row.plan_tier)
  const isTrial = !row.stripe_subscription_id
  const trialEndsAt = row.trial_ends_at ?? null

  let trialExpired = false
  let daysRemaining: number | null = null
  if (isTrial && trialEndsAt) {
    const endMs = new Date(trialEndsAt).getTime()
    if (Number.isFinite(endMs)) {
      const diffMs = endMs - Date.now()
      trialExpired = diffMs <= 0
      daysRemaining = trialExpired ? 0 : Math.ceil(diffMs / (24 * 60 * 60 * 1000))
    }
  }

  return {
    venueId,
    storedTier,
    isTrial,
    trialEndsAt,
    trialExpired,
    daysRemaining,
    subscriptionStatus: row.subscription_status ?? null,
    // Honest capacity: a venue that has never paid gets the smallest,
    // cheapest tier's caps (pre_opening — "for venues not yet open" is
    // the closest fit for "hasn't committed to a plan yet"), not the
    // 'solo' default the DB column happens to carry.
    effectiveCapacity: isTrial ? CAPACITY_LIMITS.pre_opening : CAPACITY_LIMITS[storedTier],
  }
}

/**
 * Cheap boolean check for gates that only need the yes/no answer (the
 * auto-send dispatch path). Mirrors the shape of
 * src/lib/services/cost-ceiling.ts:isAutonomousPaused so the two read the
 * same way at call sites. Never throws.
 */
export async function isTrialExpiredNoSub(venueId: string, supabase?: SupabaseClient): Promise<boolean> {
  try {
    const state = await resolveBillingState(venueId, supabase)
    return state.trialExpired
  } catch (err) {
    console.error('[billing-state] isTrialExpiredNoSub lookup failed:', err instanceof Error ? err.message : err)
    return false
  }
}
