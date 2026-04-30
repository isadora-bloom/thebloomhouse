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

/**
 * Conversion-attribution sweep — 60-day window after sent_at.
 *
 * For each sent re_engagement_action whose conversion window is
 * still open, look for a wedding that arrived within 60 days of
 * the send and whose primary person matches the candidate's
 * first_name + last_initial. If a unique match exists, attribute.
 *
 * Conservative on ambiguity: if 2+ weddings match, leave
 * conversion_wedding_id NULL and let the coordinator decide via
 * the existing /intel/candidates queue. Better no-attribution
 * than wrong-attribution.
 */
export async function sweepReEngagementConversions(
  sb: SupabaseClient,
): Promise<{
  scanned: number
  attributed: number
  ambiguous: number
  windows_closed: number
}> {
  const summary = { scanned: 0, attributed: 0, ambiguous: 0, windows_closed: 0 }
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString()

  // Find sent actions still inside their 60-day window with no
  // attribution yet.
  const { data: actions } = await sb
    .from('re_engagement_actions')
    .select('id, venue_id, candidate_identity_id, sent_at, channel')
    .not('sent_at', 'is', null)
    .neq('channel', 'discarded')
    .is('conversion_wedding_id', null)

  for (const a of (actions ?? []) as Array<{ id: string; venue_id: string; candidate_identity_id: string; sent_at: string; channel: string | null }>) {
    summary.scanned++

    // Window-closed check: if sent_at < 60 days ago, the window
    // has already expired. Stamp conversion_detected_at to lock
    // it as "no conversion within window" so the sweep skips it
    // next time. Treat conversion_wedding_id NULL as "we tried
    // and found no match"; we use a sentinel update via
    // conversion_inquiry_channel='no_conversion' rather than
    // creating a new column.
    if (a.sent_at < sixtyDaysAgo) {
      // Skip — windows that closed without conversion stay in this
      // query forever otherwise. We could mark them but the table
      // is small; lazy approach is fine until volume grows.
      summary.windows_closed++
      continue
    }

    const { data: cand } = await sb
      .from('candidate_identities')
      .select('first_name, last_initial')
      .eq('id', a.candidate_identity_id)
      .maybeSingle()
    const c = cand as { first_name: string | null; last_initial: string | null } | null
    if (!c?.first_name || !c.last_initial) continue

    // Find weddings created within ±2d before sent_at to 60d after,
    // at this venue, with at least one person matching the
    // candidate's name. We allow a small window before sent_at
    // because timestamps can drift slightly between server clock
    // and email arrival; coordinator confirmed 2-day grace.
    const windowStart = new Date(new Date(a.sent_at).getTime() - 2 * 86_400_000).toISOString()
    const windowEnd = new Date(new Date(a.sent_at).getTime() + 60 * 86_400_000).toISOString()
    const { data: people } = await sb
      .from('people')
      .select('wedding_id, first_name, last_name, weddings!inner(id, venue_id, inquiry_date)')
      .ilike('first_name', c.first_name)
      .ilike('last_name', `${c.last_initial}%`)
    const matches: Array<{ wedding_id: string; inquiry_date: string }> = []
    for (const p of ((people ?? []) as unknown as Array<{ wedding_id: string; weddings: { id: string; venue_id: string; inquiry_date: string | null } | null }>)) {
      const w = p.weddings
      if (!w || w.venue_id !== a.venue_id) continue
      if (!w.inquiry_date || w.inquiry_date < windowStart || w.inquiry_date > windowEnd) continue
      if (!matches.some((m) => m.wedding_id === w.id)) {
        matches.push({ wedding_id: w.id, inquiry_date: w.inquiry_date })
      }
    }

    if (matches.length === 0) continue
    if (matches.length > 1) {
      summary.ambiguous++
      continue
    }

    const match = matches[0]
    // Determine inquiry channel by looking at the first inbound
    // interaction's source attribution.
    const { data: firstTp } = await sb
      .from('wedding_touchpoints')
      .select('source')
      .eq('wedding_id', match.wedding_id)
      .eq('touch_type', 'inquiry')
      .order('occurred_at', { ascending: true })
      .limit(1)
    const inquiryChannel = ((firstTp?.[0] as { source: string | null } | undefined)?.source) ?? null

    await sb
      .from('re_engagement_actions')
      .update({
        conversion_wedding_id: match.wedding_id,
        conversion_detected_at: new Date().toISOString(),
        conversion_inquiry_channel: inquiryChannel,
      })
      .eq('id', a.id)
    summary.attributed++
  }

  return summary
}

/**
 * Aggregate ROI numbers for the /intel/sources panel.
 *   drafted    — total re_engagement_actions for venue (any state)
 *   sent       — sent_at not null AND channel != 'discarded'
 *   discarded  — channel = 'discarded'
 *   converted  — conversion_wedding_id not null
 *   conversionRate — converted / sent (0-1)
 */
export async function getReEngagementMetrics(
  sb: SupabaseClient,
  venueId: string,
): Promise<{
  drafted: number
  sent: number
  discarded: number
  converted: number
  conversionRate: number
}> {
  const { data: rows } = await sb
    .from('re_engagement_actions')
    .select('id, sent_at, channel, conversion_wedding_id')
    .eq('venue_id', venueId)
  const all = (rows ?? []) as Array<{ sent_at: string | null; channel: string | null; conversion_wedding_id: string | null }>
  const drafted = all.length
  const discarded = all.filter((r) => r.channel === 'discarded').length
  const sent = all.filter((r) => r.sent_at && r.channel !== 'discarded').length
  const converted = all.filter((r) => r.conversion_wedding_id !== null).length
  return {
    drafted,
    sent,
    discarded,
    converted,
    conversionRate: sent > 0 ? converted / sent : 0,
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
