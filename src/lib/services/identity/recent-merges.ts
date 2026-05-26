/**
 * Recent-merges digest.
 *
 * Why
 * ---
 * §7 OPERATOR-BLOCK: an operator who's been away for the day needs a
 * one-screen view of "what merges did Bloom (or a coordinator) commit
 * in the last few days, and which of them look wrong?" Pre-this,
 * recognising a bad merge required scrolling /intel/identity-review
 * row by row.
 *
 * Sources
 * -------
 * Two audit tables capture the spine's identity moves:
 *
 *   - `couple_merge_events` — every couple-level event (fragment
 *     promotion, candidate confirm / reject, manual merge / unmerge,
 *     resurrection / resurrection_rejected). Migration 346.
 *   - `person_merges` — every people-level dedupe with a JSON snapshot
 *     of the deleted row for undo. Migration 085.
 *
 * The digest unions both into a single list keyed by `occurred_at`
 * (couple events) / `merged_at` (person merges), filters out events
 * that are NOT merges (reject / unmerge / resurrection_rejected /
 * already-undone person merges), and hydrates the two sides with
 * display labels.
 *
 * Doctrine
 * --------
 * Honesty (§C.6): the digest carries empty-state copy when there are
 * no recent merges, never a confusing zero count rendered as a number.
 *
 * Multi-venue safe: every read is scoped to the supplied venueId.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RecentMergeKind =
  | 'couple_fragment_promoted'
  | 'couple_channel_scoped_bridged'
  | 'couple_candidate_confirmed'
  | 'couple_manual_merge'
  | 'couple_resurrection'
  | 'person_merge'

/**
 * Source row classification — drives what `undo` does.
 *  - 'couple_event' rows live in `couple_merge_events`. Undo via
 *    /api/admin/identity/undo-merge writes a paired reversal event
 *    and (where possible) walks the touchpoint reattachment back.
 *  - 'person_merge' rows live in `person_merges`. Undo invokes the
 *    existing `undoMerge` service which recreates the merged person.
 */
export type RecentMergeSource = 'couple_event' | 'person_merge'

export interface RecentMergeRow {
  /** Unique row id of the audit row this entry came from. */
  id: string
  source: RecentMergeSource
  kind: RecentMergeKind
  occurredAt: string
  /** Display label for the kind, plain-English. */
  kindLabel: string
  /** Friendly description: 'Bloom auto-merge' / 'Manual merge'. */
  actor: 'auto' | 'operator'
  /** Confidence tier of the merge, when known. */
  confidenceTier: 'high' | 'medium' | 'low' | null
  /** Rule that fired (e.g. 'candidate_match:xyz', 'high_tier_email_match'). */
  ruleTriggered: string | null
  /** Free-text reason (matcher reason / operator note). */
  reason: string | null
  /** "Into" side — the record that survived. */
  primary: { id: string | null; label: string | null }
  /** "From" side — the record that was absorbed. */
  secondary: { id: string | null; label: string | null }
  /** True once an operator has invoked undo on this row. */
  undone: boolean
  /** When the undo happened, if any. */
  undoneAt: string | null
}

export interface RecentMergesPage {
  /** Inclusive window start in ISO 8601. */
  windowStart: string
  /** Inclusive window end in ISO 8601 (always = now()). */
  windowEnd: string
  /** Hours covered by the window. */
  windowHours: number
  rows: RecentMergeRow[]
}

// ---------------------------------------------------------------------------
// Internal types — raw select shapes.
// ---------------------------------------------------------------------------

interface RawCoupleMergeRow {
  id: string
  event_type: string
  confidence_tier: string | null
  occurred_at: string
  reason: string | null
  rule_triggered: string | null
  operator_id: string | null
  primary_couple_id: string | null
  secondary_couple_id: string | null
}

interface RawPersonMergeRow {
  id: string
  kept_person_id: string | null
  merged_person_id: string | null
  tier: string | null
  signals: Array<{ type: string; detail: string }> | null
  merged_at: string
  merged_by: string | null
  undone_at: string | null
  snapshot: Record<string, unknown> | null
}

// `couple_merge_events` event_types that represent an actual merge we
// want to surface as "did this and you might want to undo it". Reject /
// unmerge / resurrection_rejected are intentionally excluded — they
// are themselves reversals.
const COUPLE_MERGE_KINDS: ReadonlySet<string> = new Set([
  'fragment_promoted',
  'channel_scoped_bridged',
  'candidate_confirmed',
  'manual_merge',
  'resurrection',
])

const COUPLE_KIND_LABEL: Record<string, RecentMergeKind> = {
  fragment_promoted: 'couple_fragment_promoted',
  channel_scoped_bridged: 'couple_channel_scoped_bridged',
  candidate_confirmed: 'couple_candidate_confirmed',
  manual_merge: 'couple_manual_merge',
  resurrection: 'couple_resurrection',
}

function kindLabel(kind: RecentMergeKind): string {
  switch (kind) {
    case 'couple_fragment_promoted':
      return 'Fragment promoted onto couple'
    case 'couple_channel_scoped_bridged':
      return 'Channel-scoped couple bridged'
    case 'couple_candidate_confirmed':
      return 'Candidate match confirmed'
    case 'couple_manual_merge':
      return 'Manual couple merge'
    case 'couple_resurrection':
      return 'Ghost couple resurrected'
    case 'person_merge':
      return 'Person merge (dedupe)'
  }
}

function coerceTier(
  v: string | null | undefined,
): 'high' | 'medium' | 'low' | null {
  if (v === 'high' || v === 'medium' || v === 'low') return v
  return null
}

function labelCouple(row: {
  primary_contact_name: string | null
  primary_contact_email: string | null
} | null | undefined): string | null {
  if (!row) return null
  return row.primary_contact_name ?? row.primary_contact_email ?? null
}

function labelPerson(row: {
  first_name: string | null
  last_name: string | null
  email: string | null
} | null | undefined): string | null {
  if (!row) return null
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim()
  if (name) return name
  return row.email ?? null
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function loadRecentMerges(
  supabase: SupabaseClient,
  venueId: string,
  options: { windowHours?: number; limit?: number } = {},
): Promise<RecentMergesPage> {
  const windowHours = options.windowHours ?? 72
  const limit = options.limit ?? 100
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - windowHours * 3600_000)

  // Pull both audit tables in parallel.
  const [coupleResp, personResp] = await Promise.all([
    supabase
      .from('couple_merge_events')
      .select(
        'id, event_type, confidence_tier, occurred_at, reason, rule_triggered, operator_id, primary_couple_id, secondary_couple_id',
      )
      .eq('venue_id', venueId)
      .in('event_type', [...COUPLE_MERGE_KINDS])
      .gte('occurred_at', windowStart.toISOString())
      .order('occurred_at', { ascending: false })
      .limit(limit),
    supabase
      .from('person_merges')
      .select(
        'id, kept_person_id, merged_person_id, tier, signals, merged_at, merged_by, undone_at, snapshot',
      )
      .eq('venue_id', venueId)
      .gte('merged_at', windowStart.toISOString())
      .order('merged_at', { ascending: false })
      .limit(limit),
  ])

  const coupleRaw = (coupleResp.data ?? []) as RawCoupleMergeRow[]
  const personRaw = (personResp.data ?? []) as RawPersonMergeRow[]

  // Hydrate couples mentioned by the couple-event rows.
  const coupleIds = new Set<string>()
  for (const r of coupleRaw) {
    if (r.primary_couple_id) coupleIds.add(r.primary_couple_id)
    if (r.secondary_couple_id) coupleIds.add(r.secondary_couple_id)
  }
  const coupleLabels = new Map<string, string | null>()
  if (coupleIds.size > 0) {
    const { data } = await supabase
      .from('couples')
      .select('id, primary_contact_name, primary_contact_email')
      .in('id', [...coupleIds])
    for (const row of (data ?? []) as Array<{
      id: string
      primary_contact_name: string | null
      primary_contact_email: string | null
    }>) {
      coupleLabels.set(row.id, labelCouple(row))
    }
  }

  // Hydrate people referenced by the person-merge rows. The kept_person
  // row is still in `people`; the merged_person row was deleted (or
  // tombstoned). For deleted rows we read the JSON snapshot so the
  // surface still has a name to render.
  const keptPersonIds = new Set<string>()
  for (const r of personRaw) {
    if (r.kept_person_id) keptPersonIds.add(r.kept_person_id)
  }
  const personLabels = new Map<string, string | null>()
  if (keptPersonIds.size > 0) {
    const { data } = await supabase
      .from('people')
      .select('id, first_name, last_name, email')
      .in('id', [...keptPersonIds])
    for (const row of (data ?? []) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>) {
      personLabels.set(row.id, labelPerson(row))
    }
  }

  const out: RecentMergeRow[] = []

  for (const r of coupleRaw) {
    const kind = COUPLE_KIND_LABEL[r.event_type]
    if (!kind) continue
    out.push({
      id: r.id,
      source: 'couple_event',
      kind,
      occurredAt: r.occurred_at,
      kindLabel: kindLabel(kind),
      actor: r.operator_id ? 'operator' : 'auto',
      confidenceTier: coerceTier(r.confidence_tier),
      ruleTriggered: r.rule_triggered,
      reason: r.reason,
      primary: {
        id: r.primary_couple_id,
        label: r.primary_couple_id
          ? coupleLabels.get(r.primary_couple_id) ?? null
          : null,
      },
      secondary: {
        id: r.secondary_couple_id,
        label: r.secondary_couple_id
          ? coupleLabels.get(r.secondary_couple_id) ?? null
          : null,
      },
      // couple_merge_events has no undone_at; we treat resurrection_rejected /
      // manual_unmerge as the rollback signal but they're separate rows, so
      // for the digest we render every captured event as live until the
      // operator clicks undo (the click writes a paired reversal event).
      undone: false,
      undoneAt: null,
    })
  }

  for (const r of personRaw) {
    // Pull a name out of the snapshot for the merged-away side.
    const snapshotPerson =
      ((r.snapshot ?? {}) as { person?: Record<string, unknown> }).person ?? null
    const mergedLabel = snapshotPerson
      ? labelPerson({
          first_name:
            (snapshotPerson.first_name as string | null | undefined) ?? null,
          last_name:
            (snapshotPerson.last_name as string | null | undefined) ?? null,
          email: (snapshotPerson.email as string | null | undefined) ?? null,
        })
      : null
    out.push({
      id: r.id,
      source: 'person_merge',
      kind: 'person_merge',
      occurredAt: r.merged_at,
      kindLabel: kindLabel('person_merge'),
      actor: r.merged_by ? 'operator' : 'auto',
      confidenceTier: coerceTier(r.tier),
      ruleTriggered: Array.isArray(r.signals) && r.signals.length > 0
        ? r.signals.map((s) => s.type).join(', ')
        : null,
      reason: Array.isArray(r.signals) && r.signals.length > 0
        ? r.signals.map((s) => s.detail).filter(Boolean).join(' · ')
        : null,
      primary: {
        id: r.kept_person_id,
        label: r.kept_person_id ? personLabels.get(r.kept_person_id) ?? null : null,
      },
      secondary: {
        id: r.merged_person_id,
        label: mergedLabel,
      },
      undone: !!r.undone_at,
      undoneAt: r.undone_at,
    })
  }

  // Sort merged list by occurredAt desc.
  out.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    windowHours,
    rows: out.slice(0, limit),
  }
}
