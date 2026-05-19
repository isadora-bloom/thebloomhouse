/**
 * Phase B Knot / WeddingWire source adapter.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §1 (Channel-Scoped Person
 * tier) + §4 step 2 + §5 (Temporal Coalescence).
 *
 * Knot and WeddingWire are partial-identity channels: a row has a
 * first name + last initial + state. Doctrine §1: these stay as
 * 'channel_scoped' couples (not yet Resolved) until a cross-channel
 * bridge event (Calendly with email, inquiry form with phone, ...)
 * promotes them to 'resolved'.
 *
 * Source
 * ------
 * Wave-4-8 already clusters per-platform identities into
 * `candidate_identities` (one row per probable person per platform).
 * That's our input. Each candidate_identities row is yielded as
 * ONE channel-scoped signal carrying the cluster's aggregate
 * stats. The Tracer then either:
 *   - matches it to an existing couple (operator confirmed earlier,
 *     resolved_wedding_id set on the cluster) → attaches touchpoint
 *     to that couple
 *   - matches it to an existing couple via the matcher (name + date
 *     window) → high/medium tier
 *   - stores as a Channel-Scoped couple (new row with
 *     lifecycle_state='channel_scoped', channel_scope='knot')
 *
 * Why we read candidate_identities, not raw tangential_signals
 * ------------------------------------------------------------
 * Wave 4-8's clusterer already did the per-platform person
 * inference (the hard part). Re-running that work in the Tracer
 * would duplicate effort and risk drift. The Tracer reads the
 * clusterer's output, treats each cluster as one Channel-Scoped
 * proposal, and lets the matcher decide whether to promote it.
 */

import type { NormalizedSignal, SourceAdapter, SourceAdapterArgs } from './types'

// candidate_identities.source_platform carries the value the storefront
// importer / clusterer wrote. The canonical values (normalize-source.ts)
// are `the_knot` / `wedding_wire` / `zola`; the legacy short forms
// `knot` / `weddingwire` are kept so older rows still match. The
// pre-2026-05-18 list was `['knot','weddingwire','wedding_wire']`, which
// missed every `the_knot` row — i.e. the entire real dataset.
const KNOT_PLATFORMS = [
  'the_knot',
  'knot',
  'wedding_wire',
  'weddingwire',
  'zola',
] as const

interface CandidateRow {
  id: string
  source_platform: string | null
  first_name: string | null
  last_initial: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  username: string | null
  city: string | null
  state: string | null
  country: string | null
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
        'id, source_platform, first_name, last_initial, last_name, email, phone, username, city, state, country, signal_count, funnel_depth, action_counts, first_seen, last_seen, resolved_wedding_id, review_status, deleted_at',
      )
      .eq('venue_id', venueId)
      .in('source_platform', KNOT_PLATFORMS as unknown as string[])
      .is('deleted_at', null)
      .order('first_seen', { ascending: true, nullsFirst: true })
      .range(offset, offset + batchSize - 1)
    if (since) q = q.gte('last_seen', since)
    const { data, error } = await q
    if (error) throw new Error(`knot: ${error.message}`)
    const rows = (data ?? []) as CandidateRow[]
    if (rows.length === 0) break

    for (const c of rows) {
      const occurred =
        c.first_seen ?? c.last_seen ?? new Date().toISOString()
      const platform = (c.source_platform ?? 'knot').toLowerCase()
      // funnel_depth ≥3 (view+save+message) is high signal on this
      // platform; depth 1 is low. Maps to doctrine §1 'medium_high'
      // vs 'low'.
      const tier: NormalizedSignal['signal_tier'] =
        (c.funnel_depth ?? 0) >= 3
          ? 'medium_high'
          : (c.funnel_depth ?? 0) >= 2
            ? 'medium'
            : 'low'
      const fullName =
        c.last_name && c.first_name
          ? `${c.first_name} ${c.last_name}`
          : c.first_name && c.last_initial
            ? `${c.first_name} ${c.last_initial}.`
            : c.first_name ?? null
      yield {
        external_id: c.id,
        channel: platform,
        action_type: 'channel_engagement',
        occurred_at: occurred,
        signal_tier: tier,
        identity_hint: fullName,
        primary_name: fullName,
        primary_email: c.email,
        primary_phone: c.phone,
        raw_payload: {
          candidate_identity_id: c.id,
          first_name: c.first_name,
          last_initial: c.last_initial,
          last_name: c.last_name,
          username: c.username,
          city: c.city,
          state: c.state,
          country: c.country,
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

const adapter: SourceAdapter = {
  name: 'knot',
  channel: 'knot',
  walk,
}

export default adapter
