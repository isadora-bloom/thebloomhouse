/**
 * Bulk-read anomaly detection. Tier-C #130.
 *
 * Scans the read-side audit log (activity_log) for users whose tier-1
 * read volume crosses thresholds — a heuristic signal for a leaked
 * coordinator credential or a malicious insider.
 *
 * Two thresholds:
 *   Burst: > BURST_ROW_THRESHOLD rows in the last BURST_WINDOW_MIN
 *   Daily: > DAILY_ROW_THRESHOLD rows in the last 24 hours
 *
 * Either crossed → write an admin_notifications row tagged
 * notification_type='bulk_read_anomaly'. Idempotent: a user already
 * flagged in the last 24h is skipped (one notification per anomaly
 * window, not per cron tick).
 *
 * Run from prune_maintenance (nightly) so we don't add a new Vercel
 * cron entry. The detection window covers the full 24h preceding,
 * which is the right cadence for "did anyone exfil yesterday".
 */

import { createServiceClient } from '@/lib/supabase/service'
import { createNotification } from '@/lib/services/admin-notifications'

/** Tier-1 read activity_types this detector cares about. `view_` is
 *  single-row but tier-1 PII; `bulk_read_` and `export_` are multi-row
 *  high-signal. We trigger on EITHER row-volume OR event-frequency so a
 *  drip-style exfil (one wedding view at a time) still surfaces. */
const TIER_1_READ_PREFIXES = ['export_', 'bulk_read_', 'view_']

/** Burst window — short, tighter threshold. */
const BURST_WINDOW_MIN = 5
const BURST_ROW_THRESHOLD = 500
const BURST_EVENT_THRESHOLD = 50

/** Daily window — longer, generous threshold. */
const DAILY_WINDOW_HOURS = 24
const DAILY_ROW_THRESHOLD = 5_000
const DAILY_EVENT_THRESHOLD = 200

interface UserBucket {
  user_id: string
  venue_id: string
  burst_rows: number
  daily_rows: number
  burst_events: number
  daily_events: number
  resources: Set<string>
}

export interface BulkReadAnomalyResult {
  users_flagged: number
  notifications_created: number
  errors: string[]
}

export async function detectBulkReadAnomalies(): Promise<BulkReadAnomalyResult> {
  const supabase = createServiceClient()
  const errors: string[] = []
  const now = Date.now()
  const dailyCutoff = new Date(now - DAILY_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const burstCutoff = new Date(now - BURST_WINDOW_MIN * 60 * 1000).toISOString()

  // Pull all tier-1 read entries in the last 24h. activity_type prefix
  // filter via OR; PostgREST .or() takes the column-name-prefixed form.
  const { data: rows, error } = await supabase
    .from('activity_log')
    .select('venue_id, user_id, activity_type, details, created_at')
    .gte('created_at', dailyCutoff)
    .or(
      TIER_1_READ_PREFIXES.map((p) => `activity_type.like.${p}*`).join(','),
    )
    .limit(20_000)
  if (error) {
    errors.push(`activity_log read: ${error.message}`)
    return { users_flagged: 0, notifications_created: 0, errors }
  }

  // Bucket by user_id (skip rows without a user — system events).
  const buckets = new Map<string, UserBucket>()
  for (const r of (rows ?? []) as Array<{
    venue_id: string
    user_id: string | null
    activity_type: string
    details: Record<string, unknown> | null
    created_at: string
  }>) {
    if (!r.user_id) continue
    const bucket: UserBucket =
      buckets.get(r.user_id) ?? {
        user_id: r.user_id,
        venue_id: r.venue_id,
        burst_rows: 0,
        daily_rows: 0,
        burst_events: 0,
        daily_events: 0,
        resources: new Set<string>(),
      }
    const rowCount = Number(
      (r.details as { row_count?: number } | null)?.row_count ?? 1,
    )
    bucket.daily_rows += Number.isFinite(rowCount) ? rowCount : 1
    bucket.daily_events += 1
    if (r.created_at >= burstCutoff) {
      bucket.burst_rows += Number.isFinite(rowCount) ? rowCount : 1
      bucket.burst_events += 1
    }
    bucket.resources.add(r.activity_type.replace(/^(export_|bulk_read_)/, ''))
    buckets.set(r.user_id, bucket)
  }

  // Filter to over-threshold buckets. Trigger on rows OR events so
  // one-wedding-at-a-time drip exfil still surfaces (each view logs
  // rowCount=1 so the row-volume check alone would never fire).
  const flagged: UserBucket[] = []
  for (const b of buckets.values()) {
    const burstHit =
      b.burst_rows > BURST_ROW_THRESHOLD || b.burst_events > BURST_EVENT_THRESHOLD
    const dailyHit =
      b.daily_rows > DAILY_ROW_THRESHOLD || b.daily_events > DAILY_EVENT_THRESHOLD
    if (burstHit || dailyHit) flagged.push(b)
  }

  if (flagged.length === 0) {
    return { users_flagged: 0, notifications_created: 0, errors }
  }

  // Write one notification per flagged user. The notification is
  // venue-broadcast (no userId) so org_admin / super_admin actually see
  // it in their bell — targeting userId=offender would deliver the
  // alert to the very user we're flagging.
  //
  // Dedup: the per-user createNotification dedup keys on (venue, type,
  // user_id) which doesn't apply to broadcast rows. Pre-check by body
  // prefix instead — the offender id is the first token of the body.
  const { data: recent } = await supabase
    .from('admin_notifications')
    .select('body')
    .eq('type', 'bulk_read_anomaly')
    .gte('created_at', dailyCutoff)
  const alreadyNotified = new Set<string>()
  for (const n of (recent ?? []) as Array<{ body: string | null }>) {
    const m = n.body?.match(/^User ([0-9a-f-]+) /i)
    if (m) alreadyNotified.add(m[1])
  }

  let notificationsCreated = 0
  for (const b of flagged) {
    if (alreadyNotified.has(b.user_id)) continue
    const reasons: string[] = []
    if (b.burst_rows > BURST_ROW_THRESHOLD) reasons.push(`${b.burst_rows} rows in ${BURST_WINDOW_MIN} min`)
    if (b.burst_events > BURST_EVENT_THRESHOLD) reasons.push(`${b.burst_events} reads in ${BURST_WINDOW_MIN} min`)
    if (b.daily_rows > DAILY_ROW_THRESHOLD) reasons.push(`${b.daily_rows} rows in ${DAILY_WINDOW_HOURS}h`)
    if (b.daily_events > DAILY_EVENT_THRESHOLD) reasons.push(`${b.daily_events} reads in ${DAILY_WINDOW_HOURS}h`)
    const resourceList = Array.from(b.resources).join(', ')
    const body = [
      `User ${b.user_id} crossed bulk-read threshold (${reasons.join('; ') || 'unknown'}).`,
      `Resources touched: ${resourceList || 'unknown'}.`,
      `Daily total: ${b.daily_rows} rows over ${b.daily_events} events.`,
      `Review activity_log filtered to user_id=${b.user_id} for the affected window.`,
    ].join(' ')
    try {
      await createNotification({
        venueId: b.venue_id,
        type: 'bulk_read_anomaly',
        title: 'Unusual bulk-read volume',
        body,
        priority: 'high',
      })
      notificationsCreated += 1
    } catch (err) {
      errors.push(
        `notification insert (${b.user_id}): ${err instanceof Error ? err.message : 'unknown'}`,
      )
    }
  }

  console.log(
    `[bulk_read_anomaly] flagged=${flagged.length} new_notifications=${notificationsCreated}` +
      (errors.length > 0 ? ` errors=${errors.length}` : ''),
  )

  return {
    users_flagged: flagged.length,
    notifications_created: notificationsCreated,
    errors,
  }
}
