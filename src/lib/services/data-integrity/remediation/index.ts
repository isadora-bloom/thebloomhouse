/**
 * Wave 9 — remediation barrel + dispatcher.
 *
 * Anchor docs:
 *   - bloom-data-integrity-sweep.md (detector + 9 invariants live in
 *     ../data-integrity.ts; this directory is the sibling REMEDIATION
 *     surface that closes the operator loop)
 *   - feedback_deep_fix_vs_bandaid.md (structural fix: one click per
 *     anomaly, idempotent, audited)
 *
 * Public API:
 *   - remediateGhostWeddings              → wedding_has_people
 *   - remediateMisclassifiedInbound       → direction_from_venue_own
 *   - remediateInquiryDateDrift           → inquiry_date_drift
 *   - remediateTouchpointSourceMismatch   → touchpoint_source_consistency
 *   - runRemediation(invariantId, ...)    → dispatch by invariant id
 *   - runAllRemediations(...)             → run all four in sequence
 *   - persistRemediationRun(...)          → write the audit row
 */

import { createServiceClient } from '@/lib/supabase/service'
import { remediateGhostWeddings } from './wedding-has-people'
import { remediateMisclassifiedInbound } from './direction-from-venue-own'
import { remediateInquiryDateDrift } from './inquiry-date-drift'
import { remediateTouchpointSourceMismatch } from './touchpoint-source-consistency'
import type { RemediationCallArgs, RemediationResult } from './types'

export {
  remediateGhostWeddings,
  remediateMisclassifiedInbound,
  remediateInquiryDateDrift,
  remediateTouchpointSourceMismatch,
}

export type { RemediationCallArgs, RemediationResult, RemediationMode } from './types'

export const SUPPORTED_INVARIANT_IDS = [
  'wedding_has_people',
  'direction_from_venue_own',
  'inquiry_date_drift',
  'touchpoint_source_consistency',
] as const

export type SupportedInvariantId = typeof SUPPORTED_INVARIANT_IDS[number]

export function isSupportedInvariantId(id: string): id is SupportedInvariantId {
  return (SUPPORTED_INVARIANT_IDS as readonly string[]).includes(id)
}

/**
 * Dispatch one remediation by invariant id.
 *
 * Throws when the invariant id is not yet supported by the remediation
 * surface — falling silent would hide a band-aid escape valve (operator
 * fires "fix everything" on the admin page, one invariant errors, they
 * never see it). The endpoint translates to a 400 response.
 */
export async function runRemediation(
  invariantId: string,
  args: RemediationCallArgs,
): Promise<RemediationResult> {
  switch (invariantId) {
    case 'wedding_has_people':
      return remediateGhostWeddings(args)
    case 'direction_from_venue_own':
      return remediateMisclassifiedInbound(args)
    case 'inquiry_date_drift':
      return remediateInquiryDateDrift(args)
    case 'touchpoint_source_consistency':
      return remediateTouchpointSourceMismatch(args)
    default:
      throw new Error(`Unsupported invariant id for remediation: ${invariantId}`)
  }
}

/**
 * Run every supported remediation against one venue, sequentially.
 * Each result is returned independently — the caller decides what to
 * persist. Order is deterministic so audit rows produced by the sweep
 * are reproducible.
 */
export async function runAllRemediations(args: RemediationCallArgs): Promise<RemediationResult[]> {
  const out: RemediationResult[] = []
  for (const id of SUPPORTED_INVARIANT_IDS) {
    try {
      out.push(await runRemediation(id, args))
    } catch (err) {
      // Don't let one remediation kill the rest — log and continue.
      const message = err instanceof Error ? err.message : String(err)
      out.push({
        invariantId: id,
        mode: args.mode,
        violationsDetected: 0,
        violationsFixed: 0,
        violationsSkipped: 0,
        skipReasons: {},
        fixStrategy: 'remediation_threw_before_completion',
        sampleBefore: [],
        sampleAfter: [],
        errors: [{ stage: 'runRemediation', message }],
      })
    }
  }
  return out
}

/**
 * Persist a single remediation run as an integrity_remediations row.
 * Best-effort — failure logs and continues. The result is still
 * returned to the caller; the audit row is just the durable trace.
 */
export async function persistRemediationRun(args: {
  venueId: string
  result: RemediationResult
  operatorId?: string | null
  startedAt: string
}): Promise<{ id: string | null }> {
  const sb = createServiceClient()
  const completedAt = new Date().toISOString()
  const payload: Record<string, unknown> = {
    venue_id: args.venueId,
    invariant_id: args.result.invariantId,
    mode: args.result.mode,
    violations_detected: args.result.violationsDetected,
    violations_fixed: args.result.violationsFixed,
    violations_skipped: args.result.violationsSkipped,
    skip_reasons: args.result.skipReasons,
    fix_strategy: args.result.fixStrategy,
    sample_before: args.result.sampleBefore,
    sample_after: args.result.mode === 'apply' ? args.result.sampleAfter : null,
    started_at: args.startedAt,
    completed_at: completedAt,
    operator_id: args.operatorId ?? null,
    errors: args.result.errors,
  }
  const { data, error } = await sb
    .from('integrity_remediations')
    .insert(payload)
    .select('id')
    .single()
  if (error) {
    console.warn('[integrity_remediations] insert failed:', error.message)
    return { id: null }
  }
  return { id: (data as { id: string }).id }
}
