/**
 * Wave 9 — shared types + helpers for the remediation surface.
 *
 * Anchor docs:
 *   - bloom-data-integrity-sweep.md (detector lives in data-integrity.ts;
 *     remediation is a sibling surface keyed on the same invariant ids)
 *   - feedback_deep_fix_vs_bandaid.md (structural, idempotent, audited)
 *
 * Every remediation function returns the same shape so the sweep + the
 * admin endpoint can render uniformly:
 *
 *   {
 *     mode: 'dry_run' | 'apply',
 *     violations_detected: <int>,
 *     violations_fixed: <int>,
 *     violations_skipped: <int>,
 *     skip_reasons: { <reason>: <count> },
 *     fix_strategy: '<one-line description>',
 *     sample_before: [...],
 *     sample_after: [...],
 *     errors: [...],
 *   }
 */

export type RemediationMode = 'dry_run' | 'apply'

export interface RemediationResult {
  invariantId: string
  mode: RemediationMode
  violationsDetected: number
  violationsFixed: number
  violationsSkipped: number
  skipReasons: Record<string, number>
  fixStrategy: string
  sampleBefore: Record<string, unknown>[]
  sampleAfter: Record<string, unknown>[]
  errors: Array<{ stage: string; message: string; ref?: string }>
}

export interface RemediationCallArgs {
  venueId: string
  mode: RemediationMode
}

/** Cap the sample arrays so we keep the audit-row JSON small. */
export const SAMPLE_CAP = 10

export function makeEmptyResult(invariantId: string, mode: RemediationMode, fixStrategy: string): RemediationResult {
  return {
    invariantId,
    mode,
    violationsDetected: 0,
    violationsFixed: 0,
    violationsSkipped: 0,
    skipReasons: {},
    fixStrategy,
    sampleBefore: [],
    sampleAfter: [],
    errors: [],
  }
}

export function bumpSkip(result: RemediationResult, reason: string) {
  result.violationsSkipped += 1
  result.skipReasons[reason] = (result.skipReasons[reason] ?? 0) + 1
}

export function pushError(result: RemediationResult, stage: string, err: unknown, ref?: string) {
  const message = err instanceof Error ? err.message : String(err)
  result.errors.push(ref ? { stage, message, ref } : { stage, message })
}
