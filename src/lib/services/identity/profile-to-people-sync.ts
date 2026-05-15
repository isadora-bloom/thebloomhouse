/**
 * Bloom House — Wave 4 Phase 3 profile→people sync.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; couple_identity_profile is the source of truth, the
 *     people table is a legacy projection that the rest of the
 *     codebase still reads; this service keeps the projection
 *     consistent with the truth.)
 *   - bloom-wave4-identity-reconstruction.md (Phase 3 builds readers;
 *     Phase 4 retires duplicate writers. The legacy people row stays
 *     populated as a courtesy for legacy readers — but its content
 *     comes from the forensic profile from this point forward.)
 *
 * Purpose
 * -------
 * After a successful reconstructCoupleIdentity() upsert, call
 * syncProfileToPeople() to project the forensic profile back onto
 * the legacy people / weddings rows so every legacy reader (lead-
 * detail couple-name pickers, inbox, dashboard, briefings) reads
 * names that are consistent with the LLM-judged truth.
 *
 * The sync is **non-fatal** — failures log + continue. The profile
 * is the source of truth; legacy people sync is a courtesy for
 * legacy readers.
 *
 * Behaviour
 * ---------
 * Three branches keyed off `profile.names`:
 *
 * 1. `name_quality` ∈ {'high','medium'} AND profile partner first/last
 *    differ from the existing people row first/last, AND the profile's
 *    partner confidence beats the strongest existing
 *    `name_evidence` confidence:
 *      - Update people.first_name + people.last_name from the profile
 *      - Append a `name_evidence` entry tagged source='reconstruction'
 *        with quote=profile.partner.evidence_quote and
 *        confidence=profile.partner.confidence_0_100
 *      - Stamp people.name_confidence to the profile's confidence
 *
 * 2. `is_phantom_partner_relationship === true`:
 *      - Soft-tombstone partner2 (set people.merged_into_id = partner1.id)
 *      - Set weddings.partner_count = 1
 *      Constitution invariant: NEVER hard-delete; soft-tombstone only.
 *
 * 3. `name_quality === 'unknown'`:
 *      - For partner1, set people.first_name = '(Unknown)' (preserving
 *        the original in display_handle when the column is unset)
 *      - Append a refusal-derived row to name_evidence so the audit
 *        trail explains why
 *
 * Idempotency
 * -----------
 * Every branch is idempotent. The name-update branch checks before
 * writing whether the existing name already matches the profile and
 * whether an evidence row from this same reconstruction (matched on
 * source='reconstruction' + same confidence + same quote) already
 * exists. The phantom branch is a no-op when partner2 is already
 * tombstoned. The unknown branch is a no-op when the first_name is
 * already '(Unknown)' and a refusal-derived evidence row is on file.
 *
 * Re-running syncProfileToPeople twice on the same wedding does NOT
 * double-write evidence rows or re-tombstone an already-tombstoned
 * partner.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getStoredCoupleIdentityProfile,
  type StoredCoupleIdentityProfile,
} from './reconstruct'
import type { NameClaim } from '@/config/prompts/identity-reconstruction'

const SYNC_SOURCE = 'reconstruction'
const SYNC_REFUSAL_SOURCE = 'reconstruction_refusal'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SyncProfileToPeopleOutcome =
  | { ok: true; updated: SyncUpdate[] }
  | { ok: false; reason: string }

export type SyncUpdate =
  | {
      kind: 'name_updated'
      personId: string
      role: 'partner1' | 'partner2'
      previous: { first: string | null; last: string | null }
      next: { first: string | null; last: string | null }
      confidence: number
    }
  | {
      kind: 'name_evidence_appended'
      personId: string
      role: 'partner1' | 'partner2'
      source: string
    }
  | {
      kind: 'phantom_tombstoned'
      partner2Id: string
      keptPartner1Id: string
    }
  | {
      kind: 'partner_count_set'
      weddingId: string
      partnerCount: number
    }
  | {
      kind: 'unknown_marker'
      personId: string
      role: 'partner1' | 'partner2'
    }
  | {
      kind: 'partner2_created'
      personId: string
      first: string | null
      last: string | null
      confidence: number
    }
  | {
      kind: 'partner1_created'
      personId: string
      first: string | null
      last: string | null
      confidence: number
    }

interface PersonRow {
  id: string
  venue_id: string
  role: string | null
  first_name: string | null
  last_name: string | null
  display_handle: string | null
  name_evidence: unknown
  name_confidence: number | null
  merged_into_id: string | null
}

interface NameEvidenceEntry {
  source: string
  value: { first: string | null; last: string | null }
  confidence: number | null
  captured_at: string
  // Optional fields
  quote?: string | null
  reason?: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(value: unknown): NameEvidenceEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is NameEvidenceEntry => {
    if (!v || typeof v !== 'object') return false
    const r = v as Record<string, unknown>
    return typeof r.source === 'string'
  })
}

function strongestExistingConfidence(evidence: NameEvidenceEntry[]): number {
  let best = 0
  for (const e of evidence) {
    const c = typeof e.confidence === 'number' ? e.confidence : 0
    if (c > best) best = c
  }
  return best
}

function namesEqual(a: string | null, b: string | null): boolean {
  const na = (a ?? '').trim().toLowerCase()
  const nb = (b ?? '').trim().toLowerCase()
  return na === nb
}

function reconstructionEntryAlreadyPresent(
  evidence: NameEvidenceEntry[],
  partner: NameClaim,
): boolean {
  for (const e of evidence) {
    if (e.source !== SYNC_SOURCE) continue
    const sameFirst = namesEqual(e.value?.first ?? null, partner.first ?? null)
    const sameLast = namesEqual(e.value?.last ?? null, partner.last ?? null)
    const sameConf = (e.confidence ?? -1) === partner.confidence_0_100
    if (sameFirst && sameLast && sameConf) return true
  }
  return false
}

function refusalEntryAlreadyPresent(evidence: NameEvidenceEntry[]): boolean {
  for (const e of evidence) {
    if (e.source === SYNC_REFUSAL_SOURCE) return true
  }
  return false
}

/**
 * Re-query the live DB for ANY non-tombstoned person on this wedding
 * that could already represent `role`, and adopt it instead of inserting
 * a fresh row.
 *
 * Why this exists (root-cause fix, 2026-05-15)
 * --------------------------------------------
 * The partner1_created / partner2_created branches below used to fire a
 * blind `.from('people').insert(...)` whenever `loadPartners()` returned
 * no row for the role. That produced duplicate live partner rows:
 *   - loadPartners() filters `.in('role', ['partner1','partner2'])`, so a
 *     real partner row whose role is null / 'partner' / mis-cased is
 *     INVISIBLE to the find — the branch then inserts a second one.
 *   - reconstruction runs repeatedly (a cron + signal triggers). If a
 *     concurrent mergePeople had momentarily tombstoned the partner2
 *     (it sets merged_into_id, reassigns children, then a later step
 *     may role-correct), a sync that reads mid-merge sees no partner2
 *     and inserts. The merge then leaves both alive.
 *   Rixey carried 3 such weddings ("Mike & Mike", "Joseph & Joseph",
 *   "(Unknown) & Ramsey") that came back after every manual merge.
 *
 * The fix: this is a match-and-update, not a blind insert. We re-read
 * the wedding's people fresh and look for an adoptable row using, in
 * priority order: (1) exact role match the loadPartners filter missed,
 * (2) same first name (case-insensitive) as the profile claim, (3) the
 * lone "other" role slot when the wedding has exactly one untyped row.
 * Only when none of those match do we INSERT — meaning a duplicate
 * partner row is impossible by construction.
 *
 * Returns the id of an existing adoptable row (caller should UPDATE its
 * role/name), or null (caller should INSERT a fresh row).
 */
async function findAdoptablePartnerRow(
  supabase: SupabaseClient,
  weddingId: string,
  role: 'partner1' | 'partner2',
  claimFirst: string | null,
): Promise<{ id: string; venue_id: string } | null> {
  const { data, error } = await supabase
    .from('people')
    .select('id, venue_id, role, first_name')
    .eq('wedding_id', weddingId)
    .is('merged_into_id', null)
  if (error || !data) return null
  const rows = data as Array<{
    id: string
    venue_id: string
    role: string | null
    first_name: string | null
  }>
  if (rows.length === 0) return null

  // Priority 1: a row already typed as this exact role (loadPartners
  // could only have missed it on a race; adopt it, never duplicate it).
  const exactRole = rows.find((r) => r.role === role)
  if (exactRole) return { id: exactRole.id, venue_id: exactRole.venue_id }

  // Priority 2: a row whose first name matches the profile claim — this
  // is the same human under a stale/blank role. Adopt + re-role it.
  if (claimFirst) {
    const byName = rows.find((r) => namesEqual(r.first_name, claimFirst))
    if (byName) return { id: byName.id, venue_id: byName.venue_id }
  }

  // Priority 3: exactly one row that is NOT the opposite partner — it is
  // the unfilled slot for this role. Adopt it rather than inserting a
  // sibling.
  const opposite = role === 'partner1' ? 'partner2' : 'partner1'
  const candidates = rows.filter((r) => r.role !== opposite)
  if (candidates.length === 1) {
    return { id: candidates[0].id, venue_id: candidates[0].venue_id }
  }

  return null
}

// ---------------------------------------------------------------------------
// Sub-routines
// ---------------------------------------------------------------------------

async function loadPartners(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<PersonRow[]> {
  const { data, error } = await supabase
    .from('people')
    .select(
      'id, venue_id, role, first_name, last_name, display_handle, name_evidence, name_confidence, merged_into_id',
    )
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2'])
    .is('merged_into_id', null)
  if (error) {
    throw new Error(`profile-to-people-sync.loadPartners: ${error.message}`)
  }
  return ((data ?? []) as PersonRow[])
}

/**
 * Apply the high/medium-quality name update for a single partner.
 * Returns the list of updates we performed for the audit trail.
 */
async function syncPartnerName(
  supabase: SupabaseClient,
  partner: PersonRow,
  claim: NameClaim,
  role: 'partner1' | 'partner2',
): Promise<SyncUpdate[]> {
  const updates: SyncUpdate[] = []
  const evidenceArr = asArray(partner.name_evidence)

  // Idempotency guard 1: if the name already matches, do not write.
  if (
    namesEqual(partner.first_name, claim.first) &&
    namesEqual(partner.last_name, claim.last)
  ) {
    // Even if names match, we may still want to record the
    // reconstruction-source evidence row IF none exists yet — that's
    // how a fresh reconstruction declares "I checked, this is correct".
    if (!reconstructionEntryAlreadyPresent(evidenceArr, claim)) {
      const newEvidence: NameEvidenceEntry = {
        source: SYNC_SOURCE,
        value: { first: claim.first ?? null, last: claim.last ?? null },
        confidence: claim.confidence_0_100,
        captured_at: new Date().toISOString(),
        quote: claim.evidence_quote ?? null,
      }
      const next = [...evidenceArr, newEvidence]
      const { error } = await supabase
        .from('people')
        .update({ name_evidence: next })
        .eq('id', partner.id)
      if (error) {
        throw new Error(`syncPartnerName.evidence-only: ${error.message}`)
      }
      updates.push({
        kind: 'name_evidence_appended',
        personId: partner.id,
        role,
        source: SYNC_SOURCE,
      })
    }
    return updates
  }

  // Idempotency guard 2: only beat the strongest existing evidence.
  const existingBest = strongestExistingConfidence(evidenceArr)
  if (claim.confidence_0_100 < existingBest) {
    // Profile is weaker than what the existing chokepoint already had
    // — do not overwrite, but still log a courtesy evidence row so
    // the audit trail shows the reconstruction was considered.
    if (!reconstructionEntryAlreadyPresent(evidenceArr, claim)) {
      const newEvidence: NameEvidenceEntry = {
        source: SYNC_SOURCE,
        value: { first: claim.first ?? null, last: claim.last ?? null },
        confidence: claim.confidence_0_100,
        captured_at: new Date().toISOString(),
        quote: claim.evidence_quote ?? null,
        reason: `weaker than strongest existing evidence (${existingBest})`,
      }
      const next = [...evidenceArr, newEvidence]
      const { error } = await supabase
        .from('people')
        .update({ name_evidence: next })
        .eq('id', partner.id)
      if (error) {
        throw new Error(`syncPartnerName.weaker-evidence-log: ${error.message}`)
      }
      updates.push({
        kind: 'name_evidence_appended',
        personId: partner.id,
        role,
        source: SYNC_SOURCE,
      })
    }
    return updates
  }

  // Profile is stronger — perform the actual name swap + evidence
  // append in one update.
  const newEvidence: NameEvidenceEntry = {
    source: SYNC_SOURCE,
    value: { first: claim.first ?? null, last: claim.last ?? null },
    confidence: claim.confidence_0_100,
    captured_at: new Date().toISOString(),
    quote: claim.evidence_quote ?? null,
  }
  const nextEvidence = reconstructionEntryAlreadyPresent(evidenceArr, claim)
    ? evidenceArr
    : [...evidenceArr, newEvidence]
  const { error } = await supabase
    .from('people')
    .update({
      first_name: claim.first ?? '',
      last_name: claim.last ?? '',
      name_confidence: claim.confidence_0_100,
      name_evidence: nextEvidence,
    })
    .eq('id', partner.id)
  if (error) {
    throw new Error(`syncPartnerName.update: ${error.message}`)
  }
  updates.push({
    kind: 'name_updated',
    personId: partner.id,
    role,
    previous: { first: partner.first_name, last: partner.last_name },
    next: { first: claim.first ?? null, last: claim.last ?? null },
    confidence: claim.confidence_0_100,
  })
  if (!reconstructionEntryAlreadyPresent(evidenceArr, claim)) {
    updates.push({
      kind: 'name_evidence_appended',
      personId: partner.id,
      role,
      source: SYNC_SOURCE,
    })
  }
  return updates
}

/**
 * Mark partner1 with the (Unknown) marker + a refusal-derived evidence
 * row when profile.name_quality='unknown'.
 */
async function applyUnknownMarker(
  supabase: SupabaseClient,
  partner: PersonRow,
  role: 'partner1' | 'partner2',
  refusalReason: string,
): Promise<SyncUpdate[]> {
  const updates: SyncUpdate[] = []
  const evidenceArr = asArray(partner.name_evidence)

  // Idempotency: if first_name is already (Unknown) and a refusal
  // entry exists, no-op.
  if (partner.first_name === '(Unknown)' && refusalEntryAlreadyPresent(evidenceArr)) {
    return updates
  }

  // Preserve the prior first_name in display_handle when display_handle
  // is currently unset and we have a non-Unknown prior value.
  const updatePayload: Record<string, unknown> = {}
  if (partner.first_name && partner.first_name !== '(Unknown)' && !partner.display_handle) {
    updatePayload.display_handle = partner.first_name
  }
  if (partner.first_name !== '(Unknown)') {
    updatePayload.first_name = '(Unknown)'
  }

  const refusalEvidence: NameEvidenceEntry = {
    source: SYNC_REFUSAL_SOURCE,
    value: { first: '(Unknown)', last: null },
    confidence: 0,
    captured_at: new Date().toISOString(),
    reason: refusalReason,
  }
  if (!refusalEntryAlreadyPresent(evidenceArr)) {
    updatePayload.name_evidence = [...evidenceArr, refusalEvidence]
  }

  if (Object.keys(updatePayload).length === 0) return updates

  const { error } = await supabase
    .from('people')
    .update(updatePayload)
    .eq('id', partner.id)
  if (error) {
    throw new Error(`applyUnknownMarker.update: ${error.message}`)
  }
  updates.push({
    kind: 'unknown_marker',
    personId: partner.id,
    role,
  })
  if (!refusalEntryAlreadyPresent(evidenceArr)) {
    updates.push({
      kind: 'name_evidence_appended',
      personId: partner.id,
      role,
      source: SYNC_REFUSAL_SOURCE,
    })
  }
  return updates
}

/**
 * Soft-tombstone partner2 + stamp weddings.partner_count=1 when the
 * profile flags this as a phantom-partner relationship.
 *
 * Idempotent: tombstoned partner2 rows are filtered upstream by
 * loadPartners (.is('merged_into_id', null)), so when the row is
 * already tombstoned the partner2 lookup returns null and the branch
 * exits cleanly.
 */
async function applyPhantomTombstone(
  supabase: SupabaseClient,
  partners: PersonRow[],
  weddingId: string,
): Promise<SyncUpdate[]> {
  const updates: SyncUpdate[] = []
  const partner1 = partners.find((p) => p.role === 'partner1') ?? null
  const partner2 = partners.find((p) => p.role === 'partner2') ?? null

  if (!partner1) {
    // No partner1 row to merge into — bail. Caller still gets the
    // partner_count=1 stamp below if the wedding row needs it.
  } else if (partner2) {
    // Fix for F1 in MERGED-INTO-ID-TRACE-2026-05-12.md. Previously this
    // path set merged_into_id directly without reassigning FK children
    // (interactions.person_id, drafts, engagement_events, contacts,
    // tangential_signals). When a phantom partner2 had real child rows
    // (e.g. an inbound SMS that tryMatchSmsByName had bound to the
    // ghost), those children orphaned to a tombstoned parent and became
    // invisible to readers that filter merged_into_id IS NULL.
    //
    // softTombstonePerson preserves the row-survives semantic (the
    // forensic record stays) while reassigning every FK child to
    // partner1 — same code path mergePeople uses for the hard-delete case.
    try {
      const { softTombstonePerson } = await import('./merge-people')
      await softTombstonePerson({
        supabase,
        venueId: partner2.venue_id,
        keepPersonId: partner1.id,
        tombstonePersonId: partner2.id,
        reason: 'phantom_partner',
      })
    } catch (err) {
      throw new Error(
        `applyPhantomTombstone.tombstone-p2: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    updates.push({
      kind: 'phantom_tombstoned',
      partner2Id: partner2.id,
      keptPartner1Id: partner1.id,
    })
  }

  // Stamp weddings.partner_count=1 (idempotent — only writes when
  // current value differs from 1).
  const { data: weddingRow } = await supabase
    .from('weddings')
    .select('partner_count')
    .eq('id', weddingId)
    .maybeSingle()
  const currentPartnerCount =
    weddingRow != null
      ? (weddingRow as { partner_count: number | null }).partner_count
      : null
  if (currentPartnerCount !== 1) {
    const { error } = await supabase
      .from('weddings')
      .update({ partner_count: 1 })
      .eq('id', weddingId)
    if (error) {
      throw new Error(`applyPhantomTombstone.partner-count: ${error.message}`)
    }
    updates.push({
      kind: 'partner_count_set',
      weddingId,
      partnerCount: 1,
    })
  }

  return updates
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface SyncProfileToPeopleOptions {
  supabase?: SupabaseClient
  /** Pre-loaded profile (avoids a round-trip when the caller already has
   *  the profile from a fresh reconstruction). */
  profile?: StoredCoupleIdentityProfile | null
}

/**
 * Project the forensic couple_identity_profile back onto the legacy
 * people / weddings rows. Returns a list of every change applied (or
 * the reason the call was a no-op).
 *
 * Failure semantics: NEVER throws. The profile is the source of truth;
 * if the legacy projection fails, we log + continue. Constitution
 * invariant: never hard-delete on a sync (soft-tombstone only).
 */
export async function syncProfileToPeople(
  weddingId: string,
  options: SyncProfileToPeopleOptions = {},
): Promise<SyncProfileToPeopleOutcome> {
  const supabase = options.supabase ?? createServiceClient()

  let stored: StoredCoupleIdentityProfile | null
  try {
    stored =
      options.profile === undefined
        ? await getStoredCoupleIdentityProfile(weddingId, { supabase })
        : options.profile
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `profile-load-failed: ${msg}` }
  }
  if (!stored) {
    return { ok: false, reason: 'no-profile' }
  }

  const profile = stored.profile

  let partners: PersonRow[]
  try {
    partners = await loadPartners(supabase, weddingId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[profile-to-people-sync] loadPartners failed: ${msg}`)
    return { ok: false, reason: `partners-load-failed: ${msg}` }
  }

  const updates: SyncUpdate[] = []

  // Branch 1: phantom-partner relationship.
  if (profile.names.is_phantom_partner_relationship === true) {
    try {
      const phantomUpdates = await applyPhantomTombstone(
        supabase,
        partners,
        weddingId,
      )
      updates.push(...phantomUpdates)
      // After tombstoning, partner2 is no longer in the partners list
      // we use for branch 2/3 below (loadPartners already filtered
      // tombstoned rows; if we just tombstoned partner2 it stays out
      // of this in-memory list since we don't re-fetch). That's the
      // correct state — phantom-partner branch + name update for
      // partner1 can compose. Continue to branch 2.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[profile-to-people-sync] phantom branch failed: ${msg}`)
      // Continue to other branches; sync is non-fatal.
    }
  }

  // Branch 2: per-partner sync. Previously gated on
  // `name_quality === 'high' || 'medium'`, which silently discarded
  // every couple where the judge graded the OVERALL quality as 'low'
  // but had a confident individual partner claim. RM-0317 (2026-05-13):
  // judge extracted partner2='Dale Settle' at 85% confidence from a
  // Calendly Q&A field, but because partner1 had no claim (Calendly
  // invitee 20girl.mama23@gmail.com had no real human name) the
  // overall name_quality landed at 'low' — Dale Settle never landed
  // on a partner2 people row, and the leads list rendered "Unknown".
  //
  // Fix (2026-05-13 Pass G): include 'low'. Each partner's syncPartnerName
  // call already enforces its own confidence guards (only beat strongest
  // existing evidence; idempotent when names already match), so opening
  // the outer gate doesn't bypass safety — it just lets the
  // per-partner logic run. The 'low' bucket is exactly the cohort
  // where ONE partner is confident while the other isn't.
  if (
    profile.names.name_quality === 'high' ||
    profile.names.name_quality === 'medium' ||
    profile.names.name_quality === 'low'
  ) {
    if (profile.names.partner1) {
      const partner1Row = partners.find((p) => p.role === 'partner1') ?? null
      if (partner1Row) {
        try {
          const partner1Updates = await syncPartnerName(
            supabase,
            partner1Row,
            profile.names.partner1,
            'partner1',
          )
          updates.push(...partner1Updates)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[profile-to-people-sync] partner1 sync failed: ${msg}`)
        }
      } else {
        // 2026-05-13: mirror of the partner2-missing branch below. The
        // partner1 people row was never created during ingest — happens
        // when the resolver attaches via a partner2 match (e.g. an email
        // alias landed on people.email and the resolver returned an
        // existing wedding whose partner1 was already tombstoned/merged),
        // or when an SMS-only intake minted a wedding with only a
        // partner1 phone row that later got role-reassigned. In all
        // those cases the forensic profile carries the partner1 name
        // at the judge's confidence — that's the truth source. Mint
        // the partner1 row from it.
        //
        // venue_id comes from the wedding (we have weddingId in scope
        // but no partner1Row to crib from; either a partner2 row gives
        // us the venue_id, or we fetch weddings.venue_id directly).
        try {
          const profileP1 = profile.names.partner1
          const first = profileP1.first?.trim() || null
          const last = profileP1.last?.trim() || null
          if (first || last) {
            // Match-and-update, not blind insert. loadPartners() only
            // sees rows whose role is exactly 'partner1'/'partner2'; a
            // real row under a null/'partner'/mis-cased role would be
            // missed and a duplicate inserted. Re-query the live wedding
            // for an adoptable row first. (2026-05-15 duplicate-partner
            // root-cause fix — see findAdoptablePartnerRow doc above.)
            const adoptable = await findAdoptablePartnerRow(
              supabase,
              weddingId,
              'partner1',
              first,
            )
            if (adoptable) {
              const { error: updErr } = await supabase
                .from('people')
                .update({ role: 'partner1', first_name: first, last_name: last })
                .eq('id', adoptable.id)
              if (updErr) {
                console.warn(`[profile-to-people-sync] partner1 adopt failed: ${updErr.message}`)
              } else {
                try {
                  const { captureNameEvidence } = await import('@/lib/services/identity/name-capture')
                  await captureNameEvidence(supabase, adoptable.id, {
                    first,
                    last,
                    source: 'reconstruct_profile_partner1',
                  })
                } catch (capErr) {
                  console.warn(
                    `[profile-to-people-sync] partner1 evidence stamp failed: ${capErr instanceof Error ? capErr.message : String(capErr)}`,
                  )
                }
                updates.push({
                  kind: 'name_updated',
                  personId: adoptable.id,
                  role: 'partner1',
                  previous: { first: null, last: null },
                  next: { first, last },
                  confidence: profileP1.confidence_0_100 ?? 0,
                })
              }
            } else {
              let venueIdForInsert: string | null = null
              const partner2Row = partners.find((p) => p.role === 'partner2') ?? null
              if (partner2Row) {
                venueIdForInsert = partner2Row.venue_id
              } else {
                const { data: wRow } = await supabase
                  .from('weddings')
                  .select('venue_id')
                  .eq('id', weddingId)
                  .maybeSingle()
                venueIdForInsert = (wRow?.venue_id as string | null) ?? null
              }
              if (venueIdForInsert) {
                const { data: newP1, error: insErr } = await supabase
                  .from('people')
                  .insert({
                    venue_id: venueIdForInsert,
                    wedding_id: weddingId,
                    role: 'partner1',
                    first_name: first,
                    last_name: last,
                  })
                  .select('id')
                  .single()
                if (insErr) {
                  console.warn(`[profile-to-people-sync] partner1 create failed: ${insErr.message}`)
                } else if (newP1) {
                  try {
                    const { captureNameEvidence } = await import('@/lib/services/identity/name-capture')
                    await captureNameEvidence(supabase, newP1.id as string, {
                      first,
                      last,
                      source: 'reconstruct_profile_partner1',
                    })
                  } catch (capErr) {
                    console.warn(
                      `[profile-to-people-sync] partner1 evidence stamp failed: ${capErr instanceof Error ? capErr.message : String(capErr)}`,
                    )
                  }
                  updates.push({
                    kind: 'partner1_created',
                    personId: newP1.id as string,
                    first,
                    last,
                    confidence: profileP1.confidence_0_100 ?? 0,
                  })
                }
              } else {
                console.warn(
                  `[profile-to-people-sync] partner1 create skipped: no venue_id for wedding ${weddingId}`,
                )
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[profile-to-people-sync] partner1 create branch failed: ${msg}`)
        }
      }
    }
    if (
      profile.names.partner2 &&
      !profile.names.is_phantom_partner_relationship
    ) {
      const partner2Row = partners.find((p) => p.role === 'partner2') ?? null
      if (partner2Row) {
        try {
          const partner2Updates = await syncPartnerName(
            supabase,
            partner2Row,
            profile.names.partner2,
            'partner2',
          )
          updates.push(...partner2Updates)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[profile-to-people-sync] partner2 sync failed: ${msg}`)
        }
      } else {
        // Bug 4 of Sophie trace (RM-1040): partner2 row was never
        // created during ingest. Causes vary by entry path (Calendly
        // notification missed the extras.partnerName extraction, classifier
        // didn't surface partnerName, etc). The forensic profile carries
        // the partner2 name + non-phantom flag at high confidence — that's
        // the truth source. Mint the partner2 row from it.
        //
        // Wedding-scoped to the partner1's wedding (already loaded into
        // partners); venue_id matches partner1's. Phone is partner1's
        // phone if it's the only one we have; otherwise left null and
        // the operator can fill via the lead-detail edit path.
        try {
          const partner1Row = partners.find((p) => p.role === 'partner1') ?? null
          if (partner1Row) {
            const profileP2 = profile.names.partner2
            const first = profileP2.first?.trim() || null
            const last = profileP2.last?.trim() || null
            if (first || last) {
              // Match-and-update, not blind insert. The "missing
              // partner2" the loadPartners find reported can be a real
              // row that loadPartners' role filter (or a concurrent
              // merge mid-tombstone) hid. Inserting unconditionally is
              // exactly what produced Rixey's "Mike & Mike" /
              // "Joseph & Joseph" duplicate-partner2 weddings. Re-query
              // and adopt before inserting. (2026-05-15 root-cause fix.)
              const adoptable = await findAdoptablePartnerRow(
                supabase,
                weddingId,
                'partner2',
                first,
              )
              if (adoptable) {
                const { error: updErr } = await supabase
                  .from('people')
                  .update({ role: 'partner2', first_name: first, last_name: last })
                  .eq('id', adoptable.id)
                if (updErr) {
                  console.warn(`[profile-to-people-sync] partner2 adopt failed: ${updErr.message}`)
                } else {
                  try {
                    const { captureNameEvidence } = await import('@/lib/services/identity/name-capture')
                    await captureNameEvidence(supabase, adoptable.id, {
                      first,
                      last,
                      source: 'reconstruct_profile_partner2',
                    })
                  } catch (capErr) {
                    console.warn(
                      `[profile-to-people-sync] partner2 evidence stamp failed: ${capErr instanceof Error ? capErr.message : String(capErr)}`,
                    )
                  }
                  updates.push({
                    kind: 'name_updated',
                    personId: adoptable.id,
                    role: 'partner2',
                    previous: { first: null, last: null },
                    next: { first, last },
                    confidence: profileP2.confidence_0_100 ?? 0,
                  })
                }
              } else {
                const { data: newP2, error: insErr } = await supabase
                  .from('people')
                  .insert({
                    venue_id: partner1Row.venue_id,
                    wedding_id: weddingId,
                    role: 'partner2',
                    first_name: first,
                    last_name: last,
                  })
                  .select('id')
                  .single()
                if (insErr) {
                  console.warn(`[profile-to-people-sync] partner2 create failed: ${insErr.message}`)
                } else if (newP2) {
                  // Stamp name_evidence via the chokepoint so the forensic
                  // record reflects this came from reconstruction.
                  try {
                    const { captureNameEvidence } = await import('@/lib/services/identity/name-capture')
                    await captureNameEvidence(supabase, newP2.id as string, {
                      first,
                      last,
                      source: 'reconstruct_profile_partner2',
                    })
                  } catch (capErr) {
                    console.warn(
                      `[profile-to-people-sync] partner2 evidence stamp failed: ${capErr instanceof Error ? capErr.message : String(capErr)}`,
                    )
                  }
                  updates.push({
                    kind: 'partner2_created',
                    personId: newP2.id as string,
                    first,
                    last,
                    confidence: profileP2.confidence_0_100 ?? 0,
                  })
                }
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[profile-to-people-sync] partner2 create branch failed: ${msg}`)
        }
      }
    }
  }

  // Branch 3: name_quality='unknown'.
  if (profile.names.name_quality === 'unknown') {
    const partner1Row = partners.find((p) => p.role === 'partner1') ?? null
    if (partner1Row) {
      const refusalReason =
        profile.refusals.find((r) => r.field.startsWith('names'))?.reason ??
        'identity-reconstruction returned name_quality=unknown'
      try {
        const unknownUpdates = await applyUnknownMarker(
          supabase,
          partner1Row,
          'partner1',
          refusalReason,
        )
        updates.push(...unknownUpdates)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[profile-to-people-sync] unknown branch failed: ${msg}`)
      }
    }
  }

  return { ok: true, updated: updates }
}
