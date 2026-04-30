/**
 * Re-engagement queue (Phase D Tier 2 / D2.1).
 *
 * Surfaces candidates who engaged DEEPLY on a tracked vendor
 * platform but never inquired with the venue. The coordinator can
 * draft a re-engagement message and send it through the platform's
 * DM tool (Knot/IG/etc.) or via email when the candidate has a
 * known address.
 *
 * Cohort definition:
 *   funnel_depth >= 3                — multiple distinct engagement
 *                                       actions (view + save + message,
 *                                       or any 3 distinct types)
 *   resolved_wedding_id IS NULL      — never inquired
 *   last_seen >= now - 90d           — hasn't gone cold yet
 *   no existing re_engagement_action — don't send a second message
 *                                       (reach-out fatigue)
 *
 * Privacy posture (locked 2026-04-30 with user):
 *   - OFF BY DEFAULT per venue. Coordinator opts in via the toggle
 *     in venue_config.feature_flags.re_engagement_enabled.
 *   - Drafted messages reference platform engagement at the genre
 *     level only ("you've been browsing wedding venues") — never
 *     specific signal counts or actions.
 *   - No surveillance phrasing ("I noticed you saved us 3 times").
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const COHORT_FUNNEL_THRESHOLD = 3
export const COHORT_LAST_SEEN_DAYS = 90

export interface ReEngagementCandidate {
  candidate_id: string
  source_platform: string
  first_name: string | null
  last_initial: string | null
  state: string | null
  funnel_depth: number
  signal_count: number
  action_counts: Record<string, number> | null
  first_seen: string | null
  last_seen: string | null
}

export interface ReEngagementQueue {
  /** When false, the venue has not opted into re-engagement. UI
   *  should render an opt-in CTA, not the candidate list. */
  enabled: boolean
  /** Candidates eligible for re-engagement. Empty when enabled=false. */
  candidates: ReEngagementCandidate[]
  /** How many candidates already have a re_engagement_action row
   *  (drafted, sent, or discarded). Surfaces "you've already
   *  re-engaged 5 candidates this week" feedback. */
  already_actioned: number
}

/** Read the per-venue opt-in flag from venue_config.feature_flags. */
export async function isReEngagementEnabled(
  sb: SupabaseClient,
  venueId: string,
): Promise<boolean> {
  const { data } = await sb
    .from('venue_config')
    .select('feature_flags')
    .eq('venue_id', venueId)
    .maybeSingle()
  const flags = ((data as { feature_flags: Record<string, unknown> | null } | null)?.feature_flags) ?? {}
  return Boolean(flags.re_engagement_enabled)
}

export async function setReEngagementEnabled(
  sb: SupabaseClient,
  venueId: string,
  enabled: boolean,
): Promise<void> {
  const { data: row } = await sb
    .from('venue_config')
    .select('feature_flags')
    .eq('venue_id', venueId)
    .maybeSingle()
  const current = ((row as { feature_flags: Record<string, unknown> | null } | null)?.feature_flags) ?? {}
  const next = { ...current, re_engagement_enabled: enabled }
  if (row) {
    await sb.from('venue_config').update({ feature_flags: next }).eq('venue_id', venueId)
  } else {
    await sb.from('venue_config').insert({ venue_id: venueId, feature_flags: next })
  }
}

export async function getReEngagementQueue(
  sb: SupabaseClient,
  venueId: string,
): Promise<ReEngagementQueue> {
  const enabled = await isReEngagementEnabled(sb, venueId)
  if (!enabled) {
    return { enabled: false, candidates: [], already_actioned: 0 }
  }

  const cutoffIso = new Date(Date.now() - COHORT_LAST_SEEN_DAYS * 86_400_000).toISOString()
  const { data: cands } = await sb
    .from('candidate_identities')
    .select('id, source_platform, first_name, last_initial, state, funnel_depth, signal_count, action_counts, first_seen, last_seen')
    .eq('venue_id', venueId)
    .gte('funnel_depth', COHORT_FUNNEL_THRESHOLD)
    .is('resolved_wedding_id', null)
    .is('deleted_at', null)
    .gte('last_seen', cutoffIso)
    .order('last_seen', { ascending: false })
    .limit(100)
  const rawRows = (cands ?? []) as Array<{
    id: string
    source_platform: string
    first_name: string | null
    last_initial: string | null
    state: string | null
    funnel_depth: number
    signal_count: number
    action_counts: Record<string, number> | null
    first_seen: string | null
    last_seen: string | null
  }>

  if (rawRows.length === 0) return { enabled: true, candidates: [], already_actioned: 0 }

  // Exclude candidates that already have a re_engagement_action.
  const ids = rawRows.map((r) => r.id)
  const { data: prior } = await sb
    .from('re_engagement_actions')
    .select('candidate_identity_id')
    .eq('venue_id', venueId)
    .in('candidate_identity_id', ids)
  const priorSet = new Set<string>()
  for (const p of (prior ?? []) as Array<{ candidate_identity_id: string }>) priorSet.add(p.candidate_identity_id)

  const candidates: ReEngagementCandidate[] = rawRows
    .filter((r) => !priorSet.has(r.id))
    .map((r) => ({
      candidate_id: r.id,
      source_platform: r.source_platform,
      first_name: r.first_name,
      last_initial: r.last_initial,
      state: r.state,
      funnel_depth: r.funnel_depth,
      signal_count: r.signal_count,
      action_counts: r.action_counts,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
    }))

  return {
    enabled: true,
    candidates,
    already_actioned: priorSet.size,
  }
}
