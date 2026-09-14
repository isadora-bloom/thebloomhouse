/**
 * Coordinator manual name override.
 *
 * Moved out of `src/app/api/intel/name-evidence/[weddingId]/route.ts`
 * in W64. The route is auth, scope and one call; the four-step write
 * lives here, where it can be read in one place and tested without a
 * request. Nothing about the sequence changed.
 *
 * The sequence, and why each step is there:
 *   1. `captureNameEvidence` — the chokepoint. `manual_override` sits at
 *      confidence 100, the top of the ladder, so the picker projects the
 *      typed values onto first_name / last_name / name_confidence and
 *      stamps the evidence row's shape. Design doc §4b: manual override
 *      is law, and the picker is how that law is enforced.
 *   2. Stamp `name_picked_source` and pin the row just appended. Both
 *      are outside the chokepoint's contract but inside the panel's:
 *      the override label, and pinned-to-the-top ordering.
 *   3. Push the override into `couple_identity_profile.profile.names`
 *      and set the per-partner operator lock, so the next Wave-4
 *      reconstruction cannot drift the forensic record away from what
 *      the operator confirmed. Best effort: the person-side write has
 *      already landed, and this is the consistency layer.
 *   4. Fire the identity-discovery cascade. A coordinator-confirmed name
 *      is the strongest identity binding there is, so anonymous
 *      storefront signals that match it now have evidence to bind
 *      against. Fire and forget; never block the operator.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { captureNameEvidence } from '@/lib/services/identity/name-capture'

interface NameEvidenceEntry {
  source?: string
  confidence?: number | null
  pinned?: boolean
}

export interface NameOverrideInput {
  supabase: SupabaseClient
  venueId: string
  /** The wedding the person rows hang off. Callers resolve it from the
   *  couple, not from a `weddings` read. */
  weddingId: string
  personId: string
  first: string | null
  last: string | null
  userId: string | null
}

export type NameOverrideResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export async function applyNameOverride(
  input: NameOverrideInput,
): Promise<NameOverrideResult> {
  const { supabase, venueId, weddingId, personId, first, last, userId } = input

  // The person must sit on this wedding, in this venue. The caller has
  // already proved it owns the couple; this proves the person belongs to
  // it, so a valid couple id cannot be used to edit someone else's row.
  const { data: person, error: pErr } = await supabase
    .from('people')
    .select('id, wedding_id, venue_id, name_evidence')
    .eq('id', personId)
    .maybeSingle()
  if (pErr) {
    const msg = (pErr as { message?: string }).message ?? ''
    if (/column .* does not exist/i.test(msg)) {
      return {
        ok: false,
        status: 503,
        error: 'name_evidence column not deployed yet — run migration 255',
      }
    }
    return { ok: false, status: 500, error: msg || 'person lookup failed' }
  }
  if (!person) return { ok: false, status: 404, error: 'person not found' }
  if (person.venue_id !== venueId || person.wedding_id !== weddingId) {
    return { ok: false, status: 403, error: 'person not in scope' }
  }

  // 1. Through the chokepoint.
  await captureNameEvidence(supabase, personId, {
    first: first || null,
    last: last || null,
    source: 'manual_override',
  })

  // 2. Stamp the picked source and pin the row just appended. The LAST
  //    matching row wins so a re-override moves the pin forwards.
  const reread = await supabase
    .from('people')
    .select('name_evidence')
    .eq('id', personId)
    .maybeSingle()
  const updatedEvidence: NameEvidenceEntry[] = Array.isArray(reread.data?.name_evidence)
    ? (reread.data!.name_evidence as NameEvidenceEntry[])
    : []
  let pinnedIdx = -1
  for (let i = updatedEvidence.length - 1; i >= 0; i--) {
    const e = updatedEvidence[i]
    if (e?.source === 'manual_override' && (e?.confidence ?? 0) === 100) {
      pinnedIdx = i
      break
    }
  }
  const followUp: Record<string, unknown> = { name_picked_source: 'manual_override' }
  if (pinnedIdx >= 0) {
    followUp.name_evidence = updatedEvidence.map((e, i) =>
      i === pinnedIdx ? { ...e, pinned: true } : e,
    )
  }
  const { error: updErr } = await supabase
    .from('people')
    .update(followUp)
    .eq('id', personId)
  if (updErr) return { ok: false, status: 500, error: updErr.message }

  // 3. Profile lock. Best effort — logs and continues.
  try {
    const { data: personRole } = await supabase
      .from('people')
      .select('role')
      .eq('id', personId)
      .maybeSingle()
    const role = (personRole?.role as string | null) ?? null
    if (role === 'partner1' || role === 'partner2') {
      const { data: prof } = await supabase
        .from('couple_identity_profile')
        .select('profile')
        .eq('wedding_id', weddingId)
        .maybeSingle()
      const currentProfile = (prof?.profile ?? null) as {
        names?: Record<string, unknown>
      } | null
      if (currentProfile && currentProfile.names) {
        const partnerKey = role === 'partner1' ? 'partner1' : 'partner2'
        const mergedProfile = {
          ...currentProfile,
          names: {
            ...currentProfile.names,
            [partnerKey]: {
              first: first || null,
              last: last || null,
              confidence_0_100: 100,
              evidence_quote: 'operator manual override',
            },
            // Operator confirmation is the highest signal there is, so a
            // confirmed partner1 lifts the whole record's name quality.
            ...(role === 'partner1' ? { name_quality: 'high' as const } : {}),
          },
        }
        const lockColumn =
          role === 'partner1'
            ? { partner1_locked_by_operator: true }
            : { partner2_locked_by_operator: true }
        await supabase
          .from('couple_identity_profile')
          .update({
            profile: mergedProfile,
            ...lockColumn,
            locked_at: new Date().toISOString(),
            locked_by_user_id: userId,
            updated_at: new Date().toISOString(),
          })
          .eq('wedding_id', weddingId)
      }
    }
  } catch (err) {
    console.warn(
      '[name-override] profile lock write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }

  // 4. Cascade, fire and forget.
  void (async () => {
    try {
      const { triggerIdentityCascade } = await import(
        '@/lib/services/identity/cascade-on-enrichment'
      )
      await triggerIdentityCascade({
        venueId,
        weddingId,
        supabase,
        reason: 'name_evidence_override',
      })
    } catch (err) {
      console.warn(
        '[name-override] cascade fire-and-forget threw:',
        err instanceof Error ? err.message : err,
      )
    }
  })()

  return { ok: true }
}
