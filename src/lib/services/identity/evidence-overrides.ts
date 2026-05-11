/**
 * Bloom House — Wave 15 evidence-overrides reader.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator override > inferred state; the
 *     forensic record respects the operator's final say)
 *   - bloom-wave4-identity-reconstruction.md (stricter filtering happens
 *     BEFORE the prompt is built; the prompt + schema are sealed)
 *
 * What this module does
 * ---------------------
 * Reads active evidence_overrides for a wedding and exposes a fast
 * predicate for the evidence loader to filter rows BEFORE they reach
 * the LLM (reconstruct.ts) or the timeline UI (build-timeline.ts).
 *
 * Single round-trip per reconstruction / timeline render. The result
 * is a per-(table, id) lookup map — O(1) per evidence check.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OverrideAction = 'dismiss' | 'unlink' | 'correct_value'

export interface EvidenceOverrideRow {
  id: string
  evidence_kind: string
  evidence_ref: {
    table?: string
    id?: string
    field_path?: string
  }
  override_action: OverrideAction
  correction_value: unknown
  reason: string | null
}

export interface EvidenceOverridesIndex {
  /** All active overrides for this wedding. */
  rows: EvidenceOverrideRow[]
  /** Fast lookup: "<table>:<id>" → override action. Includes both
   *  'dismiss' and 'unlink' (caller treats them identically for the
   *  filter purpose). Missing entries mean "no override". */
  dismissedByRef: Map<string, EvidenceOverrideRow>
  /** Fast lookup for correct_value overrides keyed by "<table>:<id>". */
  correctionsByRef: Map<string, EvidenceOverrideRow>
}

const EMPTY_INDEX: EvidenceOverridesIndex = {
  rows: [],
  dismissedByRef: new Map(),
  correctionsByRef: new Map(),
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadEvidenceOverrides(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<EvidenceOverridesIndex> {
  try {
    const { data, error } = await supabase
      .from('evidence_overrides')
      .select('id, evidence_kind, evidence_ref, override_action, correction_value, reason')
      .eq('wedding_id', weddingId)
      .eq('active', true)
    if (error) {
      console.warn('[evidence-overrides] load failed:', error.message)
      return EMPTY_INDEX
    }
    const rows = (data ?? []) as EvidenceOverrideRow[]
    const dismissedByRef = new Map<string, EvidenceOverrideRow>()
    const correctionsByRef = new Map<string, EvidenceOverrideRow>()
    for (const r of rows) {
      const ref = r.evidence_ref ?? {}
      const tbl = typeof ref.table === 'string' ? ref.table : null
      const id = typeof ref.id === 'string' ? ref.id : null
      if (!tbl || !id) continue
      const key = `${tbl}:${id}`
      if (r.override_action === 'dismiss' || r.override_action === 'unlink') {
        dismissedByRef.set(key, r)
      } else if (r.override_action === 'correct_value') {
        correctionsByRef.set(key, r)
      }
    }
    return { rows, dismissedByRef, correctionsByRef }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[evidence-overrides] load threw:', msg)
    return EMPTY_INDEX
  }
}

// ---------------------------------------------------------------------------
// Per-row check
// ---------------------------------------------------------------------------

/** True when this (table, id) is dismissed/unlinked — evidence loader
 *  MUST drop the row from the prompt input / timeline output. */
export function isEvidenceDismissed(
  index: EvidenceOverridesIndex,
  table: string,
  id: string,
): boolean {
  return index.dismissedByRef.has(`${table}:${id}`)
}

export function getEvidenceCorrection(
  index: EvidenceOverridesIndex,
  table: string,
  id: string,
): EvidenceOverrideRow | null {
  return index.correctionsByRef.get(`${table}:${id}`) ?? null
}
