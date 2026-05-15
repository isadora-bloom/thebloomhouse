/**
 * Phase B Instagram source adapter.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §1 (Channel-Scoped) + §4.
 *
 * Instagram is the canonical partial-identity channel. A row has
 * a username + display name and that's it. Two Instagram signals
 * with the same handle = same person on Instagram. Instagram signal
 * + Calendly booking with matching name = promotion candidate.
 *
 * Source breakdown
 * ----------------
 *   candidate_identities WHERE source_platform='instagram' — the
 *     clustered per-account view (Wave 4-8 already grouped signals
 *     by username). Each row = one IG account at this venue.
 *   tangential_signals WHERE signal_type IN ('instagram_engagement',
 *     'instagram_follow') — raw events (DMs, story replies). Used
 *     by the Tracer's coalescence stage to enrich the cluster.
 *
 * This adapter walks candidate_identities only — same rationale as
 * knot.ts (the clusterer already did the hard work). The raw
 * tangential_signals get tied in via the cluster id during the
 * cross_channel_coalesce stage.
 */

import type { NormalizedSignal, SourceAdapter, SourceAdapterArgs } from './types'

interface CandidateRow {
  id: string
  first_name: string | null
  last_initial: string | null
  last_name: string | null
  username: string | null
  email: string | null
  city: string | null
  state: string | null
  signal_count: number | null
  funnel_depth: number | null
  action_counts: Record<string, unknown> | null
  first_seen: string | null
  last_seen: string | null
  resolved_wedding_id: string | null
  review_status: string | null
  deleted_at: string | null
}

async function* walk(
  args: SourceAdapterArgs,
): AsyncIterable<NormalizedSignal> {
  const { supabase, venueId, since, batchSize = 500 } = args
  let offset = 0
  while (true) {
    let q = supabase
      .from('candidate_identities')
      .select(
        'id, first_name, last_initial, last_name, username, email, city, state, signal_count, funnel_depth, action_counts, first_seen, last_seen, resolved_wedding_id, review_status, deleted_at',
      )
      .eq('venue_id', venueId)
      .eq('source_platform', 'instagram')
      .is('deleted_at', null)
      .order('first_seen', { ascending: true, nullsFirst: true })
      .range(offset, offset + batchSize - 1)
    if (since) q = q.gte('last_seen', since)
    const { data, error } = await q
    if (error) throw new Error(`instagram: ${error.message}`)
    const rows = (data ?? []) as CandidateRow[]
    if (rows.length === 0) break

    for (const c of rows) {
      const occurred = c.first_seen ?? c.last_seen ?? new Date().toISOString()
      const fullName =
        c.last_name && c.first_name
          ? `${c.first_name} ${c.last_name}`
          : c.first_name && c.last_initial
            ? `${c.first_name} ${c.last_initial}.`
            : c.first_name ?? null
      const tier: NormalizedSignal['signal_tier'] =
        (c.funnel_depth ?? 0) >= 2 ? 'medium' : 'low'
      yield {
        external_id: c.id,
        channel: 'instagram',
        action_type: 'channel_engagement',
        occurred_at: occurred,
        signal_tier: tier,
        identity_hint: fullName ?? (c.username ? `@${c.username}` : null),
        primary_name: fullName,
        primary_email: c.email,
        raw_payload: {
          candidate_identity_id: c.id,
          username: c.username,
          first_name: c.first_name,
          last_initial: c.last_initial,
          last_name: c.last_name,
          city: c.city,
          state: c.state,
          signal_count: c.signal_count,
          funnel_depth: c.funnel_depth,
          action_counts: c.action_counts ?? {},
          first_seen: c.first_seen,
          last_seen: c.last_seen,
          review_status: c.review_status,
        },
        legacy_wedding_id: c.resolved_wedding_id,
      }
    }
    if (rows.length < batchSize) break
    offset += batchSize
  }
}

const adapter: SourceAdapter = { name: 'instagram', channel: 'instagram', walk }
export default adapter
