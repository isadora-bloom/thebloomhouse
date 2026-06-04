/**
 * Identity-precision audit (battery Q36: "show me couples Bloom thinks are
 * the same that you think differ — and ones it thinks differ that you think
 * are the same"). The precision AND recall view of the identity model, for
 * operator verification — not just accuracy on easy cases.
 *
 * Spine-only, injectable. Three review sets, each carrying the evidence:
 *   - confidentMerges  — high-confidence fusions (couple_merge_events). Bloom
 *                        is most sure these are one couple; verify no false
 *                        positive on the cases it's surest of.
 *   - weakMerges       — medium/low-confidence fusions. The MOST LIKELY
 *                        over-merges (false positives) — review first.
 *   - suspectedSamePairs — UNRESOLVED candidate_matches, highest-confidence
 *                        first. Bloom suspected these are the same couple but
 *                        kept them separate (queued for review) — the likely
 *                        MISSED merges (false negatives).
 *
 * Only true two-couple fusions count as merges (channel_scoped_bridged /
 * candidate_confirmed / manual_merge / partner_reconciliation) — couple_minted
 * / fragment_promoted / reattach are not fusions, and *_rejected / unmerge are
 * negatives.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const MERGE_EVENT_TYPES = ['channel_scoped_bridged', 'candidate_confirmed', 'manual_merge', 'partner_reconciliation'] as const
const TIER_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 }
const DEFAULT_LIMIT = 10

export interface MergeRecord {
  eventType: string
  primaryCoupleId: string | null
  secondaryCoupleId: string | null
  confidenceTier: string
  rule: string | null
  reason: string | null
  occurredAt: string
}
export interface CandidatePair {
  primaryRecordId: string
  primaryRecordType: string
  secondaryRecordId: string
  secondaryRecordType: string
  confidenceTier: string
  matcherReason: string | null
  createdAt: string
}
export interface IdentityPrecision {
  confidentMerges: MergeRecord[]
  weakMerges: MergeRecord[]
  suspectedSamePairs: CandidatePair[]
  generatedAt: string
  note: string
}

interface MergeRow {
  event_type: string
  primary_couple_id: string | null
  secondary_couple_id: string | null
  confidence_tier: string
  rule_triggered: string | null
  reason: string | null
  occurred_at: string
}
interface CandidateRow {
  primary_record_id: string
  primary_record_type: string
  secondary_record_id: string
  secondary_record_type: string
  confidence_tier: string
  matcher_reason: string | null
  created_at: string
}

export async function loadIdentityPrecision(
  supabase: SupabaseClient,
  venueId: string,
  limit = DEFAULT_LIMIT,
): Promise<IdentityPrecision> {
  const generatedAt = new Date().toISOString()
  const note =
    'confidentMerges/weakMerges: fusions Bloom made (review weakMerges for over-merge). ' +
    'suspectedSamePairs: pairs Bloom flagged but kept separate (review for missed merges).'
  const empty: IdentityPrecision = {
    confidentMerges: [],
    weakMerges: [],
    suspectedSamePairs: [],
    generatedAt,
    note,
  }
  if (!venueId) return empty

  // Fusions, newest first; split by confidence in memory.
  const { data: mergeData } = await supabase
    .from('couple_merge_events')
    .select('event_type, primary_couple_id, secondary_couple_id, confidence_tier, rule_triggered, reason, occurred_at')
    .eq('venue_id', venueId)
    .in('event_type', MERGE_EVENT_TYPES as unknown as string[])
    .order('occurred_at', { ascending: false })
    .limit(500)
  const merges = ((mergeData ?? []) as MergeRow[]).map((m) => ({
    eventType: m.event_type,
    primaryCoupleId: m.primary_couple_id,
    secondaryCoupleId: m.secondary_couple_id,
    confidenceTier: m.confidence_tier,
    rule: m.rule_triggered,
    reason: m.reason,
    occurredAt: m.occurred_at,
  }))
  const confidentMerges = merges.filter((m) => m.confidenceTier === 'high').slice(0, limit)
  const weakMerges = merges
    .filter((m) => m.confidenceTier !== 'high')
    .sort((a, b) => (TIER_RANK[a.confidenceTier] ?? 0) - (TIER_RANK[b.confidenceTier] ?? 0)) // lowest confidence first
    .slice(0, limit)

  // Unresolved candidate matches = suspected-same, kept-separate. Highest
  // confidence first (most likely a real missed merge).
  const { data: candData } = await supabase
    .from('candidate_matches')
    .select('primary_record_id, primary_record_type, secondary_record_id, secondary_record_type, confidence_tier, matcher_reason, created_at')
    .eq('venue_id', venueId)
    .is('resolved_at', null)
    .limit(500)
  const suspectedSamePairs = ((candData ?? []) as CandidateRow[])
    .map((c) => ({
      primaryRecordId: c.primary_record_id,
      primaryRecordType: c.primary_record_type,
      secondaryRecordId: c.secondary_record_id,
      secondaryRecordType: c.secondary_record_type,
      confidenceTier: c.confidence_tier,
      matcherReason: c.matcher_reason,
      createdAt: c.created_at,
    }))
    .sort((a, b) => (TIER_RANK[b.confidenceTier] ?? 0) - (TIER_RANK[a.confidenceTier] ?? 0)) // highest confidence first
    .slice(0, limit)

  return { confidentMerges, weakMerges, suspectedSamePairs, generatedAt, note }
}
