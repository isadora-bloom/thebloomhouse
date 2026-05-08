/**
 * Audit-log retention sweeper. Tier-C #132.
 *
 * activity_log is the platform's authoritative read-side audit trail
 * (compliance #129, breach response, regulator response). It must be
 * retained longer than telemetry but cannot grow forever — privacy
 * requirements + storage cost both pull toward bounded retention.
 *
 * Default retention: 730 days (2 years). Rationale:
 *   - Long enough that "did anyone exfil last year" is answerable.
 *   - Long enough that a regulator request from the year prior can be
 *     served (CCPA + GDPR look-back is typically 12 months).
 *   - Short enough that a leaked / dumped audit log is not a forever
 *     liability under data-minimisation principles.
 *
 * For the consumer_requests ledger we DO NOT prune via this sweeper —
 * that table is append-only by design (see mig 231); retention there
 * is governed by the regulator response window, not internal storage
 * pressure.
 *
 * Sequencing: invoked from the prune_maintenance cron alongside
 * telemetry retention. One sub-job; failure logs but does not block
 * sibling sub-jobs.
 */

import { createServiceClient } from '@/lib/supabase/service'

export const AUDIT_RETENTION_DAYS = 730

export interface AuditRetentionResult {
  activity_log_deleted: number
  errors: string[]
}

export async function runAuditRetentionPrune(): Promise<AuditRetentionResult> {
  const supabase = createServiceClient()
  const errors: string[] = []
  const cutoff = new Date(
    Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  let deleted = 0
  try {
    const { data, error } = await supabase
      .from('activity_log')
      .delete()
      .lt('created_at', cutoff)
      .select('id')
    if (error) errors.push(`activity_log: ${error.message}`)
    deleted = (data ?? []).length
  } catch (err) {
    errors.push(`activity_log: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  console.log(
    `[audit_retention] activity_log_deleted=${deleted}` +
      (errors.length > 0 ? ` errors=${errors.length}` : ''),
  )

  return { activity_log_deleted: deleted, errors }
}
