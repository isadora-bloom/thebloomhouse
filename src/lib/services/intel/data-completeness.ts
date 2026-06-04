/**
 * Data-completeness self-report (battery Q30: "what % of my last-90-day
 * inquiries does Bloom have complete records for, versus partial?").
 *
 * Spine-only, injectable. For couples CREATED in the trailing window
 * (default 90d), report how many are COMPLETE versus PARTIAL:
 *   - complete = reachable identifier (email OR phone) AND ≥1 touchpoint
 *   - partial  = missing a reachable identifier, OR zero touchpoints
 *               (an orphaned/identity-poor record with a gap)
 *
 * Honest by construction: every count carries its denominator; the fraction
 * is null (never a fake 0/100%) when there are no couples in the window. The
 * `partialReasons` split tells the operator WHY records are partial so the
 * answer is actionable, not just a percentage.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface DataCompleteness {
  windowDays: number
  couplesInWindow: number
  complete: number
  partial: number
  /** complete / couplesInWindow — null when the window is empty. */
  completeFraction: number | null
  /** Why the partial ones are partial (a couple can count in both). */
  partialReasons: {
    noReachableIdentifier: number
    noTouchpoints: number
  }
  generatedAt: string
}

interface CoupleRow {
  id: string
  primary_contact_email: string | null
  primary_contact_phone: string | null
}

export async function loadDataCompleteness(
  supabase: SupabaseClient,
  venueId: string,
  now = Date.now(),
  windowDays = 90,
): Promise<DataCompleteness> {
  const generatedAt = new Date(now).toISOString()
  const empty: DataCompleteness = {
    windowDays,
    couplesInWindow: 0,
    complete: 0,
    partial: 0,
    completeFraction: null,
    partialReasons: { noReachableIdentifier: 0, noTouchpoints: 0 },
    generatedAt,
  }
  if (!venueId) return empty

  const cutoff = new Date(now - windowDays * 86_400_000).toISOString()
  const { data: coupleData } = await supabase
    .from('couples')
    .select('id, primary_contact_email, primary_contact_phone')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .gte('created_at', cutoff)
    .limit(10000)
  const couples = (coupleData ?? []) as CoupleRow[]
  if (couples.length === 0) return empty

  // Which of these couples have ≥1 touchpoint.
  const ids = new Set(couples.map((c) => c.id))
  const withTp = new Set<string>()
  const { data: tpData } = await supabase
    .from('touchpoints')
    .select('couple_id')
    .eq('venue_id', venueId)
    .gte('occurred_at', cutoff)
    .limit(50000)
  for (const t of (tpData ?? []) as Array<{ couple_id: string | null }>) {
    if (t.couple_id && ids.has(t.couple_id)) withTp.add(t.couple_id)
  }

  let complete = 0
  let noReachableIdentifier = 0
  let noTouchpoints = 0
  for (const c of couples) {
    const reachable = Boolean((c.primary_contact_email ?? '').trim() || (c.primary_contact_phone ?? '').trim())
    const hasTp = withTp.has(c.id)
    if (reachable && hasTp) {
      complete++
    } else {
      if (!reachable) noReachableIdentifier++
      if (!hasTp) noTouchpoints++
    }
  }

  const couplesInWindow = couples.length
  return {
    windowDays,
    couplesInWindow,
    complete,
    partial: couplesInWindow - complete,
    completeFraction: couplesInWindow > 0 ? Math.round((complete / couplesInWindow) * 1000) / 1000 : null,
    partialReasons: { noReachableIdentifier, noTouchpoints },
    generatedAt,
  }
}
