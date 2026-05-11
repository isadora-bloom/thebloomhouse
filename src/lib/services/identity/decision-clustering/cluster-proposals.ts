/**
 * Person-clustering for identity decision UX (Wave 10).
 *
 * Anchor docs:
 *   - feedback_deep_fix_vs_bandaid.md — structural fix, not bandaid.
 *   - bloom-constitution.md — forensic identity reconstruction. The
 *     operator answers ONE question per real human, not N per handle.
 *   - src/lib/services/identity/handle-convergence.ts — produces the
 *     HandleMergeProposal[] this service consumes.
 *
 * The bug Wave 10 closes
 * ----------------------
 * "Jamie B" appeared on /admin/identity/handle-merges as 4 separate
 * proposals — one per cross-platform handle she has (gmail / Knot
 * inbox / Calendly / phone). Operator accepted one → underlying
 * mergePeople ran → canonical Jamie B emerged → the other 3
 * proposals disappeared on refresh (records resolved to one
 * canonical, no 2+ distinct records remaining). No data lost, but
 * the UX presented 4 decisions when 1 was needed.
 *
 * What this service does
 * ----------------------
 * Wraps `crossPlatformHandleMerge`'s output. For each venue:
 *
 *   1. Extract the set of distinct people.id values from each
 *      proposal's records (plus any candidate_identities that have
 *      already been resolved to a person).
 *   2. Build a graph: two proposals are connected iff they share at
 *      least one people.id.
 *   3. Each connected component = one person cluster.
 *   4. For clusters with no shared people row (pure candidate /
 *      orphan-signal proposals), key by the strongest shared
 *      identifier: email > phone > normalized full name.
 *   5. Optional LLM judge (Sonnet, temperature 0.1) for the
 *      AMBIGUOUS bridge case: two proposals that share NO person,
 *      have similar names + adjacent windows + same venue. Ask
 *      "are these the same person?" Bridge only when confidence
 *      >= 80.
 *
 * Return shape
 * ------------
 *   PersonCluster {
 *     clusterId: string                        — opaque per-request id
 *     clusterKey: string                       — stable per-venue key
 *     canonicalPersonId: string | null
 *     displayName: string
 *     handles: { handle, platforms, score, recordCount }[]
 *     totalRecords: number
 *     aggregateScore: number                   — 0..100
 *     reasoning: string[]
 *     firstObservedAt: string | null
 *     lastObservedAt: string | null
 *     llmBridged: boolean                      — true when judge linked
 *                                                two otherwise-disjoint
 *                                                proposals
 *     llmConfidence: number | null
 *   }
 *
 * Hard rules
 * ----------
 *   - READ ONLY. No DB writes. No mergePeople. The cluster-accept API
 *     route owns the write path.
 *   - Deterministic when no LLM bridges fire — same input ⇒ same
 *     output. Stable clusterId derived from sorted handle list.
 *   - LLM judge is OPT-IN per call. enableLLMJudge defaults true; pass
 *     false from the GET endpoint (cheap list) and true from the
 *     accept endpoint (one-shot deep cluster).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'
import { callAIJson } from '@/lib/ai/client'
import {
  crossPlatformHandleMerge,
  type HandleMergeProposal,
} from '@/lib/services/identity/handle-convergence'

export const CLUSTER_PROPOSALS_PROMPT_VERSION =
  'cluster-proposals.bridge-judge.v1'

// ---------------------------------------------------------------------------
// TODO (Wave 10 cron hook):
// When phase_b_sweep runs (src/app/api/cron/route.ts -> sweepPhaseBAllVenues),
// AFTER it processes candidates, ALSO call clusterProposalsByPerson() and
// cache the cluster snapshot per venue. Operator then sees fresh clusters
// on each /admin/identity/decisions page load without recomputing live.
//
// Implementation note for the hook owner:
//   - cache table: a new identity_decision_cluster_cache(venue_id PK,
//     pending_clusters jsonb, computed_at) or reuse a generic
//     coordinator_cache row. Defer until Wave 10 verification confirms
//     the live-compute path is fast enough at Wedgewood scale.
//   - the GET /api/admin/identity/decision-clusters endpoint currently
//     recomputes on every load — that's fine for Rixey scale but at
//     50+ venues with thousands of candidates each, we'll want the
//     cached read.
// Per build doctrine (DO NOT modify shared cron files), this hook is
// left as a documented TODO. Owner: Wave 11 or Wave 10-followup.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClusterHandle {
  handle: string
  platforms: string[]
  score: number
  recordCount: number
  /** Raw proposal-level reasoning, captured for the cluster audit row. */
  reasoning: string[]
  mixed: boolean
}

export interface PersonCluster {
  clusterId: string
  clusterKey: string
  canonicalPersonId: string | null
  displayName: string
  handles: ClusterHandle[]
  totalRecords: number
  aggregateScore: number
  reasoning: string[]
  firstObservedAt: string | null
  lastObservedAt: string | null
  llmBridged: boolean
  llmConfidence: number | null
}

export interface ClusterProposalsArgs {
  proposals?: HandleMergeProposal[]
  supabase: SupabaseClient
  venueId: string
  enableLLMJudge?: boolean
}

export interface ClusterProposalsResult {
  venueId: string
  clusters: PersonCluster[]
  llmJudgeInvocations: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CandidateResolvedRow {
  id: string
  resolved_person_id: string | null
  resolved_wedding_id: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
}

interface PeopleNameRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  created_at: string | null
  updated_at: string | null
}

function lower(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

function normalizeFullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  const f = lower(firstName)
  const l = lower(lastName)
  if (!f && !l) return null
  return [f, l].filter(Boolean).join(' ')
}

function stableHashIds(parts: string[]): string {
  const sorted = [...parts].sort().join('|')
  return createHash('sha1').update(sorted).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>()

  find(x: string): string {
    const cur = this.parent.get(x) ?? x
    if (cur === x) {
      this.parent.set(x, x)
      return x
    }
    const root = this.find(cur)
    this.parent.set(x, root)
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

// ---------------------------------------------------------------------------
// Candidate resolution lookup — proposals may include candidate rows
// that have been resolved to a person. Treat resolved candidates as if
// they were people rows (their identity has already collapsed).
// ---------------------------------------------------------------------------

async function fetchCandidateResolutions(
  supabase: SupabaseClient,
  candidateIds: string[],
): Promise<Map<string, CandidateResolvedRow>> {
  const out = new Map<string, CandidateResolvedRow>()
  if (candidateIds.length === 0) return out
  // Filter out synthetic orphan-signal ids — they're not real
  // candidate rows.
  const realIds = candidateIds.filter((id) => !id.startsWith('orphan-signal:'))
  if (realIds.length === 0) return out
  const { data } = await supabase
    .from('candidate_identities')
    .select('id, resolved_person_id, resolved_wedding_id, first_name, last_name, email')
    .in('id', realIds)
  for (const row of ((data ?? []) as CandidateResolvedRow[])) {
    out.set(row.id, row)
  }
  return out
}

async function fetchPeopleContext(
  supabase: SupabaseClient,
  personIds: string[],
): Promise<Map<string, PeopleNameRow>> {
  const out = new Map<string, PeopleNameRow>()
  if (personIds.length === 0) return out
  const { data } = await supabase
    .from('people')
    .select('id, first_name, last_name, email, phone, created_at, updated_at')
    .in('id', personIds)
  for (const row of ((data ?? []) as PeopleNameRow[])) {
    out.set(row.id, row)
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-proposal identity extraction.
// Returns a set of identity keys for one proposal. Two proposals
// share a person iff their identity-key sets intersect on a `person:`
// key. Else they may still cluster via shared email/phone/name —
// those are softer signals that go through the strongest-shared-id
// path or the LLM bridge.
// ---------------------------------------------------------------------------

interface ProposalIdentity {
  proposal: HandleMergeProposal
  personIds: Set<string>
  emails: Set<string>
  phones: Set<string>
  normalizedNames: Set<string>
  /** All records folded into one display string for the LLM bridge case. */
  displayHints: { firstName: string | null; lastName: string | null }[]
}

async function extractIdentities(
  supabase: SupabaseClient,
  proposals: HandleMergeProposal[],
): Promise<ProposalIdentity[]> {
  // Pre-fetch candidate resolutions in one round trip.
  const allCandidateIds: string[] = []
  for (const p of proposals) {
    for (const r of p.records) {
      if (r.kind === 'candidate_identities' && !r.recordId.startsWith('orphan-signal:')) {
        allCandidateIds.push(r.recordId)
      }
    }
  }
  const candidateMap = await fetchCandidateResolutions(supabase, allCandidateIds)

  return proposals.map((p) => {
    const personIds = new Set<string>()
    const emails = new Set<string>()
    const phones = new Set<string>()
    const normalizedNames = new Set<string>()
    const displayHints: { firstName: string | null; lastName: string | null }[] = []

    for (const r of p.records) {
      if (r.kind === 'people') {
        personIds.add(r.recordId)
      } else if (r.kind === 'candidate_identities') {
        const resolved = candidateMap.get(r.recordId)
        if (resolved?.resolved_person_id) {
          // Already-resolved candidates surface as if they were
          // people rows. The cluster knows the canonical identity.
          personIds.add(resolved.resolved_person_id)
        }
      }
      const email = lower(r.email)
      if (email) emails.add(email)
      const normName = normalizeFullName(r.firstName, r.lastName)
      if (normName && normName.includes(' ')) normalizedNames.add(normName)
      displayHints.push({ firstName: r.firstName, lastName: r.lastName })
    }

    return { proposal: p, personIds, emails, phones, normalizedNames, displayHints }
  })
}

// ---------------------------------------------------------------------------
// LLM bridge judge — ambiguous cluster case
// ---------------------------------------------------------------------------

interface BridgeJudgeResponse {
  same_person: boolean
  confidence: number
  reasoning: string
}

interface BridgeJudgeInput {
  a: { displayName: string; handles: string[]; platforms: string[] }
  b: { displayName: string; handles: string[]; platforms: string[] }
}

async function askBridgeJudge(
  input: BridgeJudgeInput,
  venueId: string,
): Promise<BridgeJudgeResponse | null> {
  const systemPrompt = `You are an identity adjudicator for a wedding venue intelligence platform.

You are given TWO handle clusters from the same venue that share no canonical person row but have similar names + adjacent observation windows. Decide whether they refer to the same human.

Be conservative. Bridging two clusters that are actually different people produces a destructive merge across their records. Return same_person=true only when evidence is strong:
- Names match or one is a clear short-form of the other (Madison / Madi).
- Handles share a meaningful root or initials.
- At least one platform overlap or adjacent timing.

Default to same_person=false with confidence reflecting how close the call is. Wrong-bridge is worse than no-bridge.

Return ONLY this JSON shape:
{
  "same_person": <true|false>,
  "confidence": <integer 0-100>,
  "reasoning": "<one sentence>"
}`

  const userPrompt = [
    'CLUSTER A',
    `  displayName: ${input.a.displayName}`,
    `  handles: ${input.a.handles.join(', ')}`,
    `  platforms: ${input.a.platforms.join(', ')}`,
    '',
    'CLUSTER B',
    `  displayName: ${input.b.displayName}`,
    `  handles: ${input.b.handles.join(', ')}`,
    `  platforms: ${input.b.platforms.join(', ')}`,
  ].join('\n')

  try {
    const resp = await callAIJson<BridgeJudgeResponse>({
      systemPrompt,
      userPrompt,
      maxTokens: 250,
      temperature: 0.1,
      venueId,
      taskType: 'cluster_bridge_judge',
      tier: 'sonnet',
      promptVersion: CLUSTER_PROPOSALS_PROMPT_VERSION,
    })
    return {
      same_person: Boolean(resp.same_person),
      confidence: Math.max(0, Math.min(100, Math.round(resp.confidence ?? 0))),
      reasoning: resp.reasoning ?? '',
    }
  } catch (err) {
    console.warn('[cluster-proposals] bridge judge call failed:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// First / last observed timestamp lookup.
// Looks at the underlying records' people.created_at / updated_at to
// give the operator a sense of how long the convergence has been
// brewing.
// ---------------------------------------------------------------------------

function aggregateObservedAt(
  personIds: Set<string>,
  peopleCtx: Map<string, PeopleNameRow>,
): { first: string | null; last: string | null } {
  const ts: number[] = []
  for (const pid of personIds) {
    const row = peopleCtx.get(pid)
    if (!row) continue
    if (row.created_at) ts.push(Date.parse(row.created_at))
    if (row.updated_at) ts.push(Date.parse(row.updated_at))
  }
  if (ts.length === 0) return { first: null, last: null }
  ts.sort((a, b) => a - b)
  return {
    first: new Date(ts[0]).toISOString(),
    last: new Date(ts[ts.length - 1]).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Cluster builder — turns a set of proposals (one connected component)
// into a PersonCluster.
// ---------------------------------------------------------------------------

function buildCluster(args: {
  identities: ProposalIdentity[]
  peopleCtx: Map<string, PeopleNameRow>
  llmBridged: boolean
  llmConfidence: number | null
}): PersonCluster {
  const { identities, peopleCtx, llmBridged, llmConfidence } = args
  const allPersonIds = new Set<string>()
  for (const id of identities) for (const p of id.personIds) allPersonIds.add(p)

  // Pick canonical person: prefer the lowest-created people row id in
  // the cluster (matches mergePeople's preference for older = canonical).
  let canonicalPersonId: string | null = null
  if (allPersonIds.size > 0) {
    const sorted = [...allPersonIds].sort((a, b) => {
      const ra = peopleCtx.get(a)
      const rb = peopleCtx.get(b)
      const ta = ra?.created_at ? Date.parse(ra.created_at) : Number.MAX_SAFE_INTEGER
      const tb = rb?.created_at ? Date.parse(rb.created_at) : Number.MAX_SAFE_INTEGER
      if (ta !== tb) return ta - tb
      return a.localeCompare(b)
    })
    canonicalPersonId = sorted[0]
  }

  // cluster_key derivation:
  //   1. canonicalPersonId if we have a people row
  //   2. else strongest shared identifier — email > phone > name
  let clusterKey: string
  if (canonicalPersonId) {
    clusterKey = `person:${canonicalPersonId}`
  } else {
    const sharedEmail = pickSharedFirst(identities, (i) => [...i.emails])
    const sharedPhone = pickSharedFirst(identities, (i) => [...i.phones])
    const sharedName = pickSharedFirst(identities, (i) => [...i.normalizedNames])
    if (sharedEmail) clusterKey = `email:${sharedEmail}`
    else if (sharedPhone) clusterKey = `phone:${sharedPhone}`
    else if (sharedName) clusterKey = `name:${sharedName}`
    else {
      // Fallback — hash of handles. Stable across requests.
      const handles = identities.map((i) => i.proposal.handle).sort()
      clusterKey = `handles:${stableHashIds(handles)}`
    }
  }

  // Display name — prefer canonical person's name, else best-effort
  // from displayHints.
  let displayName = ''
  if (canonicalPersonId) {
    const row = peopleCtx.get(canonicalPersonId)
    if (row) displayName = [row.first_name, row.last_name].filter(Boolean).join(' ')
  }
  if (!displayName) {
    const hint = identities
      .flatMap((i) => i.displayHints)
      .find((d) => d.firstName || d.lastName)
    if (hint) displayName = [hint.firstName, hint.lastName].filter(Boolean).join(' ')
  }
  if (!displayName) displayName = `(unnamed cluster — ${identities[0]?.proposal.handle ?? '?'})`

  // Per-handle aggregation. One handle string can appear in only one
  // proposal (the convergence service groups by normalized handle), so
  // there's no need to dedupe across proposals.
  const handles: ClusterHandle[] = identities.map((i) => ({
    handle: i.proposal.handle,
    platforms: i.proposal.platforms,
    score: i.proposal.score,
    recordCount: i.proposal.records.length,
    reasoning: i.proposal.reasoning,
    mixed: i.proposal.mixed,
  }))
  // Sort handles by score desc for stable display order.
  handles.sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))

  const totalRecords = identities.reduce((s, i) => s + i.proposal.records.length, 0)
  const maxScore = identities.reduce((m, i) => Math.max(m, i.proposal.score), 0)
  // Density bonus — 5 points per additional handle past the first,
  // capped at +25. Clamped to 100 overall.
  const densityBonus = Math.min(25, (handles.length - 1) * 5)
  const aggregateScore = Math.max(0, Math.min(100, maxScore + densityBonus))

  const reasoning: string[] = []
  if (handles.length === 1) {
    reasoning.push(`Single handle "${handles[0].handle}" — clustering retains 1:1 mapping`)
  } else {
    reasoning.push(`${handles.length} handles converge on this person`)
    reasoning.push(`Max handle score ${maxScore} + density bonus ${densityBonus} = aggregate ${aggregateScore}`)
  }
  if (canonicalPersonId) {
    reasoning.push(`Anchored on canonical people row ${canonicalPersonId.slice(0, 8)}`)
  } else {
    reasoning.push('No canonical people row — clustered via shared identifier (pre-zero candidate convergence)')
  }
  if (llmBridged) {
    reasoning.push(
      `LLM bridge applied (confidence ${llmConfidence ?? '?'}) — linked otherwise-disjoint proposals`,
    )
  }

  const { first, last } = aggregateObservedAt(allPersonIds, peopleCtx)

  const handleNamesSorted = handles.map((h) => h.handle).sort()
  const clusterId = stableHashIds([clusterKey, ...handleNamesSorted])

  return {
    clusterId,
    clusterKey,
    canonicalPersonId,
    displayName,
    handles,
    totalRecords,
    aggregateScore,
    reasoning,
    firstObservedAt: first,
    lastObservedAt: last,
    llmBridged,
    llmConfidence,
  }
}

function pickSharedFirst(
  identities: ProposalIdentity[],
  pluck: (i: ProposalIdentity) => string[],
): string | null {
  // Returns the first value present in 2+ identities. Stable.
  const counts = new Map<string, number>()
  for (const id of identities) {
    const seen = new Set<string>()
    for (const v of pluck(id)) {
      if (!v || seen.has(v)) continue
      seen.add(v)
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
  }
  const candidates = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return candidates[0]?.[0] ?? null
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function clusterProposalsByPerson(
  args: ClusterProposalsArgs,
): Promise<ClusterProposalsResult> {
  const { supabase, venueId, enableLLMJudge = true } = args
  const proposals: HandleMergeProposal[] =
    args.proposals ??
    (await crossPlatformHandleMerge(supabase, venueId)).proposals

  if (proposals.length === 0) {
    return { venueId, clusters: [], llmJudgeInvocations: 0 }
  }

  // 1. Extract per-proposal identity sets.
  const identities = await extractIdentities(supabase, proposals)

  // 2. Pre-fetch context for every person id mentioned.
  const allPersonIds = new Set<string>()
  for (const i of identities) for (const p of i.personIds) allPersonIds.add(p)
  const peopleCtx = await fetchPeopleContext(supabase, [...allPersonIds])

  // 3. Union-find by shared person id. Each proposal is a node; we
  // also add each person id as a node so proposals linking through
  // the same person get merged.
  const uf = new UnionFind()
  for (let idx = 0; idx < identities.length; idx += 1) {
    const proposalNode = `prop:${idx}`
    uf.find(proposalNode)
    for (const personId of identities[idx].personIds) {
      const personNode = `person:${personId}`
      uf.union(proposalNode, personNode)
    }
  }

  // 4. Group proposals by root. Drop person-only roots from the
  // output set.
  const proposalIdxByGroup = new Map<string, number[]>()
  for (let idx = 0; idx < identities.length; idx += 1) {
    const root = uf.find(`prop:${idx}`)
    if (!proposalIdxByGroup.has(root)) proposalIdxByGroup.set(root, [])
    proposalIdxByGroup.get(root)!.push(idx)
  }

  // 5. Optional LLM bridge for ambiguous singleton clusters that have
  // similar names. We only call the LLM for pairs of single-proposal
  // groups where (a) no shared person, (b) at least one shared name
  // token, (c) total combined record count >= 2. Cap at 5 calls per
  // venue per invocation to keep latency bounded.
  let llmJudgeInvocations = 0
  const llmBridgedPairs = new Set<string>()
  const llmConfidenceByPair = new Map<string, number>()

  if (enableLLMJudge) {
    const roots = [...proposalIdxByGroup.keys()]
    const MAX_LLM_CALLS = 5
    for (let i = 0; i < roots.length && llmJudgeInvocations < MAX_LLM_CALLS; i += 1) {
      const a = proposalIdxByGroup.get(roots[i])!
      if (a.length !== 1) continue
      const idA = identities[a[0]]
      if (idA.personIds.size > 0) continue
      for (let j = i + 1; j < roots.length && llmJudgeInvocations < MAX_LLM_CALLS; j += 1) {
        const b = proposalIdxByGroup.get(roots[j])!
        if (b.length !== 1) continue
        const idB = identities[b[0]]
        if (idB.personIds.size > 0) continue

        // Heuristic gate: at least one shared first-name token across
        // displayHints. Avoids paying for an LLM call when the two
        // clusters have no naming overlap at all.
        const tokA = new Set(
          idA.displayHints
            .flatMap((h) => [lower(h.firstName), lower(h.lastName)])
            .filter((t) => t.length > 1),
        )
        let overlap = false
        for (const h of idB.displayHints) {
          if (tokA.has(lower(h.firstName)) || tokA.has(lower(h.lastName))) {
            overlap = true
            break
          }
        }
        if (!overlap) continue

        const aHint = idA.displayHints.find((h) => h.firstName || h.lastName)
        const bHint = idB.displayHints.find((h) => h.firstName || h.lastName)
        const aName = aHint
          ? [aHint.firstName, aHint.lastName].filter(Boolean).join(' ')
          : idA.proposal.handle
        const bName = bHint
          ? [bHint.firstName, bHint.lastName].filter(Boolean).join(' ')
          : idB.proposal.handle

        llmJudgeInvocations += 1
        const verdict = await askBridgeJudge(
          {
            a: {
              displayName: aName,
              handles: [idA.proposal.handle],
              platforms: idA.proposal.platforms,
            },
            b: {
              displayName: bName,
              handles: [idB.proposal.handle],
              platforms: idB.proposal.platforms,
            },
          },
          venueId,
        )
        if (verdict && verdict.same_person && verdict.confidence >= 80) {
          uf.union(`prop:${a[0]}`, `prop:${b[0]}`)
          const pairKey = `${Math.min(a[0], b[0])}:${Math.max(a[0], b[0])}`
          llmBridgedPairs.add(pairKey)
          llmConfidenceByPair.set(pairKey, verdict.confidence)
        }
      }
    }

    // Rebuild proposalIdxByGroup post-LLM unions.
    if (llmBridgedPairs.size > 0) {
      proposalIdxByGroup.clear()
      for (let idx = 0; idx < identities.length; idx += 1) {
        const root = uf.find(`prop:${idx}`)
        if (!proposalIdxByGroup.has(root)) proposalIdxByGroup.set(root, [])
        proposalIdxByGroup.get(root)!.push(idx)
      }
    }
  }

  // 6. Build cluster objects.
  const clusters: PersonCluster[] = []
  for (const [, idxs] of proposalIdxByGroup) {
    const groupIdentities = idxs.map((i) => identities[i])
    let llmBridged = false
    let llmConfidence: number | null = null
    if (idxs.length >= 2 && llmBridgedPairs.size > 0) {
      for (let i = 0; i < idxs.length; i += 1) {
        for (let j = i + 1; j < idxs.length; j += 1) {
          const key = `${Math.min(idxs[i], idxs[j])}:${Math.max(idxs[i], idxs[j])}`
          if (llmBridgedPairs.has(key)) {
            llmBridged = true
            const c = llmConfidenceByPair.get(key) ?? null
            if (c !== null && (llmConfidence === null || c > llmConfidence)) {
              llmConfidence = c
            }
          }
        }
      }
    }
    clusters.push(
      buildCluster({
        identities: groupIdentities,
        peopleCtx,
        llmBridged,
        llmConfidence,
      }),
    )
  }

  // Sort by aggregate score desc, then by display name.
  clusters.sort((a, b) => {
    if (b.aggregateScore !== a.aggregateScore) return b.aggregateScore - a.aggregateScore
    return a.displayName.localeCompare(b.displayName)
  })

  return { venueId, clusters, llmJudgeInvocations }
}
