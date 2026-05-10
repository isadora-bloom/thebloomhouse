/**
 * Bloom House — Wave 5D cross-venue overlap detector.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5D — at Wedgewood scale, cross-venue
 *     cohort overlap detection enables learning across boundaries
 *     without leaking specifics)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose; cross-venue
 *     comparison NEVER reads couple-level data — only the peer's
 *     venue_thesis aggregate output)
 *
 * What this service does
 * ----------------------
 * For an anchor venue, compares its venue_thesis against each peer
 * venue's venue_thesis (peers default to all other venues with a
 * populated thesis). Comparison runs at AGGREGATE level only:
 *   - Overlapping persona archetype labels (set intersection)
 *   - Overlapping emerging-theme labels (string similarity)
 *   - Overlapping service-demand gap labels
 *   - Overlapping voice principles
 *
 * The peer's couple_identity_profile rows are NEVER touched in this
 * comparison — only their venue_thesis output. Privacy invariant:
 * aggregate ≠ disclose.
 *
 * For Wave 5D launch, this runs at 1-venue scale (Bloom has 1 venue
 * today), so the overlap result is empty by construction. The
 * infrastructure is built now; data follows at Wedgewood scale (100+
 * venues).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import type {
  VenueThesisOutput,
  OverIndexedPersona,
  RecurringEmotionalLandscape,
  ServiceDemandGap,
} from '@/config/prompts/venue-thesis'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SharedItem {
  /** The label that overlaps. */
  label: string
  /** Optional context (e.g. anchor share=32%, peer share=28%). */
  anchor_context?: string
  peer_context?: string
}

export interface OverlapJsonb {
  anchor_venue_label: string | null
  peer_venue_label: string | null
  shared_persona_archetypes: SharedItem[]
  shared_emerging_themes: SharedItem[]
  shared_service_demand_gaps: SharedItem[]
  shared_voice_principles: SharedItem[]
  computation_notes: string
}

export interface CrossVenueOverlap {
  anchorVenueId: string
  peerVenueId: string
  anchorVenueLabel: string | null
  peerVenueLabel: string | null
  overlapJsonb: OverlapJsonb
  confidence0to100: number
  computedAt: string
}

export interface ComputeCrossVenueOverlapResult {
  overlaps: CrossVenueOverlap[]
  /** Number of peer venues considered (had a thesis). */
  peersConsidered: number
  /** Number of overlap rows written. */
  stored: number
}

export interface ComputeCrossVenueOverlapOptions {
  supabase?: SupabaseClient
  /** Optional explicit peer set; defaults to all other venues with a
   *  populated venue_thesis. */
  peerVenueIds?: string[]
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Weights — must sum to 100. Drives confidence_0_100.
const WEIGHT_ARCHETYPES = 30
const WEIGHT_THEMES = 25
const WEIGHT_GAPS = 25
const WEIGHT_VOICE = 20

// Theme labels are LLM-invented prose; we use a coarse normalisation +
// substring containment so "multi-generational gathering" matches
// "multigenerational family gathering".
function normaliseLabel(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Token-set Jaccard. Two labels match when ≥60% of the smaller token
 * set is contained in the larger. This trades precision for recall —
 * the cross-venue overlap is meant to surface candidates for the
 * coordinator, not auto-decide.
 */
function labelsMatch(a: string, b: string): boolean {
  const na = normaliseLabel(a)
  const nb = normaliseLabel(b)
  if (na === nb) return true
  if (na.length === 0 || nb.length === 0) return false
  const ta = new Set(na.split(' ').filter((w) => w.length > 2))
  const tb = new Set(nb.split(' ').filter((w) => w.length > 2))
  if (ta.size === 0 || tb.size === 0) return false
  let inter = 0
  for (const t of ta) {
    if (tb.has(t)) inter += 1
  }
  const smaller = Math.min(ta.size, tb.size)
  return inter / smaller >= 0.6
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface VenueThesisRow {
  venue_id: string
  thesis: VenueThesisOutput
}

interface VenueLabelRow {
  id: string
  name: string | null
}

async function loadThesis(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueThesisRow | null> {
  const { data } = await supabase
    .from('venue_thesis')
    .select('venue_id, thesis')
    .eq('venue_id', venueId)
    .maybeSingle()
  return (data as VenueThesisRow | null) ?? null
}

async function loadAllOtherTheses(
  supabase: SupabaseClient,
  excludeVenueId: string,
): Promise<VenueThesisRow[]> {
  const { data } = await supabase
    .from('venue_thesis')
    .select('venue_id, thesis')
    .neq('venue_id', excludeVenueId)
    .limit(500)
  return (data ?? []) as VenueThesisRow[]
}

async function loadVenueLabels(
  supabase: SupabaseClient,
  venueIds: string[],
): Promise<Map<string, string | null>> {
  if (venueIds.length === 0) return new Map()
  const { data } = await supabase
    .from('venues')
    .select('id, name')
    .in('id', venueIds)
  const out = new Map<string, string | null>()
  for (const v of (data ?? []) as VenueLabelRow[]) {
    out.set(v.id, v.name)
  }
  return out
}

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

interface IntersectResult {
  shared: SharedItem[]
  /** intersection size / union size (Jaccard for overlap union). */
  jaccard_0_1: number
}

function intersectArchetypes(
  anchor: VenueThesisOutput,
  peer: VenueThesisOutput,
): IntersectResult {
  const anchorLabels: Array<{ label: string; share: number }> = []
  // include the venue archetype + over-indexed personas as the
  // archetype set (because the over_indexed_personas drive what each
  // venue's archetype is in practice).
  if (anchor.venue_archetype?.label) {
    anchorLabels.push({ label: anchor.venue_archetype.label, share: 100 })
  }
  for (const p of anchor.over_indexed_personas ?? []) {
    anchorLabels.push({ label: p.persona_label, share: p.share_pct })
  }
  const peerLabels: Array<{ label: string; share: number }> = []
  if (peer.venue_archetype?.label) {
    peerLabels.push({ label: peer.venue_archetype.label, share: 100 })
  }
  for (const p of peer.over_indexed_personas ?? []) {
    peerLabels.push({ label: p.persona_label, share: p.share_pct })
  }
  const shared: SharedItem[] = []
  const matchedPeer = new Set<number>()
  for (const a of anchorLabels) {
    for (let pi = 0; pi < peerLabels.length; pi++) {
      if (matchedPeer.has(pi)) continue
      const peerEntry = peerLabels[pi]
      if (labelsMatch(a.label, peerEntry.label)) {
        shared.push({
          label: a.label,
          anchor_context: `share=${a.share}%`,
          peer_context: `share=${peerEntry.share}%`,
        })
        matchedPeer.add(pi)
        break
      }
    }
  }
  const union = anchorLabels.length + peerLabels.length - shared.length
  const jaccard = union === 0 ? 0 : shared.length / union
  return { shared, jaccard_0_1: jaccard }
}

function intersectThemes(
  anchor: VenueThesisOutput,
  peer: VenueThesisOutput,
): IntersectResult {
  const anchorThemes = anchor.recurring_emotional_landscape ?? []
  const peerThemes = peer.recurring_emotional_landscape ?? []
  const shared: SharedItem[] = []
  const matchedPeer = new Set<number>()
  for (const a of anchorThemes as RecurringEmotionalLandscape[]) {
    for (let pi = 0; pi < peerThemes.length; pi++) {
      if (matchedPeer.has(pi)) continue
      const peerEntry = peerThemes[pi]
      if (labelsMatch(a.theme, peerEntry.theme)) {
        shared.push({
          label: a.theme,
          anchor_context: `n=${a.n_couples}`,
          peer_context: `n=${peerEntry.n_couples}`,
        })
        matchedPeer.add(pi)
        break
      }
    }
  }
  const union = anchorThemes.length + peerThemes.length - shared.length
  const jaccard = union === 0 ? 0 : shared.length / union
  return { shared, jaccard_0_1: jaccard }
}

function intersectGaps(
  anchor: VenueThesisOutput,
  peer: VenueThesisOutput,
): IntersectResult {
  const anchorGaps = anchor.service_demand_gaps ?? []
  const peerGaps = peer.service_demand_gaps ?? []
  const shared: SharedItem[] = []
  const matchedPeer = new Set<number>()
  for (const a of anchorGaps as ServiceDemandGap[]) {
    for (let pi = 0; pi < peerGaps.length; pi++) {
      if (matchedPeer.has(pi)) continue
      const peerEntry = peerGaps[pi]
      if (labelsMatch(a.missing_offering, peerEntry.missing_offering)) {
        shared.push({
          label: a.missing_offering,
          anchor_context: a.evidence_of_demand.slice(0, 60),
          peer_context: peerEntry.evidence_of_demand.slice(0, 60),
        })
        matchedPeer.add(pi)
        break
      }
    }
  }
  const union = anchorGaps.length + peerGaps.length - shared.length
  const jaccard = union === 0 ? 0 : shared.length / union
  return { shared, jaccard_0_1: jaccard }
}

function intersectVoice(
  anchor: VenueThesisOutput,
  peer: VenueThesisOutput,
): IntersectResult {
  const anchorPrinciples = anchor.voice_thesis?.key_principles ?? []
  const peerPrinciples = peer.voice_thesis?.key_principles ?? []
  const shared: SharedItem[] = []
  const matchedPeer = new Set<number>()
  for (const a of anchorPrinciples) {
    for (let pi = 0; pi < peerPrinciples.length; pi++) {
      if (matchedPeer.has(pi)) continue
      if (labelsMatch(a, peerPrinciples[pi])) {
        shared.push({ label: a })
        matchedPeer.add(pi)
        break
      }
    }
  }
  const union = anchorPrinciples.length + peerPrinciples.length - shared.length
  const jaccard = union === 0 ? 0 : shared.length / union
  return { shared, jaccard_0_1: jaccard }
}

function blendConfidence(
  archetypes: IntersectResult,
  themes: IntersectResult,
  gaps: IntersectResult,
  voice: IntersectResult,
): number {
  const score =
    archetypes.jaccard_0_1 * WEIGHT_ARCHETYPES +
    themes.jaccard_0_1 * WEIGHT_THEMES +
    gaps.jaccard_0_1 * WEIGHT_GAPS +
    voice.jaccard_0_1 * WEIGHT_VOICE
  return Math.max(0, Math.min(100, Math.round(score)))
}

function withRecurringNote(
  anchorLabel: string | null,
  peerLabel: string | null,
  hasAny: boolean,
): string {
  if (!hasAny) {
    return `No aggregate overlap between anchor (${anchorLabel ?? '<unknown>'}) and peer (${peerLabel ?? '<unknown>'}). Privacy preserved: comparison reads venue_thesis aggregates only, never couple-level rows.`
  }
  return `Overlap surfaced from aggregate venue_thesis comparison only. No couple-level data crossed venue boundaries. Anchor=${anchorLabel ?? '<unknown>'} peer=${peerLabel ?? '<unknown>'}.`
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function computeCrossVenueOverlap(
  args: { anchorVenueId: string; peerVenueIds?: string[] },
  options: ComputeCrossVenueOverlapOptions = {},
): Promise<ComputeCrossVenueOverlapResult> {
  const supabase = options.supabase ?? createServiceClient()

  const anchorThesis = await loadThesis(supabase, args.anchorVenueId)
  if (!anchorThesis) {
    return { overlaps: [], peersConsidered: 0, stored: 0 }
  }

  // Resolve peers: explicit set or all other venues with a thesis.
  let peers: VenueThesisRow[]
  if (args.peerVenueIds && args.peerVenueIds.length > 0) {
    const peerSet: VenueThesisRow[] = []
    for (const pid of args.peerVenueIds) {
      if (pid === args.anchorVenueId) continue
      const t = await loadThesis(supabase, pid)
      if (t) peerSet.push(t)
    }
    peers = peerSet
  } else {
    peers = await loadAllOtherTheses(supabase, args.anchorVenueId)
  }

  // Resolve labels for nicer overlap_jsonb context.
  const allIds = [args.anchorVenueId, ...peers.map((p) => p.venue_id)]
  const labels = await loadVenueLabels(supabase, allIds)
  const anchorLabel = labels.get(args.anchorVenueId) ?? null

  const overlaps: CrossVenueOverlap[] = []
  let stored = 0

  for (const peer of peers) {
    const peerLabel = labels.get(peer.venue_id) ?? null
    const archInter = intersectArchetypes(anchorThesis.thesis, peer.thesis)
    const themeInter = intersectThemes(anchorThesis.thesis, peer.thesis)
    const gapInter = intersectGaps(anchorThesis.thesis, peer.thesis)
    const voiceInter = intersectVoice(anchorThesis.thesis, peer.thesis)
    const confidence = blendConfidence(archInter, themeInter, gapInter, voiceInter)

    const hasAny =
      archInter.shared.length +
        themeInter.shared.length +
        gapInter.shared.length +
        voiceInter.shared.length >
      0

    const overlapJsonb: OverlapJsonb = {
      anchor_venue_label: anchorLabel,
      peer_venue_label: peerLabel,
      shared_persona_archetypes: archInter.shared,
      shared_emerging_themes: themeInter.shared,
      shared_service_demand_gaps: gapInter.shared,
      shared_voice_principles: voiceInter.shared,
      computation_notes: withRecurringNote(anchorLabel, peerLabel, hasAny),
    }

    const computedAtIso = new Date().toISOString()

    // Upsert via (anchor_venue_id, peer_venue_id). Re-running replaces
    // the prior row.
    const { error } = await supabase.from('cross_venue_overlap').upsert(
      {
        anchor_venue_id: args.anchorVenueId,
        peer_venue_id: peer.venue_id,
        overlap_jsonb: overlapJsonb,
        confidence_0_100: confidence,
        computed_at: computedAtIso,
      },
      { onConflict: 'anchor_venue_id,peer_venue_id' },
    )
    if (!error) {
      stored += 1
    } else {
      console.warn('[cross-venue-overlap] upsert failed:', error.message)
    }

    overlaps.push({
      anchorVenueId: args.anchorVenueId,
      peerVenueId: peer.venue_id,
      anchorVenueLabel: anchorLabel,
      peerVenueLabel: peerLabel,
      overlapJsonb,
      confidence0to100: confidence,
      computedAt: computedAtIso,
    })
  }

  // Sort by confidence desc so the dashboard renders the closest peers
  // first.
  overlaps.sort((a, b) => b.confidence0to100 - a.confidence0to100)

  return {
    overlaps,
    peersConsidered: peers.length,
    stored,
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function listStoredOverlaps(
  anchorVenueId: string,
  options: { supabase?: SupabaseClient } = {},
): Promise<CrossVenueOverlap[]> {
  const supabase = options.supabase ?? createServiceClient()
  const { data, error } = await supabase
    .from('cross_venue_overlap')
    .select(
      'anchor_venue_id, peer_venue_id, overlap_jsonb, confidence_0_100, computed_at',
    )
    .eq('anchor_venue_id', anchorVenueId)
    .order('confidence_0_100', { ascending: false })
    .limit(100)
  if (error) {
    console.warn('[cross-venue-overlap] listStoredOverlaps failed:', error.message)
    return []
  }
  const rows = (data ?? []) as Array<{
    anchor_venue_id: string
    peer_venue_id: string
    overlap_jsonb: OverlapJsonb
    confidence_0_100: number
    computed_at: string
  }>
  return rows.map((r) => ({
    anchorVenueId: r.anchor_venue_id,
    peerVenueId: r.peer_venue_id,
    anchorVenueLabel: r.overlap_jsonb?.anchor_venue_label ?? null,
    peerVenueLabel: r.overlap_jsonb?.peer_venue_label ?? null,
    overlapJsonb: r.overlap_jsonb,
    confidence0to100: r.confidence_0_100,
    computedAt: r.computed_at,
  }))
}
