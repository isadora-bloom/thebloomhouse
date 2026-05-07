/**
 * Identity-cluster attribution service (T5-Rixey-BBB).
 *
 * Single-tier first-touch computation that REPLACES the 7-tier
 * `lead-source-derivation.ts` chain. The model is described in full
 * in `audits/2026-05-T4-postlaunch/identity-cluster-attribution-
 * design.md`; this file is the production implementation generalised
 * from the spike at `scripts/rixey-load/50-bbb-spike.ts`.
 *
 * Algorithm
 * ---------
 * 1. Resolve the cluster: walk weddings + merged-loser weddings + all
 *    people-row emails + all candidate_identities resolved to any of
 *    those weddings.
 * 2. Gather every signal across interactions (by wedding_id OR by
 *    from_email match), tours, tangential_signals (via
 *    candidate_identity_id IN cluster.candidateIds), and
 *    attribution_events.
 * 3. Filter to signal_class = 'source'. Coordinator override beats
 *    the cluster walk.
 * 4. Sort by signal date (per-table column varies — interactions.
 *    timestamp / tours.scheduled_at / tangential_signals.signal_date /
 *    attribution_events.decided_at).
 * 5. Earliest signal wins.
 * 6. Apply canonicalisation via `formatSourceLabel` from Stream UU.
 *
 * Confidence
 * ----------
 *   high    — signal from email-domain match OR explicit UTM. The
 *             channel name is structurally encoded.
 *   medium  — signal from Q7 / lead-source field on an explicit
 *             inquiry interaction.
 *   low     — signal from a name-only candidate-identity match
 *             (typically the CCC backtrack output).
 *
 * NOT IN SCOPE
 * ------------
 *   - This service does NOT mutate `weddings.lead_source` or
 *     `weddings.source` directly. The cutover (Stream BBB-7) gates
 *     that behind USE_CLUSTER_FIRST_TOUCH; until the flag flips, the
 *     legacy 7-tier chain remains the source of truth.
 *   - The parity cron (computeAttributionParityForVenue) writes a
 *     side-by-side audit row to attribution_parity_log so coordinators
 *     can watch divergence over days/weeks before flipping the flag.
 *
 * Cross-venue isolation
 * ---------------------
 * Every cluster query MUST filter by venue_id at every step. Failing
 * to do so leaks attribution across venue tenants when the same email
 * appears at two venues. The loader functions enforce this.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { formatSourceLabel } from '@/lib/utils/format-source-label'
import { asMaybeFirstTouchSource, type FirstTouchSource } from '@/lib/types/source'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SignalClass = 'source' | 'touchpoint' | 'crm' | 'outcome' | 'unclassified'

export interface SignalEvidence {
  /** Source table the row lives in. */
  table: 'interactions' | 'tours' | 'tangential_signals' | 'attribution_events' | 'weddings.attribution_priority'
  /** Row id. */
  id: string
  /** Sortable timestamp on the source row. */
  timestamp: string
  /** Pre-canonical channel value (from row's source-bearing column). */
  rawValue: string | null
  /** Free-form note for the dashboard tooltip. */
  note?: string
}

export type FirstTouchConfidence = 'high' | 'medium' | 'low'

export interface FirstTouchResult {
  /** Canonical channel name (snake_case) — already canonicalised through
   *  `formatSourceLabel`'s reverse map. Null when no source-class
   *  signal exists in the cluster. */
  source: FirstTouchSource | null
  /** Display label rendered via `formatSourceLabel`. Useful for
   *  surfaces that want a ready-to-render value. */
  displayLabel: string
  /** Signals that contributed (all source-class signals, ordered by
   *  timestamp ascending). The first entry is the winner. */
  evidence: SignalEvidence[]
  /** Confidence band — see file header. */
  confidence: FirstTouchConfidence
  /** Did a coordinator override win? */
  overrideUsed: boolean
  /** Total signals (any class) seen in the cluster — useful for the
   *  parity dashboard "why is the cluster empty?" tooltip. */
  totalSignalsInCluster: number
  /** Subset count of source-class signals. */
  totalSourceSignals: number
  computedAt: string
}

// ---------------------------------------------------------------------------
// Cluster loader
// ---------------------------------------------------------------------------

interface IdentityCluster {
  weddingId: string
  weddingIds: Set<string>
  emails: Set<string>
  candidateIds: Set<string>
  coordinatorOverride: string | null
}

/**
 * Walk the cluster for a single wedding. Used by the parity cron
 * (one-shot) and the future cutover compute (per-row recompute).
 *
 * Cross-venue isolation: every query is .eq('venue_id', venueId).
 */
async function loadIdentityCluster(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<IdentityCluster> {
  // Pull the seed wedding + the coordinator override.
  const { data: seed, error: seedErr } = await supabase
    .from('weddings')
    .select('id, attribution_priority')
    .eq('venue_id', venueId)
    .eq('id', weddingId)
    .maybeSingle()
  if (seedErr) throw new Error(`loadIdentityCluster seed: ${seedErr.message}`)
  if (!seed) {
    return { weddingId, weddingIds: new Set([weddingId]), emails: new Set(), candidateIds: new Set(), coordinatorOverride: null }
  }
  const ap = (seed.attribution_priority as { priority?: string[] } | null) ?? null
  const coordinatorOverride =
    ap?.priority && Array.isArray(ap.priority) && ap.priority.length > 0
      ? (ap.priority[0] ?? null)
      : null

  // Pull merged losers (winner = this wedding).
  const { data: losers } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .eq('merged_into_id', weddingId)
  const weddingIds = new Set<string>([weddingId, ...(losers ?? []).map((l) => l.id as string)])

  // Pull all people-row emails attached to any wedding in the cluster.
  const { data: people } = await supabase
    .from('people')
    .select('email')
    .eq('venue_id', venueId)
    .in('wedding_id', Array.from(weddingIds))
  const emails = new Set<string>()
  for (const p of people ?? []) {
    const e = ((p.email as string | null) ?? '').toLowerCase().trim()
    if (e && e.includes('@')) emails.add(e)
  }

  // Pull candidate_identities resolved to any wedding in the cluster.
  const { data: candidates } = await supabase
    .from('candidate_identities')
    .select('id')
    .eq('venue_id', venueId)
    .in('resolved_wedding_id', Array.from(weddingIds))
    .is('deleted_at', null)
  const candidateIds = new Set<string>((candidates ?? []).map((c) => c.id as string))

  return { weddingId, weddingIds, emails, candidateIds, coordinatorOverride }
}

// ---------------------------------------------------------------------------
// Per-cluster signal gather
// ---------------------------------------------------------------------------

interface ClassifiedSignal {
  table: SignalEvidence['table']
  id: string
  signal_class: SignalClass
  source_value: string | null
  timestamp: string
  confidence: FirstTouchConfidence
  note?: string
}

/**
 * Gather every signal attached to the cluster, classified by
 * signal_class as recorded on each row by the writers (post-mig 191).
 * Pre-mig data is backfilled in the migration; new writes from the
 * adapters declare the class explicitly.
 */
async function gatherClusterSignals(
  supabase: SupabaseClient,
  venueId: string,
  cluster: IdentityCluster,
): Promise<ClassifiedSignal[]> {
  const out: ClassifiedSignal[] = []
  const seenInteractionIds = new Set<string>()

  // ---- interactions ----
  // Two paths: by wedding_id (rows attached to any wedding in the
  // cluster) and by from_email (rows whose sender matches a known
  // people-row email — covers inquiries that never linked to a
  // wedding row).
  const widList = Array.from(cluster.weddingIds)
  if (widList.length > 0) {
    const { data: rows } = await supabase
      .from('interactions')
      .select('id, from_email, timestamp, signal_class, extracted_identity, crm_source')
      .eq('venue_id', venueId)
      .in('wedding_id', widList)
    for (const r of rows ?? []) {
      const id = r.id as string
      if (seenInteractionIds.has(id)) continue
      seenInteractionIds.add(id)
      out.push(classifyInteractionRow(r as InteractionRow))
    }
  }
  const emailList = Array.from(cluster.emails)
  if (emailList.length > 0) {
    const { data: rows } = await supabase
      .from('interactions')
      .select('id, from_email, timestamp, signal_class, extracted_identity, crm_source')
      .eq('venue_id', venueId)
      .in('from_email', emailList)
    for (const r of rows ?? []) {
      const id = r.id as string
      if (seenInteractionIds.has(id)) continue
      seenInteractionIds.add(id)
      out.push(classifyInteractionRow(r as InteractionRow))
    }
  }

  // ---- tours ----
  // Always touchpoint per the model — included so the dashboard's
  // "total signals" counter is accurate.
  if (widList.length > 0) {
    const { data: rows } = await supabase
      .from('tours')
      .select('id, scheduled_at, signal_class')
      .eq('venue_id', venueId)
      .in('wedding_id', widList)
    for (const r of rows ?? []) {
      out.push({
        table: 'tours',
        id: r.id as string,
        signal_class: ((r.signal_class as SignalClass | null) ?? 'touchpoint'),
        source_value: null,
        timestamp: (r.scheduled_at as string | null) ?? '',
        confidence: 'low',
      })
    }
  }

  // ---- tangential_signals ----
  // Source-class for cross-platform engagement (Knot view, IG follow,
  // etc.); touchpoint for form submissions.
  const cidList = Array.from(cluster.candidateIds)
  if (cidList.length > 0) {
    const { data: rows } = await supabase
      .from('tangential_signals')
      .select('id, source_platform, signal_type, signal_date, signal_class')
      .eq('venue_id', venueId)
      .in('candidate_identity_id', cidList)
    for (const r of rows ?? []) {
      const value = canonicalisePlatform((r.source_platform as string | null) ?? '')
      out.push({
        table: 'tangential_signals',
        id: r.id as string,
        signal_class: ((r.signal_class as SignalClass | null) ?? 'source'),
        source_value: value,
        timestamp: (r.signal_date as string | null) ?? '',
        confidence: 'high',
        note: (r.signal_type as string | null) ?? undefined,
      })
    }
  }

  // ---- attribution_events ----
  // Phase B audit rows — source-class anchors for resolved candidate
  // matches. Already venue-scoped via the wedding-list filter.
  if (widList.length > 0) {
    const { data: rows } = await supabase
      .from('attribution_events')
      .select('id, source_platform, decided_at, signal_class, is_first_touch, tier')
      .eq('venue_id', venueId)
      .in('wedding_id', widList)
      .is('reverted_at', null)
    for (const r of rows ?? []) {
      const value = canonicalisePlatform((r.source_platform as string | null) ?? '')
      out.push({
        table: 'attribution_events',
        id: r.id as string,
        signal_class: ((r.signal_class as SignalClass | null) ?? 'source'),
        source_value: value,
        timestamp: (r.decided_at as string | null) ?? '',
        // Tier-1 exact / name-window matches are high; AI matches medium;
        // manual/coordinator confirmed = high.
        confidence:
          (r.tier as string | null) === 'tier_1_exact' || (r.tier as string | null) === 'tier_1_full_name'
            ? 'high'
            : (r.tier as string | null) === 'tier_2_ai'
              ? 'medium'
              : 'low',
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Classifiers + canonicalisers
// ---------------------------------------------------------------------------

interface InteractionRow {
  id: string
  from_email: string | null
  timestamp: string | null
  signal_class: SignalClass | null
  extracted_identity: Record<string, unknown> | null
  crm_source: string | null
}

const PLATFORM_DOMAIN_MAP: Record<string, string> = {
  'theknot.com': 'the_knot',
  'mail.theknot.com': 'the_knot',
  'auth.theknot.com': 'the_knot',
  'member.theknot.com': 'the_knot',
  'weddingwire.com': 'wedding_wire',
  'mail.weddingwire.com': 'wedding_wire',
  'authsolic.com': 'wedding_wire',
  'zola.com': 'zola',
  'mail.zola.com': 'zola',
  'herecomestheguide.com': 'here_comes_the_guide',
  'wedsites.com': 'wedsites',
}

function classifyInteractionRow(r: InteractionRow): ClassifiedSignal {
  // Trust the column when it's present (post-mig-191 / post-adapter
  // refactor); fall back to inline classification for legacy rows
  // that haven't been re-derived.
  const declared = r.signal_class ?? null
  if (declared === 'crm' || declared === 'touchpoint' || declared === 'outcome' || declared === 'unclassified') {
    return {
      table: 'interactions',
      id: r.id,
      signal_class: declared,
      source_value: null,
      timestamp: r.timestamp ?? '',
      confidence: 'low',
    }
  }

  // declared === 'source' OR null — try to extract the canonical
  // channel value.
  const ei = r.extracted_identity ?? null
  if (ei && typeof ei === 'object') {
    const hs = (ei.hear_source ?? ei.hearSource ?? ei.where_did_you_hear) as string | undefined
    if (hs && typeof hs === 'string' && hs.trim()) {
      const norm = normaliseHearSource(hs)
      if (norm) {
        return {
          table: 'interactions',
          id: r.id,
          signal_class: 'source',
          source_value: norm,
          timestamp: r.timestamp ?? '',
          confidence: 'medium',
          note: `hear_source:${hs.slice(0, 32)}`,
        }
      }
    }
    const utm = (ei.utm_source ?? ei.utm_campaign) as string | undefined
    if (utm && typeof utm === 'string' && utm.trim()) {
      const norm = normaliseHearSource(utm) ?? utm.toLowerCase()
      if (norm && norm !== 'honeybook') {
        return {
          table: 'interactions',
          id: r.id,
          signal_class: 'source',
          source_value: norm,
          timestamp: r.timestamp ?? '',
          confidence: 'high',
          note: `utm:${utm.slice(0, 32)}`,
        }
      }
    }
  }

  // Inline from-domain classification (legacy rows where the column
  // hasn't been re-derived yet).
  const dom = (r.from_email ?? '').toLowerCase().split('@').pop() ?? ''
  if (dom && PLATFORM_DOMAIN_MAP[dom]) {
    return {
      table: 'interactions',
      id: r.id,
      signal_class: 'source',
      source_value: PLATFORM_DOMAIN_MAP[dom],
      timestamp: r.timestamp ?? '',
      confidence: 'high',
      note: `from_domain:${dom}`,
    }
  }
  for (const [k, v] of Object.entries(PLATFORM_DOMAIN_MAP)) {
    if (dom.endsWith('.' + k)) {
      return {
        table: 'interactions',
        id: r.id,
        signal_class: 'source',
        source_value: v,
        timestamp: r.timestamp ?? '',
        confidence: 'high',
        note: `from_domain:${dom}`,
      }
    }
  }

  // Classification failed — return as unclassified so the row still
  // counts in the total but doesn't pollute first-touch.
  return {
    table: 'interactions',
    id: r.id,
    signal_class: declared === 'source' ? 'source' : 'unclassified',
    source_value: null,
    timestamp: r.timestamp ?? '',
    confidence: 'low',
  }
}

function canonicalisePlatform(sp: string): string | null {
  if (!sp) return null
  const s = sp.toLowerCase().trim()
  if (s.includes('knot')) return 'the_knot'
  if (s.includes('weddingwire') || s.includes('wedding_wire')) return 'wedding_wire'
  if (s.includes('zola')) return 'zola'
  if (s.includes('instagram')) return 'instagram'
  if (s.includes('facebook')) return 'facebook'
  if (s.includes('pinterest')) return 'pinterest'
  if (s.includes('google')) return 'google'
  if (s.includes('here_comes_the_guide') || s.includes('hctg')) return 'here_comes_the_guide'
  if (s.includes('tiktok')) return 'tiktok'
  if (s.includes('reddit')) return 'reddit'
  if (s.includes('youtube')) return 'youtube'
  if (s === 'website_form') return 'website'
  return s
}

function normaliseHearSource(answer: string): string | null {
  const a = answer.toLowerCase().trim()
  if (!a) return null
  if (/knot/.test(a)) return 'the_knot'
  if (/wedding ?wire/.test(a)) return 'wedding_wire'
  if (/zola/.test(a)) return 'zola'
  if (/here ?comes ?the ?guide/.test(a)) return 'here_comes_the_guide'
  if (/instagram|insta\b|ig\b/.test(a)) return 'instagram'
  if (/facebook|fb\b/.test(a)) return 'facebook'
  if (/tik ?tok/.test(a)) return 'tiktok'
  if (/pinterest/.test(a)) return 'pinterest'
  if (/google/.test(a)) return 'google'
  if (/referr|friend|family|word of mouth/.test(a)) return 'referral'
  if (/wedding planner|planner/.test(a)) return 'planner_referral'
  if (/drove ?by|driving|saw the sign/.test(a)) return 'drive_by'
  if (/web|website|own.*site/.test(a)) return 'website'
  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the first-touch source for a single wedding via the
 * identity-cluster walk. Returns NULL when no source-class signal
 * exists in the cluster — the honest answer is "Untracked" rather
 * than padding with a touchpoint bucket.
 */
export async function computeFirstTouchForCluster(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<FirstTouchResult> {
  const cluster = await loadIdentityCluster(supabase, venueId, weddingId)

  // Coordinator override beats the cluster walk.
  if (cluster.coordinatorOverride) {
    const canonical = cluster.coordinatorOverride
    return {
      source: asMaybeFirstTouchSource(canonical),
      displayLabel: formatSourceLabel(canonical),
      evidence: [{
        table: 'weddings.attribution_priority',
        id: weddingId,
        timestamp: '',
        rawValue: canonical,
        note: 'coordinator_override',
      }],
      confidence: 'high',
      overrideUsed: true,
      totalSignalsInCluster: 0,
      totalSourceSignals: 0,
      computedAt: new Date().toISOString(),
    }
  }

  const all = await gatherClusterSignals(supabase, venueId, cluster)
  const sources = all
    .filter((s) => s.signal_class === 'source' && s.source_value)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))

  const totalSignalsInCluster = all.length
  const totalSourceSignals = sources.length

  if (sources.length === 0) {
    return {
      source: null,
      displayLabel: '—',
      evidence: [],
      confidence: 'low',
      overrideUsed: false,
      totalSignalsInCluster,
      totalSourceSignals: 0,
      computedAt: new Date().toISOString(),
    }
  }

  const winner = sources[0]!
  const canonical = winner.source_value!  // guarded by filter above
  const evidence: SignalEvidence[] = sources.slice(0, 12).map((s) => ({
    table: s.table,
    id: s.id,
    timestamp: s.timestamp,
    rawValue: s.source_value,
    note: s.note,
  }))

  return {
    source: asMaybeFirstTouchSource(canonical),
    displayLabel: formatSourceLabel(canonical),
    evidence,
    confidence: winner.confidence,
    overrideUsed: false,
    totalSignalsInCluster,
    totalSourceSignals,
    computedAt: new Date().toISOString(),
  }
}

/**
 * Bulk version for the parity cron — pulls all venue-scoped weddings
 * and computes first-touch for each. Returns an iterator-friendly
 * map keyed by wedding_id. The implementation iterates the cluster
 * loader per wedding (854 weddings × ~5 small queries = ~4 seconds
 * end-to-end against Rixey production per the spike).
 *
 * Future optimisation: in-memory cluster index via two bulk queries
 * instead of per-wedding round-trips. The spike does this; we leave
 * it for BBB-3.5 once parity is proven and the cron's runtime is
 * actually a problem.
 */
export async function computeFirstTouchForVenue(
  supabase: SupabaseClient,
  venueId: string,
): Promise<Map<string, FirstTouchResult>> {
  const { data: weddings, error } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
  if (error) throw new Error(`computeFirstTouchForVenue: ${error.message}`)
  const out = new Map<string, FirstTouchResult>()
  for (const w of weddings ?? []) {
    const wid = w.id as string
    try {
      const r = await computeFirstTouchForCluster(supabase, venueId, wid)
      out.set(wid, r)
    } catch (err) {
      // Don't kill the whole venue on one row failure — log + continue.
      console.error(`[identity-cluster-attribution] wedding ${wid}:`, err)
    }
  }
  return out
}
