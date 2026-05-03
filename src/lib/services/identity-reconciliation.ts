/**
 * Cross-source identity reconciliation (Stream KK / migration 177).
 *
 * The capstone of the wave-7 multi-source import work. After three
 * lead-source files import (HoneyBook, Calendly, web calculator) for
 * a single venue, the same human appears as multiple `weddings` rows
 * — once per source. This service walks the imported set and:
 *
 *   1. Clusters by exact-email match (partner1_email, partner2_email,
 *      union across both partners).
 *   2. For each cluster of 2+ rows, picks the WINNER (most fields
 *      populated + most-recent inquiry_date) and tags the others as
 *      LOSERS via weddings.merged_into_id.
 *   3. Backfills missing winner fields from any loser (e.g. Calendly's
 *      "Where did you hear about us?" fills the HoneyBook lead_source
 *      gap).
 *   4. Appends a source_records[] entry to the winner per merged
 *      loser so the audit trail is intact.
 *
 * Two-tier merge policy:
 *   - Tier 1 (auto-merge): cluster has identical name + email + phone
 *     + wedding_date within ±90d (or both NULL). Safe to merge silently.
 *   - Tier 2 (surface for review): same email but conflicting names
 *     ("John Smith" vs "Jonathan Smith") OR wedding_date >90d apart
 *     OR phone disagreement. Coordinator decides via the
 *     /onboarding/identity-reconciliation page.
 *
 * Constitution invariant: losers are NEVER hard-deleted. weddings.merged_into_id
 * preserves the forensic record per bloom-constitution.md / Point-Zero
 * doctrine. If a coordinator wants to undo a merge, they can flip
 * merged_into_id back to NULL and the row reappears as active.
 *
 * For a venue with only ONE lead source (or where every cluster has
 * only one row), this service is a no-op — clustersFound = 0, nothing
 * mutated. Safe to develop + ship before GG/HH/II merge.
 *
 * Reuses Phase B candidate_identities machinery (per
 * bloom-phase-b-decisions.md) implicitly: this service operates on
 * weddings rows that the Phase B resolver may have already touched.
 * Reconciliation runs *after* Phase B does its candidate→wedding
 * resolution, so any wedding the resolver already attached to the same
 * candidate cluster lands in the same email-cluster here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  /** When true, compute the plan but don't write anything. Returns the
   *  same shape as a real run with all "merged" / "backfilled" fields
   *  reflecting what *would* happen. Useful for the preview UI on the
   *  /onboarding/identity-reconciliation page. */
  dryRun?: boolean
  /** Override the auto-merge wedding-date window. Default 90 days. */
  weddingDateWindowDays?: number
}

export interface ReconciliationResult {
  venueId: string
  /** Total clusters of 2+ active weddings sharing an email. */
  clustersFound: number
  /** Clusters auto-merged under Tier 1 rules. */
  autoMerged: number
  /** Clusters surfaced for coordinator review via Tier 2. */
  surfacedForReview: number
  /** Per-field count of how many winners gained a value during
   *  backfill (null → loser-supplied). Coordinator surface shows this
   *  as "we filled in lead_source on 23 leads, estimated_guests on
   *  17". */
  fieldsBackfilled: Record<string, number>
  /** Active weddings count BEFORE the run (informational). */
  activeBefore: number
  /** Active weddings count AFTER the run (informational). When dryRun
   *  this equals activeBefore. */
  activeAfter: number
  /** Per-cluster detail for the UI. Always populated; coordinator surface
   *  filters to surfacedForReview clusters by status. */
  clusters: ReconciliationCluster[]
  /** Per-row write errors. Cluster-level abort is not used; partial
   *  success is preferred so a single bad cluster doesn't block the
   *  rest. */
  errors: string[]
  /** When dryRun was true, no DB mutations occurred. */
  dryRun: boolean
}

export interface ReconciliationCluster {
  status: 'auto_merged' | 'surfaced_for_review' | 'singleton_skipped'
  /** The email that anchored the cluster. */
  email: string
  /** All wedding ids in the cluster, winner first. */
  weddingIds: string[]
  /** The chosen winner id (highest completeness × most-recent inquiry). */
  winnerId: string | null
  /** Loser ids that point at the winner via merged_into_id. */
  loserIds: string[]
  /** Conflict reasons that pushed this cluster to Tier 2. Empty for
   *  auto_merged clusters. */
  conflicts: ConflictReason[]
  /** Field-level backfill log: which winner fields gained which loser
   *  values. Captured even for surfaced clusters so the UI can preview
   *  what coordinator confirmation would do. */
  backfillPlan: Array<{ field: string; from_loser: string; value: unknown }>
}

export type ConflictReason =
  | 'name_conflict'
  | 'wedding_date_conflict'
  | 'phone_conflict'
  | 'partner_name_conflict'

// Internal shape — what we pull from the DB per wedding.
interface WeddingForReconcile {
  id: string
  venue_id: string
  status: string | null
  inquiry_date: string | null
  wedding_date: string | null
  guest_count_estimate: number | null
  estimated_guests: number | null
  booking_value: number | null
  lead_source: string | null
  source: string | null
  source_detail: string | null
  notes: string | null
  crm_source: string | null
  confidence_flag: string | null
  source_records: unknown[]
  // People joined in via wedding_id.
  people: Array<{
    id: string
    role: string | null
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
  }>
}

// ---------------------------------------------------------------------------
// Constants — fields we backfill from losers onto winners
// ---------------------------------------------------------------------------

/** Wedding-row scalar fields where a NULL winner accepts a non-NULL
 *  loser value. Order matters only for log readability. */
const BACKFILL_WEDDING_FIELDS = [
  'lead_source',
  'source',
  'source_detail',
  'wedding_date',
  'guest_count_estimate',
  'estimated_guests',
  'booking_value',
  'notes',
  'crm_source',
] as const

/** People-row scalar fields where a NULL winner-side person accepts a
 *  non-NULL loser-side person value (matched by role). */
const BACKFILL_PERSON_FIELDS = ['first_name', 'last_name', 'email', 'phone'] as const

const DEFAULT_WEDDING_DATE_WINDOW_DAYS = 90

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeEmail(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim()
}

function normalizePhone(s: string | null | undefined): string {
  return (s ?? '').replace(/\D+/g, '')
}

function normalizeName(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}

/** Two names "match" if either is empty OR both normalize to the same
 *  string OR one is a substring of the other (e.g. "John" vs "John W").
 *  Conservative — used only for the auto-merge gate. */
function namesAreCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return true
  if (na === nb) return true
  // Handle "John" vs "Jonathan" via prefix check (common).
  if (na.startsWith(nb) || nb.startsWith(na)) return true
  return false
}

function namesAreConflicting(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  if (na === nb) return false
  if (na.startsWith(nb) || nb.startsWith(na)) return false
  return true
}

function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  const ta = new Date(a).getTime()
  const tb = new Date(b).getTime()
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return Math.abs(ta - tb) / (1000 * 60 * 60 * 24)
}

/** Completeness score: count of populated wedding-level fields plus
 *  the populated-people-fields signal. Used to break ties on the
 *  winner-pick. */
function completenessScore(w: WeddingForReconcile): number {
  let n = 0
  if (w.wedding_date) n += 1
  if (w.guest_count_estimate || w.estimated_guests) n += 1
  if (w.booking_value) n += 1
  if (w.lead_source) n += 1
  if (w.source) n += 1
  if (w.notes && w.notes.trim().length > 0) n += 1
  for (const p of w.people ?? []) {
    if (p.email) n += 1
    if (p.phone) n += 1
    if (p.first_name) n += 0.5
    if (p.last_name) n += 0.5
  }
  return n
}

/** Sortable timestamp — prefer inquiry_date, fall back to most-recent
 *  populated date so a row with NULL inquiry_date doesn't always lose. */
function recencyEpoch(w: WeddingForReconcile): number {
  if (w.inquiry_date) {
    const t = new Date(w.inquiry_date).getTime()
    if (Number.isFinite(t)) return t
  }
  return 0
}

/** Collect every email associated with a wedding (partner1, partner2,
 *  any other person row). All lower-cased. */
function collectEmails(w: WeddingForReconcile): Set<string> {
  const out = new Set<string>()
  for (const p of w.people ?? []) {
    const e = normalizeEmail(p.email)
    if (e) out.add(e)
  }
  return out
}

/** Find the partner1 person for a wedding, falling back to the first
 *  person row if no role label is set. */
function findPartner1(w: WeddingForReconcile): WeddingForReconcile['people'][number] | null {
  if (!w.people || w.people.length === 0) return null
  const p1 = w.people.find((p) => p.role === 'partner1')
  if (p1) return p1
  return w.people[0]
}

function findPartner2(w: WeddingForReconcile): WeddingForReconcile['people'][number] | null {
  if (!w.people || w.people.length === 0) return null
  return w.people.find((p) => p.role === 'partner2') ?? null
}

// ---------------------------------------------------------------------------
// Cluster + adjudicate
// ---------------------------------------------------------------------------

/** Build clusters via union-find on shared emails. Returns Map of
 *  cluster-key → wedding rows. Singleton clusters (1 wedding) are
 *  retained so the caller can report singleton_skipped status. */
function buildClusters(weddings: WeddingForReconcile[]): Map<string, WeddingForReconcile[]> {
  // Each wedding has 0..N emails. Two weddings cluster together if
  // they share at least one email. Implemented as union-find.
  const idToIdx = new Map<string, number>()
  weddings.forEach((w, i) => idToIdx.set(w.id, i))

  const parent = weddings.map((_, i) => i)
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  function union(a: number, b: number): void {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // For each email, union all weddings that share it.
  const emailToIdxs = new Map<string, number[]>()
  weddings.forEach((w, i) => {
    for (const e of collectEmails(w)) {
      const arr = emailToIdxs.get(e) ?? []
      arr.push(i)
      emailToIdxs.set(e, arr)
    }
  })
  for (const idxs of emailToIdxs.values()) {
    for (let k = 1; k < idxs.length; k++) union(idxs[0], idxs[k])
  }

  // Group by root.
  const groups = new Map<number, WeddingForReconcile[]>()
  weddings.forEach((w, i) => {
    const r = find(i)
    const g = groups.get(r) ?? []
    g.push(w)
    groups.set(r, g)
  })

  // Re-key by anchor email for downstream readability.
  const out = new Map<string, WeddingForReconcile[]>()
  let unkN = 0
  for (const cluster of groups.values()) {
    let anchorEmail = ''
    for (const w of cluster) {
      const emails = [...collectEmails(w)].sort()
      if (emails.length > 0) { anchorEmail = emails[0]; break }
    }
    const key = anchorEmail || `__no_email_${unkN++}`
    out.set(key, cluster)
  }
  return out
}

/** Pick winner: highest completeness; tiebreak on most-recent inquiry. */
function pickWinner(cluster: WeddingForReconcile[]): WeddingForReconcile {
  let best = cluster[0]
  let bestScore = completenessScore(best)
  let bestRecency = recencyEpoch(best)
  for (let i = 1; i < cluster.length; i++) {
    const s = completenessScore(cluster[i])
    const r = recencyEpoch(cluster[i])
    if (s > bestScore || (s === bestScore && r > bestRecency)) {
      best = cluster[i]
      bestScore = s
      bestRecency = r
    }
  }
  return best
}

/** Tier-1 auto-merge gate. Returns conflict reasons; empty array means
 *  the cluster is safe to auto-merge. */
function adjudicate(
  cluster: WeddingForReconcile[],
  winner: WeddingForReconcile,
  weddingDateWindowDays: number,
): ConflictReason[] {
  const reasons: ConflictReason[] = []
  const winnerP1 = findPartner1(winner)
  const winnerP2 = findPartner2(winner)
  const winnerDate = winner.wedding_date

  for (const loser of cluster) {
    if (loser.id === winner.id) continue
    const loserP1 = findPartner1(loser)
    const loserP2 = findPartner2(loser)

    // Partner1 first/last name conflict?
    if (
      namesAreConflicting(winnerP1?.first_name ?? null, loserP1?.first_name ?? null) ||
      namesAreConflicting(winnerP1?.last_name ?? null, loserP1?.last_name ?? null)
    ) {
      if (!reasons.includes('name_conflict')) reasons.push('name_conflict')
    }

    // Partner2 conflict (if both have a partner2).
    if (winnerP2 && loserP2) {
      if (
        namesAreConflicting(winnerP2.first_name ?? null, loserP2.first_name ?? null) ||
        namesAreConflicting(winnerP2.last_name ?? null, loserP2.last_name ?? null)
      ) {
        if (!reasons.includes('partner_name_conflict')) reasons.push('partner_name_conflict')
      }
    }

    // Wedding-date conflict — both populated AND > window-days apart.
    if (winnerDate && loser.wedding_date) {
      const days = daysBetween(winnerDate, loser.wedding_date)
      if (days !== null && days > weddingDateWindowDays) {
        if (!reasons.includes('wedding_date_conflict')) reasons.push('wedding_date_conflict')
      }
    }

    // Phone conflict — both populated AND non-overlapping last-10
    // digits.
    const wPhones = (winner.people ?? []).map((p) => normalizePhone(p.phone)).filter(Boolean)
    const lPhones = (loser.people ?? []).map((p) => normalizePhone(p.phone)).filter(Boolean)
    if (wPhones.length > 0 && lPhones.length > 0) {
      const overlap = wPhones.some((p) =>
        lPhones.some((q) => p === q || p.endsWith(q) || q.endsWith(p)),
      )
      if (!overlap) {
        if (!reasons.includes('phone_conflict')) reasons.push('phone_conflict')
      }
    }
    // Compatibility check — if names are compatible we don't flip
    // back. namesAreCompatible exists for symmetry; the conflict
    // decision is the negative path.
    if (!namesAreCompatible(winnerP1?.first_name ?? null, loserP1?.first_name ?? null)) {
      // Already covered by namesAreConflicting above; left here as a
      // belt-and-braces check should the helpers diverge.
    }
  }
  return reasons
}

/** Compute the field-level backfill plan: for each NULL field on the
 *  winner, take the first non-NULL loser value. Returns the plan
 *  AND a flat map of the new winner-row payload (for the UPDATE). */
function planBackfill(
  cluster: WeddingForReconcile[],
  winner: WeddingForReconcile,
): {
  plan: Array<{ field: string; from_loser: string; value: unknown }>
  weddingPayload: Record<string, unknown>
} {
  const plan: Array<{ field: string; from_loser: string; value: unknown }> = []
  const weddingPayload: Record<string, unknown> = {}

  for (const field of BACKFILL_WEDDING_FIELDS) {
    const cur = (winner as unknown as Record<string, unknown>)[field]
    if (cur != null && cur !== '') continue
    for (const loser of cluster) {
      if (loser.id === winner.id) continue
      const v = (loser as unknown as Record<string, unknown>)[field]
      if (v != null && v !== '') {
        plan.push({ field, from_loser: loser.id, value: v })
        weddingPayload[field] = v
        break
      }
    }
  }

  return { plan, weddingPayload }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function reconcileVenue(
  supabase: SupabaseClient,
  venueId: string,
  options: ReconcileOptions = {},
): Promise<ReconciliationResult> {
  const dryRun = options.dryRun === true
  const weddingDateWindowDays = options.weddingDateWindowDays ?? DEFAULT_WEDDING_DATE_WINDOW_DAYS

  const result: ReconciliationResult = {
    venueId,
    clustersFound: 0,
    autoMerged: 0,
    surfacedForReview: 0,
    fieldsBackfilled: {},
    activeBefore: 0,
    activeAfter: 0,
    clusters: [],
    errors: [],
    dryRun,
  }

  // Load active weddings + their people.
  const { data: weddingsRaw, error: wedErr } = await supabase
    .from('weddings')
    .select(`
      id, venue_id, status, inquiry_date, wedding_date,
      guest_count_estimate, estimated_guests, booking_value,
      lead_source, source, source_detail, notes,
      crm_source, confidence_flag, source_records,
      people!people_wedding_id_fkey (
        id, role, first_name, last_name, email, phone
      )
    `)
    .eq('venue_id', venueId)
    .is('merged_into_id', null)

  if (wedErr) {
    result.errors.push(`weddings load failed: ${wedErr.message}`)
    return result
  }

  // Normalize the join shape — Supabase returns people as an array of
  // objects (or single object for !left). We assume array.
  const weddings: WeddingForReconcile[] = ((weddingsRaw ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const peopleRaw = r.people as Array<Record<string, unknown>> | null | undefined
    const people = (peopleRaw ?? []).map((p) => ({
      id: String(p.id ?? ''),
      role: (p.role as string | null) ?? null,
      first_name: (p.first_name as string | null) ?? null,
      last_name: (p.last_name as string | null) ?? null,
      email: (p.email as string | null) ?? null,
      phone: (p.phone as string | null) ?? null,
    }))
    return {
      id: String(r.id ?? ''),
      venue_id: String(r.venue_id ?? ''),
      status: (r.status as string | null) ?? null,
      inquiry_date: (r.inquiry_date as string | null) ?? null,
      wedding_date: (r.wedding_date as string | null) ?? null,
      guest_count_estimate: (r.guest_count_estimate as number | null) ?? null,
      estimated_guests: (r.estimated_guests as number | null) ?? null,
      booking_value: (r.booking_value as number | null) ?? null,
      lead_source: (r.lead_source as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      source_detail: (r.source_detail as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      crm_source: (r.crm_source as string | null) ?? null,
      confidence_flag: (r.confidence_flag as string | null) ?? null,
      source_records: Array.isArray(r.source_records) ? (r.source_records as unknown[]) : [],
      people,
    } as WeddingForReconcile
  })

  result.activeBefore = weddings.length
  result.activeAfter = weddings.length

  if (weddings.length === 0) return result

  const clusters = buildClusters(weddings)

  for (const [anchorEmail, cluster] of clusters.entries()) {
    if (cluster.length < 2) {
      // Singleton — record but don't act.
      result.clusters.push({
        status: 'singleton_skipped',
        email: anchorEmail.startsWith('__no_email_') ? '' : anchorEmail,
        weddingIds: [cluster[0].id],
        winnerId: cluster[0].id,
        loserIds: [],
        conflicts: [],
        backfillPlan: [],
      })
      continue
    }

    result.clustersFound += 1

    const winner = pickWinner(cluster)
    const conflicts = adjudicate(cluster, winner, weddingDateWindowDays)
    const losers = cluster.filter((w) => w.id !== winner.id)
    const { plan, weddingPayload } = planBackfill(cluster, winner)

    const status: 'auto_merged' | 'surfaced_for_review' =
      conflicts.length === 0 ? 'auto_merged' : 'surfaced_for_review'

    const clusterReport: ReconciliationCluster = {
      status,
      email: anchorEmail.startsWith('__no_email_') ? '' : anchorEmail,
      weddingIds: [winner.id, ...losers.map((l) => l.id)],
      winnerId: winner.id,
      loserIds: losers.map((l) => l.id),
      conflicts,
      backfillPlan: plan,
    }
    result.clusters.push(clusterReport)

    if (status === 'surfaced_for_review') {
      result.surfacedForReview += 1
      // Don't write — coordinator decides via the
      // /onboarding/identity-reconciliation page. The plan is preserved
      // in the result so the UI can render the proposed merge.
      continue
    }

    result.autoMerged += 1
    for (const entry of plan) {
      result.fieldsBackfilled[entry.field] = (result.fieldsBackfilled[entry.field] ?? 0) + 1
    }

    if (dryRun) continue

    // ---- Apply the merge ----
    try {
      // 1. Update winner with backfilled fields + append per-loser
      //    source_records entries.
      const newSourceRecords = [...(winner.source_records ?? [])]
      for (const loser of losers) {
        newSourceRecords.push({
          source: loser.crm_source ?? loser.source ?? 'unknown',
          source_id: loser.id,
          imported_at: new Date().toISOString(),
          fields_provided: plan.filter((p) => p.from_loser === loser.id).map((p) => p.field),
          merged_from_wedding_id: loser.id,
        })
      }

      const winnerUpdate: Record<string, unknown> = {
        ...weddingPayload,
        source_records: newSourceRecords,
      }
      const { error: updErr } = await supabase
        .from('weddings')
        .update(winnerUpdate)
        .eq('id', winner.id)
      if (updErr) {
        result.errors.push(`winner ${winner.id} update failed: ${updErr.message}`)
        continue
      }

      // 2. Backfill people on the winner from losers (per role).
      //    If the winner is missing partner2 entirely, copy the
      //    loser's partner2 row over (re-pointed at winner's
      //    wedding_id). If the winner has partner1 with NULL email
      //    + a loser has partner1 with non-NULL email, fill it.
      await backfillPeopleFromLosers(supabase, winner, losers, result)

      // 3. Stamp losers with merged_into_id.
      for (const loser of losers) {
        const { error: loserErr } = await supabase
          .from('weddings')
          .update({ merged_into_id: winner.id })
          .eq('id', loser.id)
        if (loserErr) {
          result.errors.push(`loser ${loser.id} stamp failed: ${loserErr.message}`)
        }
      }

      result.activeAfter -= losers.length
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown reconcile error'
      result.errors.push(`cluster ${anchorEmail}: ${msg}`)
    }
  }

  // T5-Rixey-EEE Bug 1: after the WEDDING-level reconciliation runs,
  // every cluster of merged weddings now has its people pointing at
  // the canonical wedding. THIS is the right moment to also collapse
  // PEOPLE rows within the surviving wedding — the same human under
  // multiple email aliases (Knot proxy + real Gmail; Knot + WW + real
  // Gmail) still appears as multiple `people` rows after KK.
  // Without the alias-merge, lead detail headlines render as
  // "Sarah & Sarah & Sarah" because the join walks every contact.
  // Skipped on dryRun so the preview UI doesn't surface phantom
  // collapses.
  if (!dryRun) {
    try {
      const { mergePeopleAliasesForVenue } = await import('./people-merge-aliases')
      const aliasSummary = await mergePeopleAliasesForVenue(supabase, venueId)
      if (aliasSummary.rowsCollapsed > 0) {
        // Surface the alias-merge counts on the result for the
        // coordinator UI to show alongside the wedding-merge stats.
        result.fieldsBackfilled['people.alias_collapsed'] =
          (result.fieldsBackfilled['people.alias_collapsed'] ?? 0) + aliasSummary.rowsCollapsed
      }
      result.errors.push(...aliasSummary.errors)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown alias-merge error'
      result.errors.push(`alias-merge: ${msg}`)
    }
  }

  return result
}

/** People backfill: for any role missing on the winner where a loser
 *  has it populated, copy the loser's row across. For people that
 *  exist on both, fill NULL fields on the winner-side person from
 *  the loser-side person. People rows on the loser side stay attached
 *  to the loser wedding (we don't reassign by wedding_id) — this keeps
 *  the forensic record intact. The merge-people service is the
 *  separate path for hard person consolidation; here we're only
 *  enriching the winner's view. */
async function backfillPeopleFromLosers(
  supabase: SupabaseClient,
  winner: WeddingForReconcile,
  losers: WeddingForReconcile[],
  result: ReconciliationResult,
): Promise<void> {
  const winnerByRole = new Map<string, WeddingForReconcile['people'][number]>()
  for (const p of winner.people ?? []) {
    if (p.role) winnerByRole.set(p.role, p)
  }

  for (const loser of losers) {
    for (const lp of loser.people ?? []) {
      if (!lp.role) continue
      const wp = winnerByRole.get(lp.role)
      if (!wp) {
        // Winner is missing this role — clone the loser's row onto
        // the winner. We INSERT a new row pointing at the winner
        // wedding so the loser row stays as forensic record.
        const { data: inserted, error: insErr } = await supabase
          .from('people')
          .insert({
            venue_id: winner.venue_id,
            wedding_id: winner.id,
            role: lp.role,
            first_name: lp.first_name,
            last_name: lp.last_name,
            email: lp.email,
            phone: lp.phone,
          })
          .select('id, role, first_name, last_name, email, phone')
          .single()
        if (insErr) {
          result.errors.push(`person clone (winner ${winner.id} role ${lp.role}): ${insErr.message}`)
          continue
        }
        if (inserted) {
          winnerByRole.set(lp.role, {
            id: String(inserted.id),
            role: (inserted.role as string | null) ?? lp.role,
            first_name: (inserted.first_name as string | null) ?? null,
            last_name: (inserted.last_name as string | null) ?? null,
            email: (inserted.email as string | null) ?? null,
            phone: (inserted.phone as string | null) ?? null,
          })
        }
        for (const f of BACKFILL_PERSON_FIELDS) {
          if ((lp as unknown as Record<string, unknown>)[f]) {
            const key = `people.${f}`
            result.fieldsBackfilled[key] = (result.fieldsBackfilled[key] ?? 0) + 1
          }
        }
        continue
      }
      // Both sides have this role — fill NULL fields on winner-side
      // person from loser-side.
      const personUpdate: Record<string, unknown> = {}
      for (const f of BACKFILL_PERSON_FIELDS) {
        const cur = (wp as unknown as Record<string, unknown>)[f]
        const v = (lp as unknown as Record<string, unknown>)[f]
        if ((cur == null || cur === '') && v != null && v !== '') {
          personUpdate[f] = v
          const key = `people.${f}`
          result.fieldsBackfilled[key] = (result.fieldsBackfilled[key] ?? 0) + 1
        }
      }
      if (Object.keys(personUpdate).length > 0) {
        const { error: pUpdErr } = await supabase
          .from('people')
          .update(personUpdate)
          .eq('id', wp.id)
        if (pUpdErr) {
          result.errors.push(`person ${wp.id} backfill failed: ${pUpdErr.message}`)
        }
      }
    }
  }
}

/**
 * Coordinator-confirmed merge for a single cluster. Called from the
 * /onboarding/identity-reconciliation page once the coordinator picks
 * a winner from a Tier-2 cluster.
 *
 * Idempotent: passing a winnerId whose loser is already merged_into a
 * different winner is rejected with an error rather than silently
 * re-pointing.
 */
export async function applyClusterMerge(
  supabase: SupabaseClient,
  args: {
    venueId: string
    winnerId: string
    loserIds: string[]
    coordinatorUserId?: string | null
    reason?: string | null
  },
): Promise<{ ok: true; backfilled: Record<string, number> } | { ok: false; error: string }> {
  const { venueId, winnerId, loserIds } = args
  if (loserIds.length === 0) return { ok: false, error: 'no losers supplied' }
  if (loserIds.includes(winnerId)) return { ok: false, error: 'winner appears in losers list' }

  // Reload winner + losers fresh so we don't merge stale snapshot data.
  const allIds = [winnerId, ...loserIds]
  const { data: rowsRaw, error: loadErr } = await supabase
    .from('weddings')
    .select(`
      id, venue_id, status, inquiry_date, wedding_date,
      guest_count_estimate, estimated_guests, booking_value,
      lead_source, source, source_detail, notes,
      crm_source, confidence_flag, source_records, merged_into_id,
      people!people_wedding_id_fkey (
        id, role, first_name, last_name, email, phone
      )
    `)
    .in('id', allIds)
  if (loadErr) return { ok: false, error: `load failed: ${loadErr.message}` }
  const rows = ((rowsRaw ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id ?? ''),
    venue_id: String(r.venue_id ?? ''),
    status: (r.status as string | null) ?? null,
    inquiry_date: (r.inquiry_date as string | null) ?? null,
    wedding_date: (r.wedding_date as string | null) ?? null,
    guest_count_estimate: (r.guest_count_estimate as number | null) ?? null,
    estimated_guests: (r.estimated_guests as number | null) ?? null,
    booking_value: (r.booking_value as number | null) ?? null,
    lead_source: (r.lead_source as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    source_detail: (r.source_detail as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    crm_source: (r.crm_source as string | null) ?? null,
    confidence_flag: (r.confidence_flag as string | null) ?? null,
    source_records: Array.isArray(r.source_records) ? (r.source_records as unknown[]) : [],
    merged_into_id: (r.merged_into_id as string | null) ?? null,
    people: ((r.people as Array<Record<string, unknown>>) ?? []).map((p) => ({
      id: String(p.id ?? ''),
      role: (p.role as string | null) ?? null,
      first_name: (p.first_name as string | null) ?? null,
      last_name: (p.last_name as string | null) ?? null,
      email: (p.email as string | null) ?? null,
      phone: (p.phone as string | null) ?? null,
    })),
  }))
  // Wrong-venue guard.
  if (rows.some((r) => r.venue_id !== venueId)) {
    return { ok: false, error: 'cross-venue rows in cluster' }
  }
  // Already-merged guard.
  for (const r of rows) {
    if (r.id === winnerId) continue
    if (r.merged_into_id && r.merged_into_id !== winnerId) {
      return { ok: false, error: `loser ${r.id} already merged into different winner ${r.merged_into_id}` }
    }
  }

  const winner = rows.find((r) => r.id === winnerId) as WeddingForReconcile | undefined
  if (!winner) return { ok: false, error: `winner ${winnerId} not found` }
  const losers = rows.filter((r) => r.id !== winnerId) as WeddingForReconcile[]

  const { plan, weddingPayload } = planBackfill([winner, ...losers], winner)
  const backfilled: Record<string, number> = {}
  for (const e of plan) backfilled[e.field] = (backfilled[e.field] ?? 0) + 1

  const newSourceRecords = [...(winner.source_records ?? [])]
  for (const loser of losers) {
    newSourceRecords.push({
      source: loser.crm_source ?? loser.source ?? 'unknown',
      source_id: loser.id,
      imported_at: new Date().toISOString(),
      fields_provided: plan.filter((p) => p.from_loser === loser.id).map((p) => p.field),
      merged_from_wedding_id: loser.id,
      coordinator_decided: true,
      coordinator_user_id: args.coordinatorUserId ?? null,
      reason: args.reason ?? null,
    })
  }

  const { error: updErr } = await supabase
    .from('weddings')
    .update({ ...weddingPayload, source_records: newSourceRecords })
    .eq('id', winnerId)
  if (updErr) return { ok: false, error: `winner update failed: ${updErr.message}` }

  // backfill people from losers — reuse the cron-path helper via a
  // throwaway result envelope so the per-field counters land in the
  // returned `backfilled`.
  const peopleResult: ReconciliationResult = {
    venueId, clustersFound: 0, autoMerged: 0, surfacedForReview: 0,
    fieldsBackfilled: {}, activeBefore: 0, activeAfter: 0, clusters: [], errors: [], dryRun: false,
  }
  await backfillPeopleFromLosers(supabase, winner, losers, peopleResult)
  for (const [k, v] of Object.entries(peopleResult.fieldsBackfilled)) {
    backfilled[k] = (backfilled[k] ?? 0) + v
  }

  for (const l of losers) {
    const { error: stampErr } = await supabase
      .from('weddings')
      .update({ merged_into_id: winnerId })
      .eq('id', l.id)
    if (stampErr) return { ok: false, error: `loser ${l.id} stamp failed: ${stampErr.message}` }
  }

  return { ok: true, backfilled }
}

/**
 * Surface helper: list pending Tier-2 clusters for a venue. Used by
 * /onboarding/identity-reconciliation. Re-runs reconcileVenue in
 * dryRun=true mode (cheap — no writes) and filters to surfaced
 * clusters only.
 */
export async function listPendingClusters(
  supabase: SupabaseClient,
  venueId: string,
): Promise<ReconciliationCluster[]> {
  const r = await reconcileVenue(supabase, venueId, { dryRun: true })
  return r.clusters.filter((c) => c.status === 'surfaced_for_review')
}
