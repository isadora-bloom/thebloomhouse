/**
 * capacity-enforcement — the honest half of CAPACITY_LIMITS.
 *
 * Before this file, CAPACITY_LIMITS (src/lib/auth/plan-tiers.ts) was only
 * ever read from unit tests (2026-09-08 audit finding) — a venue could mint
 * ten times its plan's monthly inquiry cap and nothing in the product would
 * know. The fix is deliberately NOT a block: losing a real couple's inquiry
 * because a venue happened to have a good month is worse than the venue
 * getting a free inquiry past its cap. So this module never stops a mint —
 * it only detects the cap was crossed and tells the venue honestly, via an
 * admin notification (surfaces in Pulse / the notification bell) and the
 * /settings/billing usage section.
 *
 * Single call site: src/lib/services/identity/mint-wedding.ts, fired
 * fire-and-forget only when a NEW wedding/couple was minted (not on an
 * attach-to-existing match) — mintWedding is the one chokepoint every
 * entry path (email, sms, web form, CSV/CRM import, brain-dump, manual
 * admin) already routes through, so instrumenting it here covers all of
 * them without touching any of those call sites.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { createNotification } from '@/lib/services/admin-notifications'
import { resolveBillingState } from '@/lib/services/billing/billing-state'

export const CAPACITY_CAP_HIT_NOTIFICATION_TYPE = 'capacity_cap_hit'

export interface CapacityCheckResult {
  checked: boolean
  overCap: boolean
  used: number
  limit: number | null
}

/**
 * Counts this-month inquiries against the venue's effective
 * inquiriesPerMonth cap, reading the spine (`couples.created_at`,
 * matching the wave-2 shared rule that no new read should hit a legacy
 * table where couples/touchpoints already holds the same fact — a mint
 * always dual-writes a couples row via mirrorCoupleFromWedding, fired
 * from the same mintWedding call just above this one) rather than
 * `weddings`. If over cap, fires a deduplicated admin notification
 * (5-minute window, see admin-notifications.ts) — repeated over-cap
 * mints in the same burst collapse to one notification, they don't spam.
 *
 * Never throws. Fire-and-forget from the caller's point of view: errors
 * are logged and swallowed so a capacity-check failure can never affect
 * whether the underlying mint succeeded.
 *
 * Note on timing: the couples mirror write is itself fire-and-forget
 * from mintWedding, so on a fresh mint this count can very occasionally
 * run one beat before that row lands and undercount by one. That's a
 * cosmetic race, not a correctness bug — the next mint in the same month
 * re-derives the true count from scratch.
 */
export async function checkAndRecordCapacityHit(
  venueId: string,
  supabase?: SupabaseClient,
): Promise<CapacityCheckResult> {
  const notChecked: CapacityCheckResult = { checked: false, overCap: false, used: 0, limit: null }
  if (!venueId) return notChecked

  try {
    const client = supabase ?? createServiceClient()
    const state = await resolveBillingState(venueId, client)
    const limit = state.effectiveCapacity.inquiriesPerMonth
    // null = unlimited (enterprise tier) — nothing to enforce.
    if (limit === null) return { checked: true, overCap: false, used: 0, limit: null }

    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()

    const { count, error } = await client
      .from('couples')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .is('merged_into_id', null)
      .gte('created_at', monthStart) // created-at-ok: the cap counts couples minted this month; the mint is the event, and the check only notifies, never blocks

    if (error) {
      console.error('[capacity-enforcement] couples count failed:', error.message)
      return notChecked
    }

    const used = count ?? 0
    const overCap = used > limit
    if (!overCap) return { checked: true, overCap: false, used, limit }

    await createNotification({
      venueId,
      type: CAPACITY_CAP_HIT_NOTIFICATION_TYPE,
      title: 'Monthly inquiry cap reached',
      body: state.isTrial
        ? `You've received ${used} inquiries this month, past your trial's ${limit}/mo evaluation cap. Every lead is still being captured and Sage keeps working normally — nothing is blocked. Subscribe from /settings/billing to raise your cap.`
        : `You've received ${used} inquiries this month, past your ${state.storedTier} plan's ${limit}/mo cap. Every lead is still being captured and Sage keeps working normally — nothing is blocked. Upgrade from /settings/billing to raise your cap.`,
      priority: 'high',
    })

    return { checked: true, overCap: true, used, limit }
  } catch (err) {
    console.error('[capacity-enforcement] checkAndRecordCapacityHit failed:', err instanceof Error ? err.message : err)
    return notChecked
  }
}
