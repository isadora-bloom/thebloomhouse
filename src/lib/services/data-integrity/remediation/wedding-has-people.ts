/**
 * Wave 9 remediation — ghost weddings (wedding_has_people invariant).
 *
 * What this fixes
 * ---------------
 * A "ghost wedding" is a weddings row with zero live (non-tombstoned)
 * people rows. Invisible on the leads UI, breaks contact resolution,
 * inflates the leads-count without showing up anywhere a coordinator can
 * touch it.
 *
 * Three-tier strategy (matches Wave 4 Phase 3 + bloom-constitution
 * doctrine):
 *
 *   Tier 1 — couple_identity_profile exists for this wedding:
 *     The forensic profile is the source of truth. Call
 *     syncProfileToPeople to project partner1 / partner2 back onto the
 *     people table from the LLM-judged identity. Idempotent.
 *
 *   Tier 2 — no profile, but the wedding has inbound interactions with
 *     a from_email + from_name:
 *     Pull the most-recent inbound interaction. Synthesise a partner1
 *     person row from that from_email + from_name. Lets the wedding
 *     appear on the leads UI; downstream reconstruction can refine
 *     names later.
 *
 *   Tier 3 — no profile AND no inbound interactions:
 *     This is a true orphan. The wedding row exists but there's no
 *     signal that ties it to a person. Per Constitution, NEVER hard-
 *     delete. Tombstone via merged_into_id = id (self-merge marker),
 *     stamp notes with reason. Coordinator can review tombstoned rows
 *     on /admin/identity.
 *
 * Idempotency
 * -----------
 * Each tier re-checks the violation predicate (people-count == 0) before
 * writing. Re-running on a cleaned wedding is a no-op. Tier 1 delegates
 * to syncProfileToPeople, which is itself idempotent (see
 * profile-to-people-sync.ts header). Tier 3 self-merge is no-op if
 * merged_into_id is already set.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { syncProfileToPeople } from '@/lib/services/identity/profile-to-people-sync'
import {
  makeEmptyResult,
  bumpSkip,
  pushError,
  SAMPLE_CAP,
  type RemediationCallArgs,
  type RemediationResult,
} from './types'

const INVARIANT_ID = 'wedding_has_people'

interface WeddingRow {
  id: string
  status: string | null
  source: string | null
  inquiry_date: string | null
  notes: string | null
  merged_into_id: string | null
}

interface InteractionForSynth {
  id: string
  from_email: string | null
  from_name: string | null
  timestamp: string | null
}

interface ProfileRow {
  wedding_id: string
}

interface ProfileForRevive {
  wedding_id: string
  profile: {
    names?: {
      partner1?: { first?: string | null; last?: string | null; confidence_0_100?: number; evidence_quote?: string | null } | null
      partner2?: { first?: string | null; last?: string | null; confidence_0_100?: number; evidence_quote?: string | null } | null
      name_quality?: string | null
      is_phantom_partner_relationship?: boolean | null
    }
  }
}

async function loadGhostWeddings(venueId: string): Promise<WeddingRow[]> {
  const sb = createServiceClient()
  // Pull all weddings for this venue, then filter to those with zero
  // live (non-tombstoned) people. Matches checkWeddingHasPeople in
  // data-integrity.ts (which also doesn't cap at the detector's
  // SAMPLE_LIMIT — true full scan).
  const { data: weddings, error } = await sb
    .from('weddings')
    .select('id, status, source, inquiry_date, notes, merged_into_id')
    .eq('venue_id', venueId)
    .is('merged_into_id', null) // don't touch already-tombstoned rows
  if (error) throw new Error(`loadGhostWeddings: ${error.message}`)
  const all = (weddings ?? []) as WeddingRow[]

  const ghosts: WeddingRow[] = []
  for (const w of all) {
    const { count } = await sb
      .from('people')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', w.id)
      .is('merged_into_id', null) // mirror detector — live people only
    if ((count ?? 0) === 0) ghosts.push(w)
  }
  return ghosts
}

async function loadProfilesForWeddings(weddingIds: string[]): Promise<Map<string, ProfileForRevive>> {
  if (weddingIds.length === 0) return new Map()
  const sb = createServiceClient()
  const { data, error } = await sb
    .from('couple_identity_profile')
    .select('wedding_id, profile')
    .in('wedding_id', weddingIds)
  if (error) {
    // Profile table may not exist on fresh checkouts — non-fatal,
    // treat as "no profiles available".
    console.warn(`[remediation:wedding_has_people] profile lookup failed: ${error.message}`)
    return new Map()
  }
  const out = new Map<string, ProfileForRevive>()
  for (const r of (data ?? []) as ProfileForRevive[]) {
    out.set(r.wedding_id, r)
  }
  return out
}

async function latestInboundForWedding(weddingId: string): Promise<InteractionForSynth | null> {
  const sb = createServiceClient()
  const { data } = await sb
    .from('interactions')
    .select('id, from_email, from_name, timestamp')
    .eq('wedding_id', weddingId)
    .eq('direction', 'inbound')
    .not('from_email', 'is', null)
    .order('timestamp', { ascending: false })
    .limit(1)
  const row = (data ?? [])[0] as InteractionForSynth | undefined
  return row ?? null
}

/**
 * Public entry — remediate ghost weddings on one venue.
 *
 * `mode === 'dry_run'`: detect violations + bucket them per tier, no
 * writes. Returns a preview the admin page can show as "if you apply,
 * this is what would happen".
 *
 * `mode === 'apply'`: writes per tier.
 */
export async function remediateGhostWeddings(
  { venueId, mode }: RemediationCallArgs,
): Promise<RemediationResult> {
  const result = makeEmptyResult(
    INVARIANT_ID,
    mode,
    'Tier 1: profile→people sync. Tier 2: synth partner1 from latest inbound. Tier 3: tombstone (no signal).',
  )

  let ghosts: WeddingRow[]
  try {
    ghosts = await loadGhostWeddings(venueId)
  } catch (err) {
    pushError(result, 'load_ghosts', err)
    return result
  }
  result.violationsDetected = ghosts.length

  if (ghosts.length === 0) return result

  // Sample the first SAMPLE_CAP for the audit row's "before" preview.
  result.sampleBefore = ghosts.slice(0, SAMPLE_CAP).map((w) => ({
    wedding_id: w.id,
    status: w.status,
    source: w.source,
    inquiry_date: w.inquiry_date,
  }))

  const profilesByWedding = await loadProfilesForWeddings(ghosts.map((g) => g.id))
  const sb = createServiceClient()

  let tier1 = 0
  let tier2 = 0
  let tier3 = 0

  for (const ghost of ghosts) {
    // -----------------------------------------------------------------
    // Tier 1: profile exists — revive partner rows then sync
    // -----------------------------------------------------------------
    if (profilesByWedding.has(ghost.id)) {
      if (mode === 'dry_run') {
        tier1 += 1
        continue
      }
      try {
        // Wave 9: when the wedding has zero live people but the profile
        // exists, syncProfileToPeople would no-op (it only updates
        // EXISTING partner rows). Revive a partner1 row from the
        // profile data first so the sync has something to write onto.
        const profileEntry = profilesByWedding.get(ghost.id)!
        const partner1Claim = profileEntry.profile?.names?.partner1 ?? null
        const partner2Claim = profileEntry.profile?.names?.partner2 ?? null
        const isPhantom = profileEntry.profile?.names?.is_phantom_partner_relationship === true

        // Insert partner1 — never duplicate (idempotent on wedding +
        // role + non-tombstoned).
        const { data: existing1 } = await sb
          .from('people')
          .select('id')
          .eq('wedding_id', ghost.id)
          .eq('role', 'partner1')
          .is('merged_into_id', null)
          .limit(1)
        if (!existing1 || existing1.length === 0) {
          // 2026-05-13 Pass G: NULL placeholder instead of "(Unknown)"
          // literal. Reading "(Unknown)" as the first_name string is
          // semantically wrong — it means "the couple's first name is
          // literally the word Unknown". NULL means "we don't know"
          // and lets the leads list render its own "(name unknown)"
          // UI affordance. The Wave 4 judge fills NULL once signal
          // arrives; "(Unknown)" string would block syncPartnerName's
          // namesEqual guard from ever upgrading.
          const first = (partner1Claim?.first ?? '').trim() || null
          const last = (partner1Claim?.last ?? '').trim() || null
          const { error: ins1Err } = await sb.from('people').insert({
            venue_id: venueId,
            wedding_id: ghost.id,
            role: 'partner1',
            first_name: first,
            last_name: last,
            name_confidence: partner1Claim?.confidence_0_100 ?? 50,
            name_evidence: [
              {
                source: 'wave9_ghost_remediation_tier1_revive',
                value: { first: partner1Claim?.first ?? null, last: partner1Claim?.last ?? null },
                confidence: partner1Claim?.confidence_0_100 ?? 50,
                captured_at: new Date().toISOString(),
                quote: partner1Claim?.evidence_quote ?? 'Revived from couple_identity_profile (ghost-wedding remediation)',
              },
            ],
          })
          if (ins1Err) {
            pushError(result, 'tier1_revive_partner1', ins1Err, ghost.id)
            continue
          }
        }

        // Partner2 — only when profile carries one and it's not a phantom.
        if (partner2Claim && !isPhantom) {
          const { data: existing2 } = await sb
            .from('people')
            .select('id')
            .eq('wedding_id', ghost.id)
            .eq('role', 'partner2')
            .is('merged_into_id', null)
            .limit(1)
          if (!existing2 || existing2.length === 0) {
            // 2026-05-13 Pass G: NULL not "(Unknown)" literal. Same
            // reasoning as partner1 above.
            const first2 = (partner2Claim.first ?? '').trim() || null
            const last2 = (partner2Claim.last ?? '').trim() || null
            const { error: ins2Err } = await sb.from('people').insert({
              venue_id: venueId,
              wedding_id: ghost.id,
              role: 'partner2',
              first_name: first2,
              last_name: last2,
              name_confidence: partner2Claim.confidence_0_100 ?? 50,
              name_evidence: [
                {
                  source: 'wave9_ghost_remediation_tier1_revive',
                  value: { first: partner2Claim.first ?? null, last: partner2Claim.last ?? null },
                  confidence: partner2Claim.confidence_0_100 ?? 50,
                  captured_at: new Date().toISOString(),
                  quote: partner2Claim.evidence_quote ?? 'Revived from couple_identity_profile (ghost-wedding remediation)',
                },
              ],
            })
            if (ins2Err) {
              // Non-fatal — partner1 already inserted; the wedding is
              // no longer a ghost. Track but don't roll back.
              pushError(result, 'tier1_revive_partner2', ins2Err, ghost.id)
            }
          }
        }

        // Now call sync — even when revive just inserted, the sync
        // appends a 'reconstruction' name_evidence row that's part of
        // the audit trail and may upgrade name_confidence.
        const out = await syncProfileToPeople(ghost.id, { supabase: sb })
        if (out.ok) {
          tier1 += 1
          result.violationsFixed += 1
        } else {
          // Revive succeeded but sync didn't — count as fixed since the
          // wedding has people now, but record the sync failure.
          tier1 += 1
          result.violationsFixed += 1
          pushError(result, 'tier1_sync_after_revive', new Error(out.reason), ghost.id)
        }
      } catch (err) {
        pushError(result, 'tier1_revive', err, ghost.id)
      }
      continue
    }

    // -----------------------------------------------------------------
    // Tier 2: no profile, latest inbound interaction has from_email
    // -----------------------------------------------------------------
    const inbound = await latestInboundForWedding(ghost.id)
    if (inbound && inbound.from_email) {
      if (mode === 'dry_run') {
        tier2 += 1
        continue
      }
      // Synthesise a partner1 row. Use from_name when present, otherwise
      // local-part of the email. Downstream reconstruction can upgrade.
      const rawName = (inbound.from_name ?? '').trim()
      const firstName = rawName
        ? (rawName.split(/\s+/)[0] ?? '')
        : (inbound.from_email.split('@')[0] ?? '')
      const lastName = rawName && rawName.split(/\s+/).length > 1
        ? rawName.split(/\s+/).slice(1).join(' ')
        : null
      const { error: insertErr } = await sb.from('people').insert({
        venue_id: venueId,
        wedding_id: ghost.id,
        role: 'partner1',
        // 2026-05-13 Pass G: NULL not "(Unknown)" literal — see Tier 1
        // comment. firstName here is derived from the inbound's
        // from_name or email-local-part; if neither produced a usable
        // token, NULL is the correct sentinel.
        first_name: firstName || null,
        last_name: lastName,
        email: inbound.from_email.toLowerCase(),
        name_evidence: [
          {
            source: 'wave9_ghost_remediation_tier2',
            value: { first: firstName || null, last: lastName },
            confidence: 50,
            captured_at: new Date().toISOString(),
            quote: `Synthesised from latest inbound interaction ${inbound.id} from_name=${inbound.from_name ?? '(none)'}, from_email=${inbound.from_email}`,
          },
        ],
        name_confidence: 50,
      })
      if (insertErr) {
        pushError(result, 'tier2_insert_partner1', insertErr, ghost.id)
        continue
      }
      tier2 += 1
      result.violationsFixed += 1
      continue
    }

    // -----------------------------------------------------------------
    // Tier 3: true orphan — no profile, no inbound. Tombstone.
    // -----------------------------------------------------------------
    if (mode === 'dry_run') {
      tier3 += 1
      continue
    }
    // Per Constitution, never hard-delete. Self-merge: merged_into_id
    // = wedding's own id. Stamp notes so /admin/identity surfaces the
    // reason. NOT NULL constraint on merged_into_id is the wedding's
    // own id — schema allows this (the FK is on weddings.id, and the
    // row exists).
    const reasonStamp = `[wave9_ghost_remediation] tombstoned ${new Date().toISOString().slice(0, 10)}: no profile, no inbound interactions, no people. True orphan — coordinator review.`
    const prevNotes = (ghost.notes ?? '').trim()
    const newNotes = prevNotes ? `${prevNotes}\n${reasonStamp}` : reasonStamp
    const { error: tombErr } = await sb
      .from('weddings')
      .update({
        merged_into_id: ghost.id,
        notes: newNotes,
      })
      .eq('id', ghost.id)
      .is('merged_into_id', null) // idempotent — won't re-tombstone
    if (tombErr) {
      pushError(result, 'tier3_tombstone', tombErr, ghost.id)
      continue
    }
    tier3 += 1
    result.violationsFixed += 1
  }

  // Roll dry-run counts into "fixed" projection so the admin page can
  // surface what would happen.
  if (mode === 'dry_run') {
    result.violationsFixed = tier1 + tier2 + tier3
  }

  result.fixStrategy =
    `Tier 1: profile->people sync (${tier1}). ` +
    `Tier 2: synth partner1 from inbound (${tier2}). ` +
    `Tier 3: tombstone — no signal (${tier3}).`

  // Sample after — only for apply mode. Re-scan + pull a fresh slice.
  if (mode === 'apply') {
    try {
      const after = await loadGhostWeddings(venueId)
      result.sampleAfter = after.slice(0, SAMPLE_CAP).map((w) => ({
        wedding_id: w.id,
        status: w.status,
        source: w.source,
        residual_after_remediation: true,
      }))
    } catch (err) {
      pushError(result, 'sample_after', err)
    }
  }

  return result
}
