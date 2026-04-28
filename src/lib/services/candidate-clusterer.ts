/**
 * Candidate-identity clusterer (Phase B / PB.2).
 *
 * Takes freshly-inserted tangential_signals rows and groups them into
 * candidate_identities. The Knot CSV has the same "Sarah R." showing
 * up as view + save + message across a few days — that's one
 * candidate identity with three signals attached, not three separate
 * identities. Funnel depth (number of distinct action_classes) is the
 * confidence boost when matching a candidate to a wedding later.
 *
 * Cluster fingerprint (per-platform, per-venue):
 *   first_name (case-insensitive)
 *   last_initial (case-insensitive)
 *   non-conflicting state (a candidate with state='VA' won't accept a
 *     signal with state='TX'; null state accepts any, and an
 *     incoming non-null state fills in a previously-null candidate)
 *
 * Cluster windows (locked 2026-04-28):
 *   ≤14d gap between signal_date and candidate.last_seen → auto-attach (clean)
 *   14-30d gap → attach but mark review_status='needs_review'
 *   >30d gap → create a NEW candidate, share cluster_group_key with
 *     prior candidates of the same fingerprint so the coordinator
 *     review UI can group them
 *
 * Anonymous signals (no first_name — the 250+ ". " rows from Knot)
 * are LEFT WITHOUT a candidate. They count for ROI volume metrics
 * but never resolve to a wedding.
 *
 * Idempotency: re-running the clusterer on signals already attached
 * to a candidate is a no-op. Re-running on new signals only attaches
 * the new ones; existing cluster boundaries are stable.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const AUTO_CLUSTER_DAYS = 14
const REVIEW_CLUSTER_DAYS = 30

export interface ClustererSummary {
  signals_processed: number
  signals_skipped_anonymous: number
  signals_attached_to_existing: number
  signals_creating_new_cluster: number
  candidates_flagged_for_review: number
  errors: string[]
}

interface SignalRow {
  id: string
  venue_id: string
  source_platform: string | null
  signal_date: string | null
  action_class: string | null
  candidate_identity_id: string | null
  extracted_identity: Record<string, unknown> | null
}

interface CandidateRow {
  id: string
  venue_id: string
  source_platform: string
  first_name: string | null
  last_initial: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  username: string | null
  city: string | null
  state: string | null
  country: string | null
  cluster_group_key: string | null
  signal_count: number
  funnel_depth: number
  action_counts: Record<string, number> | null
  first_seen: string | null
  last_seen: string | null
  review_status: string
}

interface SignalFingerprint {
  first_name: string | null
  last_initial: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  username: string | null
  city: string | null
  state: string | null
  country: string | null
}

/**
 * Pull fingerprint fields from extracted_identity jsonb. Lower-cases
 * comparison-keyed fields up-front; persisted candidate uses the
 * lower-cased value for exact-match indexes.
 */
function extractFingerprint(signal: SignalRow): SignalFingerprint {
  const ei = signal.extracted_identity ?? {}
  return {
    first_name: ((ei.first_name as string | null) ?? '').toLowerCase().trim() || null,
    last_initial: ((ei.last_initial as string | null) ?? '').toLowerCase().trim() || null,
    last_name: ((ei.last_name as string | null) ?? '').toLowerCase().trim() || null,
    email: ((ei.email as string | null) ?? '').toLowerCase().trim() || null,
    phone: ((ei.phone as string | null) ?? '').trim() || null,
    username: ((ei.username as string | null) ?? '').toLowerCase().trim() || null,
    city: ((ei.city as string | null) ?? '').toLowerCase().trim() || null,
    state: ((ei.state as string | null) ?? '').toLowerCase().trim() || null,
    country: ((ei.country as string | null) ?? '').toLowerCase().trim() || null,
  }
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime())
  return ms / 86_400_000
}

/**
 * Cluster_group_key is stable across re-runs for the same identity
 * fingerprint on the same venue + platform. Long-gap candidates of
 * the same fingerprint share this key so the review UI can group
 * them without auto-merging.
 */
function clusterGroupKey(venueId: string, platform: string, fp: SignalFingerprint): string {
  const fn = fp.first_name ?? '_'
  const li = fp.last_initial ?? '_'
  const st = fp.state ?? '_'
  return `${venueId.slice(0, 8)}|${platform}|${fn}|${li}|${st}`
}

/**
 * State conflict: a candidate with state='VA' cannot accept a signal
 * with state='TX'. Either-side null is fine (and we fill in the
 * candidate's null with the signal's value when attaching).
 */
function statesConflict(candidateState: string | null, signalState: string | null): boolean {
  if (!candidateState || !signalState) return false
  return candidateState.toLowerCase() !== signalState.toLowerCase()
}

/**
 * Find the best existing candidate to attach this signal to.
 *
 * Returns null when:
 *   - no candidate matches the fingerprint at all
 *   - all candidates with matching fingerprint are >30d away (caller
 *     creates a new candidate sharing the cluster_group_key)
 */
async function findClusterCandidate(
  supabase: SupabaseClient,
  signal: SignalRow,
  fp: SignalFingerprint,
): Promise<{ candidate: CandidateRow; gapDays: number } | null> {
  if (!signal.source_platform || !signal.signal_date) return null
  if (!fp.first_name || !fp.last_initial) return null

  const { data, error } = await supabase
    .from('candidate_identities')
    .select('*')
    .eq('venue_id', signal.venue_id)
    .eq('source_platform', signal.source_platform)
    .eq('first_name', fp.first_name)
    .eq('last_initial', fp.last_initial)
    .is('deleted_at', null)
    .order('last_seen', { ascending: false })

  if (error || !data || data.length === 0) return null

  const eligible = (data as CandidateRow[])
    .filter((c) => !statesConflict(c.state, fp.state))
    .map((c) => {
      const candDate = c.last_seen ?? c.first_seen
      const gap = candDate ? daysBetween(candDate, signal.signal_date!) : Infinity
      return { candidate: c, gapDays: gap }
    })
    .filter((x) => x.gapDays <= REVIEW_CLUSTER_DAYS)
    .sort((a, b) => a.gapDays - b.gapDays)

  return eligible[0] ?? null
}

/**
 * Update candidate aggregates after attaching one new signal.
 * action_counts gets the action_class incremented; funnel_depth is
 * the count of distinct action_class keys with a value > 0;
 * first/last_seen widen the window; signal_count increments.
 *
 * If the gap is in the 14-30d review zone, review_status is bumped
 * to 'needs_review' (unless coordinator already 'reviewed' it).
 */
async function attachSignalToCandidate(
  supabase: SupabaseClient,
  candidate: CandidateRow,
  signal: SignalRow,
  fp: SignalFingerprint,
  gapDays: number,
): Promise<{ flaggedForReview: boolean; error?: string }> {
  const action = signal.action_class ?? 'other'
  const newActionCounts: Record<string, number> = { ...(candidate.action_counts ?? {}) }
  newActionCounts[action] = (newActionCounts[action] ?? 0) + 1
  const newFunnelDepth = Object.keys(newActionCounts).filter((k) => newActionCounts[k] > 0).length
  const newSignalCount = (candidate.signal_count ?? 0) + 1

  const candFirst = candidate.first_seen ? new Date(candidate.first_seen).getTime() : Infinity
  const candLast = candidate.last_seen ? new Date(candidate.last_seen).getTime() : -Infinity
  const sigTs = new Date(signal.signal_date!).getTime()
  const newFirstSeen = sigTs < candFirst ? signal.signal_date! : candidate.first_seen
  const newLastSeen = sigTs > candLast ? signal.signal_date! : candidate.last_seen

  const flaggedForReview =
    gapDays > AUTO_CLUSTER_DAYS && candidate.review_status !== 'reviewed'

  const update: Record<string, unknown> = {
    signal_count: newSignalCount,
    funnel_depth: newFunnelDepth,
    action_counts: newActionCounts,
    first_seen: newFirstSeen,
    last_seen: newLastSeen,
  }
  if (flaggedForReview) update.review_status = 'needs_review'
  if (!candidate.state && fp.state) update.state = fp.state
  if (!candidate.city && fp.city) update.city = fp.city
  if (!candidate.last_name && fp.last_name) update.last_name = fp.last_name
  if (!candidate.email && fp.email) update.email = fp.email
  if (!candidate.phone && fp.phone) update.phone = fp.phone
  if (!candidate.username && fp.username) update.username = fp.username

  const { error: updErr } = await supabase
    .from('candidate_identities')
    .update(update)
    .eq('id', candidate.id)
  if (updErr) return { flaggedForReview, error: `candidate update ${candidate.id}: ${updErr.message}` }

  const { error: linkErr } = await supabase
    .from('tangential_signals')
    .update({ candidate_identity_id: candidate.id })
    .eq('id', signal.id)
  if (linkErr) return { flaggedForReview, error: `signal link ${signal.id}: ${linkErr.message}` }

  return { flaggedForReview }
}

/**
 * Mint a new candidate from a single signal. If a sibling cluster
 * already exists for this fingerprint (long-gap split), share the
 * cluster_group_key so the coordinator review UI can group them.
 */
async function createCandidate(
  supabase: SupabaseClient,
  signal: SignalRow,
  fp: SignalFingerprint,
  existingClusterGroupKey: string | null,
): Promise<{ id: string | null; error?: string }> {
  const action = signal.action_class ?? 'other'
  const groupKey = existingClusterGroupKey ?? clusterGroupKey(signal.venue_id, signal.source_platform!, fp)

  const insertRow = {
    venue_id: signal.venue_id,
    source_platform: signal.source_platform!,
    first_name: fp.first_name,
    last_initial: fp.last_initial,
    last_name: fp.last_name,
    email: fp.email,
    phone: fp.phone,
    username: fp.username,
    city: fp.city,
    state: fp.state,
    country: fp.country,
    cluster_group_key: groupKey,
    signal_count: 1,
    funnel_depth: 1,
    action_counts: { [action]: 1 },
    first_seen: signal.signal_date,
    last_seen: signal.signal_date,
    review_status: 'clean',
  }

  const { data, error } = await supabase
    .from('candidate_identities')
    .insert(insertRow)
    .select('id')
    .single()
  if (error || !data) return { id: null, error: `candidate insert: ${error?.message ?? 'no data'}` }

  const { error: linkErr } = await supabase
    .from('tangential_signals')
    .update({ candidate_identity_id: data.id })
    .eq('id', signal.id)
  if (linkErr) return { id: data.id, error: `signal link ${signal.id}: ${linkErr.message}` }

  return { id: data.id }
}

/**
 * For a fingerprint with NO eligible existing candidate within 30d
 * but maybe candidates >30d away, look up the cluster_group_key from
 * the most recent same-fingerprint candidate so the new one inherits
 * it. Otherwise return null and createCandidate will mint a fresh key.
 */
async function findExistingClusterGroupKey(
  supabase: SupabaseClient,
  signal: SignalRow,
  fp: SignalFingerprint,
): Promise<string | null> {
  if (!signal.source_platform || !fp.first_name || !fp.last_initial) return null
  const { data } = await supabase
    .from('candidate_identities')
    .select('cluster_group_key')
    .eq('venue_id', signal.venue_id)
    .eq('source_platform', signal.source_platform)
    .eq('first_name', fp.first_name)
    .eq('last_initial', fp.last_initial)
    .is('deleted_at', null)
    .not('cluster_group_key', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
  return ((data?.[0] as { cluster_group_key: string | null } | undefined)?.cluster_group_key) ?? null
}

/**
 * Cluster one signal. Idempotent — if the signal already has
 * candidate_identity_id set, this is a no-op.
 */
async function clusterOneSignal(
  supabase: SupabaseClient,
  signal: SignalRow,
  summary: ClustererSummary,
): Promise<void> {
  summary.signals_processed++

  if (signal.candidate_identity_id) {
    return
  }

  const fp = extractFingerprint(signal)
  if (!fp.first_name || !fp.last_initial) {
    summary.signals_skipped_anonymous++
    return
  }
  if (!signal.source_platform || !signal.signal_date) {
    summary.signals_skipped_anonymous++
    return
  }

  const found = await findClusterCandidate(supabase, signal, fp)
  if (found) {
    const { flaggedForReview, error } = await attachSignalToCandidate(
      supabase,
      found.candidate,
      signal,
      fp,
      found.gapDays,
    )
    if (error) {
      summary.errors.push(error)
      return
    }
    summary.signals_attached_to_existing++
    if (flaggedForReview) summary.candidates_flagged_for_review++
    return
  }

  const groupKey = await findExistingClusterGroupKey(supabase, signal, fp)
  const { error } = await createCandidate(supabase, signal, fp, groupKey)
  if (error) {
    summary.errors.push(error)
    return
  }
  summary.signals_creating_new_cluster++
}

/**
 * Cluster a batch of signals (e.g. all signals from one CSV import).
 * Processes serially so within-batch attaches see the candidates that
 * earlier signals in the batch just created — Sarah R view followed
 * by Sarah R save in the same import lands on the SAME candidate.
 */
export async function clusterSignals(args: {
  supabase: SupabaseClient
  signalIds: readonly string[]
}): Promise<ClustererSummary> {
  const { supabase, signalIds } = args
  const summary: ClustererSummary = {
    signals_processed: 0,
    signals_skipped_anonymous: 0,
    signals_attached_to_existing: 0,
    signals_creating_new_cluster: 0,
    candidates_flagged_for_review: 0,
    errors: [],
  }

  if (signalIds.length === 0) return summary

  const FETCH_CHUNK = 200
  const signals: SignalRow[] = []
  for (let i = 0; i < signalIds.length; i += FETCH_CHUNK) {
    const chunkIds = signalIds.slice(i, i + FETCH_CHUNK)
    const { data, error } = await supabase
      .from('tangential_signals')
      .select('id, venue_id, source_platform, signal_date, action_class, candidate_identity_id, extracted_identity')
      .in('id', chunkIds as string[])
    if (error) {
      summary.errors.push(`fetch signals @${i}: ${error.message}`)
      continue
    }
    signals.push(...((data ?? []) as SignalRow[]))
  }

  signals.sort((a, b) => {
    const ad = a.signal_date ?? ''
    const bd = b.signal_date ?? ''
    return ad.localeCompare(bd)
  })

  for (const s of signals) {
    await clusterOneSignal(supabase, s, summary)
  }

  return summary
}

/**
 * Re-cluster every signal for a venue (or for a venue + platform).
 * Used by the cross-venue historical backfill (PB.7) and the nightly
 * safety sweep (PB.8). Stable cluster boundaries — re-running on
 * existing-attached signals is a no-op.
 */
export async function reclusterVenue(args: {
  supabase: SupabaseClient
  venueId: string
  platform?: string
}): Promise<ClustererSummary> {
  const { supabase, venueId, platform } = args
  const summary: ClustererSummary = {
    signals_processed: 0,
    signals_skipped_anonymous: 0,
    signals_attached_to_existing: 0,
    signals_creating_new_cluster: 0,
    candidates_flagged_for_review: 0,
    errors: [],
  }

  const PAGE = 1000
  let from = 0
  for (;;) {
    let q = supabase
      .from('tangential_signals')
      .select('id, venue_id, source_platform, signal_date, action_class, candidate_identity_id, extracted_identity')
      .eq('venue_id', venueId)
      .is('candidate_identity_id', null)
      .order('signal_date', { ascending: true, nullsFirst: false })
      .range(from, from + PAGE - 1)
    if (platform) q = q.eq('source_platform', platform)
    const { data, error } = await q
    if (error) {
      summary.errors.push(`recluster fetch @${from}: ${error.message}`)
      break
    }
    const page = (data ?? []) as SignalRow[]
    for (const s of page) await clusterOneSignal(supabase, s, summary)
    if (page.length < PAGE) break
    from += PAGE
  }

  return summary
}
