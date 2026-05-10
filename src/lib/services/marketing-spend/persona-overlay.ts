/**
 * Wave 6A — persona overlay on attribution_events.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 6 closes the loop: persona × channel
 *     × revenue answers "which spend acquired this archetype?")
 *   - bloom-wave4-5-6-master-plan.md (6A: persona overlay extends Phase
 *     B's attribution_events without rebuilding it)
 *   - bloom-phase-b-decisions.md (attribution_events is the source of
 *     truth for first-touch — Wave 6A only ADDS the persona snapshot
 *     column, never modifies existing semantics)
 *
 * What this module does
 * ---------------------
 * For a given attribution_events row, look up the wedding's
 * couple_intel row and snapshot persona_label + persona_confidence
 * into attribution_events.persona_overlay (jsonb). Idempotent — re-
 * running just refreshes the snapshot to the latest intel.
 *
 * Why a snapshot, not a runtime join
 * ----------------------------------
 * Wave 6B's rollup queries are GROUP BY persona × channel × month.
 * Joining attribution_events → weddings → couple_intel at runtime is
 * three joins per row × thousands of rows × dozens of pages = slow.
 * Snapshotting at attach time means 6B's rollup is a single GROUP BY
 * on attribution_events with a partial index on (persona_overlay->>
 * 'persona_label', source_platform). See migration 263 for the
 * supporting index.
 *
 * Trigger hook
 * ------------
 * When couple_intel is upserted (Wave 5A's deriveCoupleIntel completes),
 * the wedding's attribution_events should have their persona_overlay
 * refreshed. To stay inside Wave 6A's file zone (the master plan
 * forbids touching per-couple-derive.ts during parallel-stream runs),
 * we expose enqueuePersonaOverlayRefresh() here and add a TODO comment
 * to wire it from per-couple-derive.ts after parallel waves merge.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonaOverlay {
  persona_label: string
  persona_confidence: number
  derived_at: string
  couple_intel_id: string | null
}

export interface AttachPersonaResult {
  ok: true
  attributionEventId: string
  attached: boolean
  reason?: string
  overlay?: PersonaOverlay
}

export interface AttachPersonaToVenueResult {
  ok: true
  venueId: string
  processed: number
  attached: number
  skipped: number
  errors: number
}

// ---------------------------------------------------------------------------
// Internal: fetch persona snapshot from couple_intel
// ---------------------------------------------------------------------------

interface CoupleIntelSnapshotRow {
  wedding_id: string
  intel: { persona?: { label?: string; confidence_0_100?: number } } | null
  persona_label: string | null
  last_derived_at: string
}

async function fetchPersonaSnapshot(
  weddingId: string,
  supabase: SupabaseClient,
): Promise<{
  personaLabel: string
  personaConfidence: number
  derivedAt: string
  // couple_intel uses wedding_id as primary key, so the "id" of the
  // couple_intel record is the wedding_id itself. We expose it as
  // couple_intel_id for forward-compat if the table ever gains a
  // separate uuid PK.
  coupleIntelId: string | null
} | null> {
  const { data, error } = await supabase
    .from('couple_intel')
    .select('wedding_id, intel, persona_label, last_derived_at')
    .eq('wedding_id', weddingId)
    .maybeSingle()
  if (error) {
    console.warn('[persona-overlay] fetchPersonaSnapshot failed', {
      weddingId,
      error: error.message,
    })
    return null
  }
  if (!data) return null
  const row = data as CoupleIntelSnapshotRow

  // Prefer the hoisted persona_label column (Wave 5A normalised form).
  // Fall back to the jsonb path so an older row with persona only in
  // intel still attaches.
  const label = row.persona_label ?? row.intel?.persona?.label ?? null
  if (!label || typeof label !== 'string' || !label.trim()) return null

  const confRaw = row.intel?.persona?.confidence_0_100
  const confidence =
    typeof confRaw === 'number' && Number.isFinite(confRaw)
      ? Math.max(0, Math.min(100, Math.round(confRaw)))
      : 0

  return {
    personaLabel: label.trim(),
    personaConfidence: confidence,
    derivedAt: row.last_derived_at,
    coupleIntelId: row.wedding_id,
  }
}

// ---------------------------------------------------------------------------
// Public: attach persona to a single attribution_events row
// ---------------------------------------------------------------------------

export async function attachPersonaToAttributionEvent(input: {
  attributionEventId: string
  supabase?: SupabaseClient
}): Promise<AttachPersonaResult> {
  const supabase = input.supabase ?? createServiceClient()

  // Pull the attribution row + its wedding linkage.
  const { data: row, error } = await supabase
    .from('attribution_events')
    .select('id, wedding_id, persona_overlay, reverted_at')
    .eq('id', input.attributionEventId)
    .maybeSingle()
  if (error) {
    return {
      ok: true,
      attributionEventId: input.attributionEventId,
      attached: false,
      reason: `lookup_failed: ${error.message}`,
    }
  }
  if (!row) {
    return {
      ok: true,
      attributionEventId: input.attributionEventId,
      attached: false,
      reason: 'not_found',
    }
  }

  const r = row as {
    id: string
    wedding_id: string
    persona_overlay: PersonaOverlay | null
    reverted_at: string | null
  }
  if (r.reverted_at) {
    return {
      ok: true,
      attributionEventId: r.id,
      attached: false,
      reason: 'reverted',
    }
  }

  const snapshot = await fetchPersonaSnapshot(r.wedding_id, supabase)
  if (!snapshot) {
    return {
      ok: true,
      attributionEventId: r.id,
      attached: false,
      reason: 'no_couple_intel',
    }
  }

  const overlay: PersonaOverlay = {
    persona_label: snapshot.personaLabel,
    persona_confidence: snapshot.personaConfidence,
    derived_at: snapshot.derivedAt,
    couple_intel_id: snapshot.coupleIntelId,
  }

  // Idempotent re-attach: if the existing overlay matches, skip the
  // write to avoid trigger churn.
  if (
    r.persona_overlay &&
    r.persona_overlay.persona_label === overlay.persona_label &&
    r.persona_overlay.persona_confidence === overlay.persona_confidence &&
    r.persona_overlay.derived_at === overlay.derived_at
  ) {
    return {
      ok: true,
      attributionEventId: r.id,
      attached: false,
      reason: 'unchanged',
      overlay,
    }
  }

  const { error: upErr } = await supabase
    .from('attribution_events')
    .update({ persona_overlay: overlay })
    .eq('id', r.id)
  if (upErr) {
    return {
      ok: true,
      attributionEventId: r.id,
      attached: false,
      reason: `update_failed: ${upErr.message}`,
    }
  }

  return {
    ok: true,
    attributionEventId: r.id,
    attached: true,
    overlay,
  }
}

// ---------------------------------------------------------------------------
// Public: attach persona to every attribution_events row in a wedding
// ---------------------------------------------------------------------------

export async function attachPersonaToWedding(input: {
  weddingId: string
  supabase?: SupabaseClient
}): Promise<{
  ok: true
  weddingId: string
  processed: number
  attached: number
  skipped: number
}> {
  const supabase = input.supabase ?? createServiceClient()
  const { data, error } = await supabase
    .from('attribution_events')
    .select('id')
    .eq('wedding_id', input.weddingId)
    .is('reverted_at', null)
  if (error) {
    return {
      ok: true,
      weddingId: input.weddingId,
      processed: 0,
      attached: 0,
      skipped: 0,
    }
  }
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  let attached = 0
  let skipped = 0
  for (const id of ids) {
    const r = await attachPersonaToAttributionEvent({
      attributionEventId: id,
      supabase,
    })
    if (r.attached) attached += 1
    else skipped += 1
  }
  return {
    ok: true,
    weddingId: input.weddingId,
    processed: ids.length,
    attached,
    skipped,
  }
}

// ---------------------------------------------------------------------------
// Public: bulk backfill — attach persona to every attribution_events
// row in a venue. Used by the persona-backfill admin endpoint.
// ---------------------------------------------------------------------------

export async function attachPersonaToVenue(input: {
  venueId: string
  supabase?: SupabaseClient
  /** Cap per call so a 100k-row backfill can be paginated. */
  limit?: number
}): Promise<AttachPersonaToVenueResult> {
  const supabase = input.supabase ?? createServiceClient()
  const limit = Math.min(Math.max(input.limit ?? 5000, 1), 50_000)

  const { data, error } = await supabase
    .from('attribution_events')
    .select('id, wedding_id')
    .eq('venue_id', input.venueId)
    .is('reverted_at', null)
    .limit(limit)
  if (error) {
    console.warn('[persona-overlay] attachPersonaToVenue lookup failed', {
      venueId: input.venueId,
      error: error.message,
    })
    return {
      ok: true,
      venueId: input.venueId,
      processed: 0,
      attached: 0,
      skipped: 0,
      errors: 1,
    }
  }

  const rows = (data ?? []) as Array<{ id: string; wedding_id: string }>
  let attached = 0
  let skipped = 0
  let errors = 0

  for (const row of rows) {
    try {
      const r = await attachPersonaToAttributionEvent({
        attributionEventId: row.id,
        supabase,
      })
      if (r.attached) attached += 1
      else skipped += 1
    } catch (err) {
      errors += 1
      console.warn('[persona-overlay] per-row attach threw', {
        attributionEventId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    ok: true,
    venueId: input.venueId,
    processed: rows.length,
    attached,
    skipped,
    errors,
  }
}

// ---------------------------------------------------------------------------
// Trigger hook helper (fire-and-forget from per-couple-derive.ts)
// ---------------------------------------------------------------------------
//
// TODO Wave 6A reconciliation: wire enqueuePersonaOverlayRefresh()
// into src/lib/services/intel/per-couple-derive.ts as a fire-and-
// forget call AFTER the couple_intel upsert succeeds. Cannot do that
// during parallel-stream Wave 6A run because per-couple-derive.ts is
// being edited by other agents — see feedback_parallel_stream_safety.md.
// Once Wave 6A merges with Waves 5B + 7B, add:
//
//   import { enqueuePersonaOverlayRefresh } from
//     '@/lib/services/marketing-spend/persona-overlay'
//   ...
//   // After upsert success:
//   void enqueuePersonaOverlayRefresh({ weddingId }).catch(() => {})
//
// The helper itself is sync-cheap: just delegates to attachPersonaToWedding
// without awaiting, so it can't block the parent operation.

/**
 * Fire-and-forget hook. Refreshes persona_overlay for every live
 * attribution_events row of a wedding. Designed to be called from
 * Wave 5A's deriveCoupleIntel after the couple_intel upsert completes.
 * Never throws — logs and returns on error.
 */
export async function enqueuePersonaOverlayRefresh(input: {
  weddingId: string
  supabase?: SupabaseClient
}): Promise<void> {
  try {
    await attachPersonaToWedding({
      weddingId: input.weddingId,
      supabase: input.supabase,
    })
  } catch (err) {
    console.warn('[persona-overlay] enqueuePersonaOverlayRefresh threw', {
      weddingId: input.weddingId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
