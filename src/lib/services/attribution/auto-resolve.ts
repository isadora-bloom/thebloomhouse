/**
 * Source-conflict auto-resolution.
 *
 * Anchor: Round 2 audit TIER 2e (2026-05-14). The audit observed a
 * 110-conflict queue at Rixey driven mostly by `weddings.source =
 * 'honeybook'` losing to wave-7B-classified origins. HoneyBook is a
 * CRM destination, not an origin. Every conflict between
 * "destination" + "origin" was always going to resolve in favor of
 * the origin — there's no judgment call. Manual review on those is
 * pure friction.
 *
 * Three classes of auto-resolution:
 *
 * 1. DESTINATION — legacy source is a CRM / form / scheduling tool.
 *    The computed origin wins unconditionally. (Captures honeybook,
 *    calendly, acuity, dubsado, aisle_planner, tave.)
 *
 * 2. LOW_INFORMATION — legacy source is generic ('website', 'unset',
 *    null). Computed wins when its confidence >= 0.85.
 *
 * 3. HIGH_CONFIDENCE — regardless of legacy value, computed origin
 *    wins when confidence >= 0.95.
 *
 * Auto-resolved rows get conflict_resolution_state set + audit
 * trail in conflict_resolved_by. Coordinators can still unwind via
 * the same /intel/candidates review UI.
 *
 * Expected impact (per audit): 110-conflict queue → 15-25 real cases.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type ResolutionState =
  | 'auto_resolved_destination'
  | 'auto_resolved_low_information'
  | 'auto_resolved_high_confidence'
  | null

const NEVER_VALID_AS_LEGACY_SOURCE = new Set<string>([
  'honeybook',
  'calendly',
  'acuity',
  'dubsado',
  'aisle_planner',
  'aisleplanner',
  'tave',
  'tave_studio',
  'tavestudio',
])

const LOW_INFORMATION_LEGACY = new Set<string>([
  'website',
  'unset',
  'unknown',
  'other',
  '',
])

const HIGH_CONFIDENCE_THRESHOLD = 95
const LOW_INFO_OVERRIDE_THRESHOLD = 85

export interface AutoResolveInput {
  /** Original weddings.source value at attribution-write time. */
  legacy_source: string | null
  /** Computed origin from the candidate resolver. */
  computed_source: string | null
  /** Confidence 0-100 from the candidate resolver. */
  computed_confidence: number
}

export interface AutoResolveResult {
  resolution_state: ResolutionState
  reason: string | null
}

/**
 * Decide whether a fresh attribution_events row should be marked
 * auto-resolved at write time. Called from the candidate-resolver
 * AND backtrack paths when conflict_with_legacy_source is non-null.
 *
 * Returns { state: null } when no rule fires — the conflict stays
 * open and surfaces in the coordinator review queue.
 */
export function decideAutoResolve(input: AutoResolveInput): AutoResolveResult {
  const legacy = (input.legacy_source ?? '').toLowerCase().trim()
  const computed = (input.computed_source ?? '').toLowerCase().trim()

  // No computed source — nothing to resolve against.
  if (!computed) return { resolution_state: null, reason: null }

  // Rule 1: legacy is a CRM / form / scheduling destination. Computed
  // wins regardless of confidence — the legacy value was never a
  // valid origin in the first place.
  if (NEVER_VALID_AS_LEGACY_SOURCE.has(legacy)) {
    return {
      resolution_state: 'auto_resolved_destination',
      reason: `Legacy source '${legacy}' is a CRM/form destination, not an origin. Computed '${computed}' wins.`,
    }
  }

  // Rule 2: legacy is low-information. Computed wins when its
  // confidence is at least 85.
  if (
    (LOW_INFORMATION_LEGACY.has(legacy) || legacy === '') &&
    input.computed_confidence >= LOW_INFO_OVERRIDE_THRESHOLD
  ) {
    return {
      resolution_state: 'auto_resolved_low_information',
      reason: `Legacy source '${legacy}' is generic; computed '${computed}' wins at confidence ${input.computed_confidence}.`,
    }
  }

  // Rule 3: regardless of legacy, computed confidence above the high
  // bar wins.
  if (input.computed_confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    return {
      resolution_state: 'auto_resolved_high_confidence',
      reason: `Computed '${computed}' at confidence ${input.computed_confidence} exceeds the high-confidence override threshold.`,
    }
  }

  return { resolution_state: null, reason: null }
}

/**
 * Backfill auto-resolution across existing open conflicts. Run once
 * after mig 338 lands; expected to drop the 110-conflict queue
 * meaningfully without a single coordinator click.
 */
export async function backfillAutoResolveOpenConflicts(
  supabase: SupabaseClient,
  venueId: string,
): Promise<{ resolved: number; remaining: number; errors: string[] }> {
  const errors: string[] = []
  let resolved = 0

  // Fetch open conflicts for the venue. Live + open only.
  const { data: open, error } = await supabase
    .from('attribution_events_live')
    .select(
      'id, wedding_id, source_platform, confidence, conflict_with_legacy_source',
    )
    .eq('venue_id', venueId)
    .not('conflict_with_legacy_source', 'is', null)
    .is('conflict_resolution_state', null)
    .limit(5000)
  if (error) {
    return { resolved: 0, remaining: 0, errors: [error.message] }
  }
  if (!open || open.length === 0) {
    return { resolved: 0, remaining: 0, errors: [] }
  }

  for (const evt of open as Array<{
    id: string
    wedding_id: string
    source_platform: string | null
    confidence: number
    conflict_with_legacy_source: string | null
  }>) {
    // conflict_with_legacy_source has the format "legacy=X computed=Y".
    // Parse it back out.
    const parsed = parseConflictFlag(evt.conflict_with_legacy_source)
    const decision = decideAutoResolve({
      legacy_source: parsed.legacy,
      computed_source: evt.source_platform ?? parsed.computed,
      computed_confidence: evt.confidence,
    })
    if (!decision.resolution_state) continue

    const { error: updErr } = await supabase
      .from('attribution_events')
      .update({
        conflict_resolution_state: decision.resolution_state,
        conflict_resolved_at: new Date().toISOString(),
        conflict_resolved_by: 'system_rule',
      })
      .eq('id', evt.id)
    if (updErr) {
      errors.push(`event ${evt.id}: ${updErr.message}`)
      continue
    }
    resolved += 1
  }

  const remaining = (open?.length ?? 0) - resolved
  return { resolved, remaining, errors }
}

function parseConflictFlag(
  flag: string | null,
): { legacy: string | null; computed: string | null } {
  if (!flag) return { legacy: null, computed: null }
  const legMatch = flag.match(/legacy=([^\s]+)/i)
  const compMatch = flag.match(/computed=([^\s]+)/i)
  return {
    legacy: legMatch?.[1] ?? null,
    computed: compMatch?.[1] ?? null,
  }
}
