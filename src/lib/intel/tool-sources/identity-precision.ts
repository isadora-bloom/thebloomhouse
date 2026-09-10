/**
 * Identity precision: records versus unique couples, and the confidence
 * behind every merge. Battery Q6, Q29 and Q36.
 *
 * The audit itself already exists. `loadIdentityPrecision`
 * (src/lib/services/intel/identity-precision.ts) returns three review sets
 * with their evidence: high-confidence fusions, weak fusions (the likely
 * over-merges), and unresolved candidate pairs (the likely missed merges).
 * It was wired only into the deprecated NLQ brain. This source exposes it and
 * adds the two things the three questions need:
 *
 *   - the denominator. Q6 asks what share of inquiries turned out to be
 *     duplicates and Q29 asks how many records there are versus how many
 *     unique couples. Both fall out of one fact on the spine: a `couples` row
 *     with `merged_into_id` set is a record that turned out to be another
 *     couple. Live rows are the unique couples; tombstoned rows are the
 *     duplicates that were found.
 *
 *   - names. The audit returns ids. An operator cannot verify a merge from a
 *     uuid, so every couple id referenced is resolved to a name off the spine
 *     and the id rides alongside for chaining.
 *
 * Doctrine (IDENTITY-FIRST-ARCHITECTURE.md): the couple is the unit, and a
 * candidate pair is a question, not an answer. Nothing here is phrased as a
 * merge that should happen. Unresolved pairs are returned with their matcher
 * score and reason so a person decides. The result says so out loud, because
 * a model reading "suspected same" will otherwise report it as fact.
 *
 * Known limit, stated in the result: the underlying reader scans the 500 most
 * recent fusions and 500 unresolved candidates. On a venue with more history
 * than that, the top and bottom lists are the top and bottom of a recent
 * slice, not of all time.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadIdentityPrecision,
  type CandidatePair,
  type MergeRecord,
} from '@/lib/services/intel/identity-precision'
import { MIN_DISTRIBUTION_N } from '@/lib/services/cohort/types'
import { insufficient, type IntelToolSource, type ToolSourceDeps } from './types'

export const TOOL_GET_IDENTITY_PRECISION = 'get_identity_precision'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 20

/** How many the Q36 framing asks for out of each list. */
const FLAGGED_SAMPLE = 5

const NAME_LOOKUP_CHUNK = 200

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

interface NameRow {
  id: string
  primary_contact_name: string | null
  partner_contact_name: string | null
  lifecycle_state: string | null
  merged_into_id: string | null
}

export interface ResolvedName {
  id: string
  names: string | null
  lifecycleState: string | null
  /** True when this row has already been folded into another couple. */
  tombstoned: boolean
}

function displayName(primary: string | null, partner: string | null): string | null {
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? null
}

async function resolveNames(
  supabase: SupabaseClient,
  venueId: string,
  ids: readonly string[],
): Promise<Map<string, ResolvedName>> {
  const out = new Map<string, ResolvedName>()
  const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)))
  for (let i = 0; i < unique.length; i += NAME_LOOKUP_CHUNK) {
    const slice = unique.slice(i, i + NAME_LOOKUP_CHUNK)
    const { data } = await supabase
      .from('couples')
      .select('id, primary_contact_name, partner_contact_name, lifecycle_state, merged_into_id')
      .eq('venue_id', venueId)
      .in('id', slice)
    for (const row of (data ?? []) as NameRow[]) {
      out.set(row.id, {
        id: row.id,
        names: displayName(row.primary_contact_name, row.partner_contact_name),
        lifecycleState: row.lifecycle_state,
        tombstoned: row.merged_into_id !== null,
      })
    }
  }
  return out
}

function named(map: Map<string, ResolvedName>, id: string | null): ResolvedName | null {
  if (!id) return null
  return (
    map.get(id) ?? {
      id,
      names: null,
      lifecycleState: null,
      tombstoned: false,
    }
  )
}

// ---------------------------------------------------------------------------
// Record counts
// ---------------------------------------------------------------------------

export interface RecordCounts {
  /** Every couples row for the venue, duplicates included. */
  totalRecords: number
  /** Rows that are still their own couple. */
  uniqueCouples: number
  /** Rows folded into another couple. Each one is a duplicate that was caught. */
  duplicatesFolded: number
}

async function loadRecordCounts(
  supabase: SupabaseClient,
  venueId: string,
): Promise<RecordCounts> {
  const { count: total } = await supabase
    .from('couples')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  const { count: live } = await supabase
    .from('couples')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .is('merged_into_id', null)

  const totalRecords = total ?? 0
  const uniqueCouples = live ?? 0
  return {
    totalRecords,
    uniqueCouples,
    duplicatesFolded: Math.max(0, totalRecords - uniqueCouples),
  }
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

export interface ShapedMerge {
  eventType: string
  confidenceTier: string
  rule: string | null
  reason: string | null
  occurredAt: string
  kept: ResolvedName | null
  foldedIn: ResolvedName | null
}

export interface ShapedPair {
  confidenceTier: string
  matcherReason: string | null
  createdAt: string
  primary: { recordType: string; recordId: string; names: string | null }
  secondary: { recordType: string; recordId: string; names: string | null }
}

function shapeMerges(merges: readonly MergeRecord[], names: Map<string, ResolvedName>): ShapedMerge[] {
  return merges.map((m) => ({
    eventType: m.eventType,
    confidenceTier: m.confidenceTier,
    rule: m.rule,
    reason: m.reason,
    occurredAt: m.occurredAt,
    kept: named(names, m.primaryCoupleId),
    foldedIn: named(names, m.secondaryCoupleId),
  }))
}

function shapePairs(pairs: readonly CandidatePair[], names: Map<string, ResolvedName>): ShapedPair[] {
  const side = (recordType: string, recordId: string) => ({
    recordType,
    recordId,
    names: recordType === 'couple' ? (names.get(recordId)?.names ?? null) : null,
  })
  return pairs.map((p) => ({
    confidenceTier: p.confidenceTier,
    matcherReason: p.matcherReason,
    createdAt: p.createdAt,
    primary: side(p.primaryRecordType, p.primaryRecordId),
    secondary: side(p.secondaryRecordType, p.secondaryRecordId),
  }))
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function limitArg(args: Record<string, unknown>): number {
  const raw = args.limit
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.floor(n))
}

export async function runIdentityPrecision(
  venueId: string,
  args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const limit = limitArg(args)

  const [audit, counts] = await Promise.all([
    loadIdentityPrecision(deps.supabase, venueId, limit),
    loadRecordCounts(deps.supabase, venueId),
  ])

  const coupleIds: string[] = []
  for (const m of [...audit.confidentMerges, ...audit.weakMerges]) {
    if (m.primaryCoupleId) coupleIds.push(m.primaryCoupleId)
    if (m.secondaryCoupleId) coupleIds.push(m.secondaryCoupleId)
  }
  for (const p of audit.suspectedSamePairs) {
    if (p.primaryRecordType === 'couple') coupleIds.push(p.primaryRecordId)
    if (p.secondaryRecordType === 'couple') coupleIds.push(p.secondaryRecordId)
  }
  const names = await resolveNames(deps.supabase, venueId, coupleIds)

  const highest = shapeMerges(audit.confidentMerges, names)
  const lowest = shapeMerges(audit.weakMerges, names)
  const lookAlikes = shapePairs(audit.suspectedSamePairs, names)

  const duplicateShare =
    counts.totalRecords < MIN_DISTRIBUTION_N
      ? {
          value: null,
          ...insufficient(
            counts.totalRecords,
            counts.totalRecords === 0
              ? 'There are no couple records for this venue yet.'
              : `Only ${counts.totalRecords} couple record(s) on file, against a minimum of ` +
                `${MIN_DISTRIBUTION_N}. The raw counts are in the records block; a percentage ` +
                'over this many records would be noise.',
          ),
        }
      : {
          value: Math.round((counts.duplicatesFolded / counts.totalRecords) * 1000) / 10,
          n: counts.totalRecords,
          enoughData: true,
        }

  return {
    asOf: deps.today,
    records: {
      ...counts,
      n: counts.totalRecords,
      definition:
        'One couples row per record. A row with merged_into_id set has been folded into another ' +
        'couple, so it was a duplicate. Live rows are the unique couples Bloom currently believes ' +
        'in. This counts duplicates Bloom CAUGHT; duplicates it has not caught are in ' +
        'unmergedLookAlikes, not here.',
    },
    duplicateSharePercent: duplicateShare,
    highestConfidenceMerges: {
      n: highest.length,
      requested: limit,
      merges: highest,
      note:
        'Fusions Bloom is surest about. Worth checking precisely because it is surest: an error ' +
        'here is the expensive kind.',
    },
    lowestConfidenceMerges: {
      n: lowest.length,
      requested: limit,
      merges: lowest,
      note:
        'Fusions at medium or low confidence, lowest first. These are the most likely ' +
        'over-merges, and the borderline cases the confidence question is really about. If this ' +
        'list is shorter than requested, that is because there are no more weak fusions on file, ' +
        'not because they were trimmed.',
    },
    unmergedLookAlikes: {
      n: lookAlikes.length,
      requested: limit,
      pairs: lookAlikes,
      note:
        'Pairs the matcher flagged and Bloom deliberately kept apart, highest matcher confidence ' +
        'first. These are the likely missed merges. They are open questions for a person, not ' +
        'merges waiting to be rubber-stamped.',
    },
    flaggedSample: {
      askedFor: FLAGGED_SAMPLE,
      possiblyOverMerged: lowest.slice(0, FLAGGED_SAMPLE),
      possiblyTheSameCouple: lookAlikes.slice(0, FLAGGED_SAMPLE),
    },
    method:
      'The audit reads the 500 most recent fusion events and 500 unresolved candidate pairs for ' +
      'this venue. On a venue with more history than that, these lists are the top and bottom of ' +
      'a recent slice rather than of all time.',
    caveat:
      'Never state a candidate pair as a merge that should happen, and never say two couples are ' +
      'the same. Report what Bloom did, at what confidence, with the matcher reason, and leave ' +
      'the decision with the operator.',
  }
}

const tool: Anthropic.Tool = {
  name: TOOL_GET_IDENTITY_PRECISION,
  description:
    'How well the identity model is doing at deciding who is the same couple. Returns the record ' +
    'count against the unique-couple count, the share of records that turned out to be duplicates, ' +
    'the highest-confidence and lowest-confidence merges Bloom made (each with both couples\' ' +
    'names and ids, the rule that fired and the reason), and the pairs the matcher flagged as ' +
    'possibly the same couple that Bloom kept apart. Use it for "how many duplicates do I have", ' +
    '"how confident is the merge on borderline cases", "show me merges you might have got wrong", ' +
    '"which records are really the same couple". Candidate pairs are open questions: report them ' +
    'as flagged for review, never as a merge that should happen.',
  input_schema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: 'How many rows to return in each of the three lists. Defaults to 20, the maximum.',
      },
    },
    additionalProperties: false,
  },
}

export const identityPrecisionSource: IntelToolSource = {
  tool,
  subjects: [
    'duplicate records across surfaces and the share of inquiries that were duplicates',
    'records versus unique couples',
    'merge confidence, over-merges and missed merges with the evidence for each',
  ],
  batteryQuestions: ['6', '29', '36'],
  run: runIdentityPrecision,
}
