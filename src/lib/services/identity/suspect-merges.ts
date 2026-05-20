/**
 * Suspect-merge diagnostic — operator-runnable cleanup helper.
 *
 * Anchor: §C.5 cleanup pass. The matcher false-positive audit
 * (2026-05-20) caught a Rixey merge where "Kayla Williams" was bound to
 * "Makayla Keeley" on a Levenshtein-2 substring match. The matcher
 * guards shipped that day prevent the SHAPE from recurring at ingest;
 * this module surfaces the EXISTING population so the operator can
 * confirm or reject each suspect retroactively.
 *
 * Read-only by design. The operator-side action is the existing
 * /api/admin/identity/resolve `action: 'reject'` path; this module
 * just produces the candidate list with evidence.
 *
 * Three signal classes:
 *   - SUBSTRING_NAME: the two merged couples' partner1 first names
 *     share a strict-substring relationship (Kayla ⊂ Makayla, Anna ⊂
 *     Hannah). Highest-confidence suspect.
 *   - LEVENSHTEIN_REASON: the merge's `reason` field references the
 *     legacy Levenshtein-2 rule. The matcher's post-2026-05-20 guards
 *     reject these shapes; pre-shipped merges that fired on this rule
 *     are now suspect.
 *   - LOW_TIER_NAME_ONLY: low-confidence merges keyed on name-only
 *     signals (no email / phone in the reason). Soft suspect — worth
 *     a glance.
 *
 * Multi-venue safe. No Rixey-specific clauses.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const SAME_EVENT_TYPES = [
  'fragment_promoted',
  'channel_scoped_bridged',
  'candidate_confirmed',
  'manual_merge',
  'resurrection',
]

export type SuspectClass =
  | 'substring_name'
  | 'levenshtein_reason'
  | 'low_tier_name_only'

export interface SuspectMerge {
  mergeEventId: string
  primaryCoupleId: string | null
  primaryLabel: string | null
  primaryFirstName: string | null
  primaryLastName: string | null
  secondaryCoupleId: string | null
  secondaryLabel: string | null
  secondaryFirstName: string | null
  secondaryLastName: string | null
  confidenceTier: 'high' | 'medium' | 'low' | null
  reason: string | null
  ruleTriggered: string | null
  occurredAt: string
  signals: SuspectClass[]
}

interface RawMergeRow {
  id: string
  event_type: string
  confidence_tier: string | null
  reason: string | null
  rule_triggered: string | null
  occurred_at: string
  primary_couple_id: string | null
  secondary_couple_id: string | null
}

interface RawPersonRow {
  wedding_id: string
  first_name: string | null
  last_name: string | null
  role: string
}

interface RawCoupleRow {
  id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  source_wedding_id: string | null
}

function coerceTier(
  v: string | null | undefined,
): 'high' | 'medium' | 'low' | null {
  if (v === 'high' || v === 'medium' || v === 'low') return v
  return null
}

function isStrictSubstring(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const na = a.trim().toLowerCase()
  const nb = b.trim().toLowerCase()
  if (!na || !nb || na === nb) return false
  return na.includes(nb) || nb.includes(na)
}

/**
 * Pull every same-merge event for the venue and classify each as a
 * suspect when it fits one of the three signal shapes. Returns the
 * suspects sorted by signal strength (substring_name > levenshtein
 * reason > low_tier_name_only) and then by occurred_at desc within
 * each tier.
 */
export async function findSuspectMerges(
  supabase: SupabaseClient,
  venueId: string,
  options: { limit?: number } = {},
): Promise<SuspectMerge[]> {
  const limit = options.limit ?? 200

  const { data: merges, error } = await supabase
    .from('couple_merge_events')
    .select(
      'id, event_type, confidence_tier, reason, rule_triggered, occurred_at, primary_couple_id, secondary_couple_id',
    )
    .eq('venue_id', venueId)
    .in('event_type', SAME_EVENT_TYPES)
    .order('occurred_at', { ascending: false })
    .limit(limit * 4) // over-fetch; we filter to suspects
  if (error) return []

  const rows = (merges ?? []) as RawMergeRow[]
  if (rows.length === 0) return []

  // Hydrate couples + people in two bulk reads.
  const coupleIds = Array.from(
    new Set(
      rows
        .flatMap((r) => [r.primary_couple_id, r.secondary_couple_id])
        .filter((v): v is string => Boolean(v)),
    ),
  )
  const { data: couplesData } = await supabase
    .from('couples')
    .select('id, primary_contact_name, primary_contact_email, source_wedding_id')
    .in('id', coupleIds)
  const coupleById = new Map<string, RawCoupleRow>()
  for (const c of (couplesData ?? []) as RawCoupleRow[]) {
    coupleById.set(c.id, c)
  }

  // Pull partner1 people via the couples' source_wedding_id (the legacy
  // bridge — couples don't carry first/last directly). When a couple is
  // not mirror-backfilled (source_wedding_id null) we fall back to
  // parsing primary_contact_name.
  const weddingIds = Array.from(
    new Set(
      (couplesData ?? [])
        .map((c) => (c as RawCoupleRow).source_wedding_id)
        .filter((v): v is string => Boolean(v)),
    ),
  )
  const peopleByWedding = new Map<string, RawPersonRow>()
  if (weddingIds.length > 0) {
    const { data: people } = await supabase
      .from('people')
      .select('wedding_id, first_name, last_name, role')
      .in('wedding_id', weddingIds)
      .eq('role', 'partner1')
    for (const p of (people ?? []) as RawPersonRow[]) {
      if (!peopleByWedding.has(p.wedding_id)) peopleByWedding.set(p.wedding_id, p)
    }
  }

  function namesFor(coupleId: string | null): {
    first: string | null
    last: string | null
    label: string | null
  } {
    if (!coupleId) return { first: null, last: null, label: null }
    const couple = coupleById.get(coupleId)
    if (!couple) return { first: null, last: null, label: null }
    const ppl = couple.source_wedding_id
      ? peopleByWedding.get(couple.source_wedding_id) ?? null
      : null
    if (ppl) {
      return {
        first: ppl.first_name ?? null,
        last: ppl.last_name ?? null,
        label: couple.primary_contact_name ?? couple.primary_contact_email,
      }
    }
    // Fall back to parsing primary_contact_name.
    const name = couple.primary_contact_name ?? ''
    const parts = name.trim().split(/\s+/).filter(Boolean)
    return {
      first: parts[0] ?? null,
      last: parts[parts.length - 1] ?? null,
      label: couple.primary_contact_name ?? couple.primary_contact_email,
    }
  }

  const suspects: SuspectMerge[] = []
  for (const r of rows) {
    const tier = coerceTier(r.confidence_tier)
    const pNames = namesFor(r.primary_couple_id)
    const sNames = namesFor(r.secondary_couple_id)

    const signals: SuspectClass[] = []

    // Signal 1: strict-substring on first OR last name.
    if (
      isStrictSubstring(pNames.first, sNames.first) ||
      isStrictSubstring(pNames.last, sNames.last)
    ) {
      signals.push('substring_name')
    }

    // Signal 2: reason references levenshtein2 (the legacy rule).
    if (r.reason && /levenshtein/i.test(r.reason)) {
      signals.push('levenshtein_reason')
    }

    // Signal 3: low-tier name-only merge (no email / phone in reason).
    if (
      tier === 'low' &&
      r.reason &&
      /name/i.test(r.reason) &&
      !/email|phone/i.test(r.reason)
    ) {
      signals.push('low_tier_name_only')
    }

    if (signals.length === 0) continue

    suspects.push({
      mergeEventId: r.id,
      primaryCoupleId: r.primary_couple_id,
      primaryLabel: pNames.label,
      primaryFirstName: pNames.first,
      primaryLastName: pNames.last,
      secondaryCoupleId: r.secondary_couple_id,
      secondaryLabel: sNames.label,
      secondaryFirstName: sNames.first,
      secondaryLastName: sNames.last,
      confidenceTier: tier,
      reason: r.reason,
      ruleTriggered: r.rule_triggered,
      occurredAt: r.occurred_at,
      signals,
    })

    if (suspects.length >= limit) break
  }

  // Order: strongest signal first, then most recent.
  const sigWeight = (s: SuspectClass): number => {
    if (s === 'substring_name') return 3
    if (s === 'levenshtein_reason') return 2
    return 1
  }
  suspects.sort((a, b) => {
    const aw = Math.max(...a.signals.map(sigWeight))
    const bw = Math.max(...b.signals.map(sigWeight))
    if (aw !== bw) return bw - aw
    return b.occurredAt.localeCompare(a.occurredAt)
  })
  return suspects
}
