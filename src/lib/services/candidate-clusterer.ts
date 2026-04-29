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
 * Performance:
 *   - One SELECT to fetch all signals in the batch.
 *   - One SELECT per (venue, platform) group to fetch existing
 *     candidates (paginated past 1000).
 *   - All cluster decisions made in memory using a fingerprint index.
 *   - One INSERT for net-new candidates (returns IDs).
 *   - One UPSERT for existing candidate aggregate updates.
 *   - One UPDATE per affected candidate to write candidate_identity_id
 *     onto its newly-attached signals (N where N = affected
 *     candidates, NOT N where N = signal count).
 *
 * Round-trip count for a 1486-row Knot CSV producing ~250 clusters:
 * ~5 + 1 + 1 + 250 = ~260, down from ~4500 in the per-row version.
 *
 * Consistency: all writes for a (venue, platform) group are issued
 * after the in-memory model is fully resolved. A failure mid-batch
 * leaves a coherent partial state — not "candidate aggregates
 * incremented but signal not linked to candidate" as the per-row
 * version could.
 *
 * Cluster boundaries are immutable post-creation: reclusterVenue only
 * processes signals with candidate_identity_id IS NULL, so existing
 * cluster assignments never shift. The ordering of new arrivals
 * within their batch is deterministic (sorted by signal_date); across
 * batches a late-arriving earlier signal joins the closest existing
 * cluster within window — that's reality, not instability.
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
  /** IDs of candidates created or updated by this run. Caller can pass
   *  these to resolveVenueCandidates to scope resolution to just the
   *  ones that changed. */
  affected_candidate_ids: string[]
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

function emptySummary(): ClustererSummary {
  return {
    signals_processed: 0,
    signals_skipped_anonymous: 0,
    signals_attached_to_existing: 0,
    signals_creating_new_cluster: 0,
    candidates_flagged_for_review: 0,
    affected_candidate_ids: [],
    errors: [],
  }
}

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
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000
}

function clusterGroupKey(venueId: string, platform: string, fp: SignalFingerprint): string {
  const fn = fp.first_name ?? '_'
  const li = fp.last_initial ?? '_'
  const st = fp.state ?? '_'
  return `${venueId.slice(0, 8)}|${platform}|${fn}|${li}|${st}`
}

function statesConflict(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a.toLowerCase() !== b.toLowerCase()
}

/**
 * In-memory mutable cluster state. We mutate this as we process
 * signals; at the end of the batch we serialize to INSERT/UPSERT
 * statements.
 */
interface MutableCandidate {
  /** When isNew=true, this is a temp string key; otherwise it's the
   *  existing DB UUID. */
  tempId: string
  isNew: boolean
  /** The DB UUID. For new candidates, populated AFTER bulk insert. */
  dbId: string | null
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
  action_counts: Record<string, number>
  first_seen: string | null
  last_seen: string | null
  review_status: 'clean' | 'needs_review' | 'reviewed'
  /** True when at least one new attach happened in this batch. */
  dirty: boolean
  /** Signals attached to this cluster in THIS batch (for the final
   *  signals.candidate_identity_id update). */
  signal_ids_to_link: string[]
  /** Whether this cluster was bumped to needs_review by THIS batch
   *  (we don't downgrade 'reviewed' clusters). */
  bumped_to_review: boolean
}

function indexCandidatesByFingerprint(rows: CandidateRow[]): Map<string, MutableCandidate[]> {
  const map = new Map<string, MutableCandidate[]>()
  for (const r of rows) {
    if (!r.first_name || !r.last_initial) continue
    const key = `${r.first_name}|${r.last_initial}`
    const m: MutableCandidate = {
      tempId: r.id,
      isNew: false,
      dbId: r.id,
      venue_id: r.venue_id,
      source_platform: r.source_platform,
      first_name: r.first_name,
      last_initial: r.last_initial,
      last_name: r.last_name,
      email: r.email,
      phone: r.phone,
      username: r.username,
      city: r.city,
      state: r.state,
      country: r.country,
      cluster_group_key: r.cluster_group_key,
      signal_count: r.signal_count,
      funnel_depth: r.funnel_depth,
      action_counts: r.action_counts ?? {},
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      review_status: (r.review_status as 'clean' | 'needs_review' | 'reviewed') ?? 'clean',
      dirty: false,
      signal_ids_to_link: [],
      bumped_to_review: false,
    }
    const arr = map.get(key) ?? []
    arr.push(m)
    map.set(key, arr)
  }
  return map
}

async function fetchSignals(
  supabase: SupabaseClient,
  signalIds: readonly string[],
): Promise<SignalRow[]> {
  // PostgREST drops .in() filters once the URL gets too long. UUIDs are
  // 36 chars; ~100 per chunk keeps us safely under the ~8KB URL ceiling.
  // The earlier 200-per-chunk version was right at the cliff and could
  // silently truncate on larger imports.
  const FETCH_CHUNK = 100
  const out: SignalRow[] = []
  for (let i = 0; i < signalIds.length; i += FETCH_CHUNK) {
    const chunk = signalIds.slice(i, i + FETCH_CHUNK) as string[]
    const { data } = await supabase
      .from('tangential_signals')
      .select('id, venue_id, source_platform, signal_date, action_class, candidate_identity_id, extracted_identity')
      .in('id', chunk)
    out.push(...((data ?? []) as SignalRow[]))
  }
  return out
}

async function fetchExistingCandidates(
  supabase: SupabaseClient,
  venueId: string,
  platform: string,
): Promise<CandidateRow[]> {
  const PAGE = 1000
  let from = 0
  const out: CandidateRow[] = []
  for (;;) {
    const { data, error } = await supabase
      .from('candidate_identities')
      .select('id, venue_id, source_platform, first_name, last_initial, last_name, email, phone, username, city, state, country, cluster_group_key, signal_count, funnel_depth, action_counts, first_seen, last_seen, review_status')
      .eq('venue_id', venueId)
      .eq('source_platform', platform)
      .is('deleted_at', null)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`fetchExistingCandidates: ${error.message}`)
    const page = (data ?? []) as CandidateRow[]
    out.push(...page)
    if (page.length < PAGE) break
    from += PAGE
  }
  return out
}

/**
 * Apply one signal to the in-memory cluster index. Returns the
 * MutableCandidate it landed on (existing or freshly minted) so the
 * caller can track signal-to-candidate assignments.
 */
function applySignalInMemory(
  signal: SignalRow,
  fp: SignalFingerprint,
  index: Map<string, MutableCandidate[]>,
  newCandidates: MutableCandidate[],
): { candidate: MutableCandidate; flaggedForReview: boolean; isNewCluster: boolean } {
  const fingerprintKey = `${fp.first_name}|${fp.last_initial}`
  const action = signal.action_class ?? 'other'
  const sigDate = signal.signal_date!

  const existing = index.get(fingerprintKey) ?? []
  const eligible = existing
    .filter((c) => !statesConflict(c.state, fp.state))
    .map((c) => {
      const candDate = c.last_seen ?? c.first_seen
      const gap = candDate ? daysBetween(candDate, sigDate) : Infinity
      return { c, gap }
    })
    .filter((x) => x.gap <= REVIEW_CLUSTER_DAYS)
    .sort((a, b) => a.gap - b.gap)

  if (eligible.length > 0) {
    const target = eligible[0].c
    const flaggedForReview =
      eligible[0].gap > AUTO_CLUSTER_DAYS && target.review_status !== 'reviewed'

    target.action_counts[action] = (target.action_counts[action] ?? 0) + 1
    target.funnel_depth = Object.keys(target.action_counts).filter((k) => target.action_counts[k] > 0).length
    target.signal_count++

    const sigTs = new Date(sigDate).getTime()
    const fsTs = target.first_seen ? new Date(target.first_seen).getTime() : Infinity
    const lsTs = target.last_seen ? new Date(target.last_seen).getTime() : -Infinity
    if (sigTs < fsTs) target.first_seen = sigDate
    if (sigTs > lsTs) target.last_seen = sigDate

    if (flaggedForReview) {
      target.review_status = 'needs_review'
      target.bumped_to_review = true
    }
    if (!target.state && fp.state) target.state = fp.state
    if (!target.city && fp.city) target.city = fp.city
    if (!target.last_name && fp.last_name) target.last_name = fp.last_name
    if (!target.email && fp.email) target.email = fp.email
    if (!target.phone && fp.phone) target.phone = fp.phone
    if (!target.username && fp.username) target.username = fp.username

    target.dirty = true
    target.signal_ids_to_link.push(signal.id)
    return { candidate: target, flaggedForReview, isNewCluster: false }
  }

  // No eligible cluster — mint a new one. Inherit cluster_group_key
  // from a sibling >30d candidate of the same fingerprint if one
  // exists (long-gap split case).
  const sibling = existing.find((c) => c.cluster_group_key !== null)
  const groupKey = sibling?.cluster_group_key ?? clusterGroupKey(signal.venue_id, signal.source_platform!, fp)

  const tempId = `__new__${newCandidates.length}__${signal.id}`
  const fresh: MutableCandidate = {
    tempId,
    isNew: true,
    dbId: null,
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
    first_seen: sigDate,
    last_seen: sigDate,
    review_status: 'clean',
    dirty: true,
    signal_ids_to_link: [signal.id],
    bumped_to_review: false,
  }
  newCandidates.push(fresh)
  const arr = index.get(fingerprintKey) ?? []
  arr.push(fresh)
  index.set(fingerprintKey, arr)
  return { candidate: fresh, flaggedForReview: false, isNewCluster: true }
}

/**
 * Bulk-write the resolved in-memory cluster state for one
 * (venue, platform) group:
 *  1. Insert net-new candidates (one round trip, returns IDs)
 *  2. Upsert dirty existing candidates (one round trip)
 *  3. Per affected candidate, one UPDATE on tangential_signals to
 *     attach the signal_ids that landed on this cluster.
 */
async function flushCandidatesForGroup(
  supabase: SupabaseClient,
  newCandidates: MutableCandidate[],
  existingDirty: MutableCandidate[],
  summary: ClustererSummary,
): Promise<void> {
  if (newCandidates.length > 0) {
    const insertRows = newCandidates.map((c) => ({
      venue_id: c.venue_id,
      source_platform: c.source_platform,
      first_name: c.first_name,
      last_initial: c.last_initial,
      last_name: c.last_name,
      email: c.email,
      phone: c.phone,
      username: c.username,
      city: c.city,
      state: c.state,
      country: c.country,
      cluster_group_key: c.cluster_group_key,
      signal_count: c.signal_count,
      funnel_depth: c.funnel_depth,
      action_counts: c.action_counts,
      first_seen: c.first_seen,
      last_seen: c.last_seen,
      review_status: c.review_status,
    }))
    const { data, error } = await supabase
      .from('candidate_identities')
      .insert(insertRows)
      .select('id')
    if (error) {
      summary.errors.push(`new candidates insert: ${error.message}`)
    } else {
      const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
      newCandidates.forEach((c, idx) => {
        c.dbId = ids[idx] ?? null
      })
    }
  }

  if (existingDirty.length > 0) {
    // upsert lets us update many rows in one round trip; PostgREST
    // matches by primary key.
    const upsertRows = existingDirty.map((c) => ({
      id: c.dbId!,
      venue_id: c.venue_id,
      source_platform: c.source_platform,
      first_name: c.first_name,
      last_initial: c.last_initial,
      last_name: c.last_name,
      email: c.email,
      phone: c.phone,
      username: c.username,
      city: c.city,
      state: c.state,
      country: c.country,
      cluster_group_key: c.cluster_group_key,
      signal_count: c.signal_count,
      funnel_depth: c.funnel_depth,
      action_counts: c.action_counts,
      first_seen: c.first_seen,
      last_seen: c.last_seen,
      review_status: c.review_status,
    }))
    const { error } = await supabase.from('candidate_identities').upsert(upsertRows)
    if (error) summary.errors.push(`existing candidates upsert: ${error.message}`)
  }

  for (const c of [...newCandidates, ...existingDirty]) {
    if (!c.dbId || c.signal_ids_to_link.length === 0) continue
    summary.affected_candidate_ids.push(c.dbId)
    const { error } = await supabase
      .from('tangential_signals')
      .update({ candidate_identity_id: c.dbId })
      .in('id', c.signal_ids_to_link)
    if (error) summary.errors.push(`signal link cluster ${c.dbId}: ${error.message}`)
  }
}

/**
 * Cluster a batch of signals (e.g. all signals from one CSV import).
 * Idempotent — signals already linked to a candidate skip the in-
 * memory pass.
 */
export async function clusterSignals(args: {
  supabase: SupabaseClient
  signalIds: readonly string[]
}): Promise<ClustererSummary> {
  const { supabase, signalIds } = args
  const summary = emptySummary()
  if (signalIds.length === 0) return summary

  const allSignals = await fetchSignals(supabase, signalIds)
  const toProcess = allSignals.filter((s) => !s.candidate_identity_id)
  summary.signals_processed = toProcess.length

  // Group by (venue_id, source_platform). Almost always one group per
  // brain-dump batch, but we don't assume — multi-venue admin runs
  // could mix.
  const groups = new Map<string, SignalRow[]>()
  for (const s of toProcess) {
    if (!s.source_platform || !s.signal_date) {
      summary.signals_skipped_anonymous++
      continue
    }
    const fp = extractFingerprint(s)
    if (!fp.first_name || !fp.last_initial) {
      summary.signals_skipped_anonymous++
      continue
    }
    const k = `${s.venue_id}|${s.source_platform}`
    const arr = groups.get(k) ?? []
    arr.push(s)
    groups.set(k, arr)
  }

  for (const [groupKey, groupSignals] of groups) {
    const [venueId, platform] = groupKey.split('|')
    let existingCandidates: CandidateRow[] = []
    try {
      existingCandidates = await fetchExistingCandidates(supabase, venueId, platform)
    } catch (err) {
      summary.errors.push(err instanceof Error ? err.message : String(err))
      continue
    }
    const index = indexCandidatesByFingerprint(existingCandidates)
    const newCandidates: MutableCandidate[] = []

    // Process chronologically so earlier signals land first and later
    // signals can attach to the cluster they just created.
    groupSignals.sort((a, b) => (a.signal_date ?? '').localeCompare(b.signal_date ?? ''))

    for (const s of groupSignals) {
      const fp = extractFingerprint(s)
      const result = applySignalInMemory(s, fp, index, newCandidates)
      if (result.isNewCluster) summary.signals_creating_new_cluster++
      else summary.signals_attached_to_existing++
      if (result.flaggedForReview) summary.candidates_flagged_for_review++
    }

    const existingDirty: MutableCandidate[] = []
    for (const arr of index.values()) {
      for (const c of arr) {
        if (!c.isNew && c.dirty) existingDirty.push(c)
      }
    }

    await flushCandidatesForGroup(supabase, newCandidates, existingDirty, summary)
  }

  return summary
}

/**
 * Re-cluster every unattached signal for a venue (or venue+platform).
 * Used by the cross-venue historical backfill (PB.7) and the nightly
 * safety sweep (PB.8). Existing cluster boundaries are preserved
 * because attached signals are skipped.
 */
export async function reclusterVenue(args: {
  supabase: SupabaseClient
  venueId: string
  platform?: string
}): Promise<ClustererSummary> {
  const { supabase, venueId, platform } = args
  const summary = emptySummary()

  const PAGE = 1000
  let from = 0
  const allIds: string[] = []
  for (;;) {
    let q = supabase
      .from('tangential_signals')
      .select('id')
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
    const page = (data ?? []) as Array<{ id: string }>
    allIds.push(...page.map((r) => r.id))
    if (page.length < PAGE) break
    from += PAGE
  }

  if (allIds.length === 0) return summary
  return clusterSignals({ supabase, signalIds: allIds })
}
