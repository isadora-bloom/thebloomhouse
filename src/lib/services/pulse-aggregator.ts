/**
 * Unified pulse aggregator (ARCH-20.2.2 / Playbook 20.2).
 *
 * Pre-this-file the venue had 4 fragmented feeds:
 *   - /intel/anomalies        (anomaly_alerts)
 *   - /intel/market-pulse     (correlation insights)
 *   - /agent/notifications    (admin_notifications)
 *   - /intel/dashboard        (intelligence_insights snapshot)
 *
 * Coordinator had to scan all four to know what needed attention. The
 * playbook calls for a unified pulse surface — one feed, sorted by
 * priority + recency. This service is the read-side aggregator;
 * snooze + escalate-to-brain-dump are follow-up UX layers that build
 * on this foundation.
 *
 * Source tables aggregated:
 *   - admin_notifications (unread)
 *   - anomaly_alerts (unacknowledged + active)
 *   - intelligence_insights (status='new' + high-priority)
 *
 * Returns a flat PulseItem[] sorted by (priority, recency desc).
 *
 * T5-eta.1 + iota.7: also returns a top-level `pausedBanner` (cost-
 * ceiling pause state) and lets critical-priority insights bypass the
 * sinceDays floor so a 30-day-old risk-flag still appears as long as
 * it hasn't been acted on.
 *
 * T5-followup-W (2026-05-02): same priority-aware split applied to
 * `anomaly_alerts` (severity='critical' bypasses the floor;
 * severity='info' decays after 14d; severity='warning' uses the
 * standard floor) and to pulse-snooze dismissals (forever-dismissals
 * now decay after 90 days unless re-dismissed). Closes
 * eng-MED-18 + eng-LOW-24.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type PulseSource = 'notification' | 'anomaly' | 'insight'
export type PulsePriority = 'critical' | 'high' | 'medium' | 'low'

export interface PulseItem {
  id: string
  source: PulseSource
  priority: PulsePriority
  title: string
  body: string | null
  /** Optional context url for the coordinator to act on. */
  href: string | null
  /** When the underlying row was created. */
  createdAt: string
  /** Source-specific metadata (alert_type, insight_type, etc.). */
  metadata: Record<string, unknown>
}

const PRIORITY_RANK: Record<PulsePriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

interface NotificationRow {
  id: string
  type: string
  title: string
  body: string | null
  wedding_id: string | null
  created_at: string
  read: boolean
}

interface AnomalyRow {
  id: string
  alert_type: string
  metric_name: string
  severity: 'info' | 'warning' | 'critical'
  ai_explanation: string | null
  current_value: number | null
  baseline_value: number | null
  acknowledged: boolean
  created_at: string
}

interface InsightRow {
  id: string
  insight_type: string
  title: string
  body: string | null
  priority: 'critical' | 'high' | 'medium' | 'low'
  status: string
  context_id: string | null
  created_at: string
}

/** Map a notification type to a coordinator-action href. */
function notificationHref(type: string, weddingId: string | null): string | null {
  if (type.startsWith('brain_dump_')) return '/agent/notifications'
  if (type === 'sage_uncertain') return '/portal/sage-queue'
  if (type === 'auto_send_pending') return '/agent/notifications'
  if (type === 'escalation' && weddingId) return `/intel/clients/${weddingId}`
  return '/agent/notifications'
}

function notificationPriority(type: string): PulsePriority {
  if (type === 'escalation') return 'critical'
  if (type.endsWith('_confirm')) return 'high'  // brain-dump propose-and-confirm
  if (type === 'auto_send_pending') return 'high'
  if (type === 'sage_uncertain') return 'high'
  return 'medium'
}

function anomalyPriority(severity: 'info' | 'warning' | 'critical'): PulsePriority {
  if (severity === 'critical') return 'critical'
  if (severity === 'warning') return 'high'
  return 'low'
}

/**
 * T5-eta.1: paused-banner data for the /pulse top-of-page sticky.
 * Surfaces the cost-ceiling pause state + a derived list of skipped
 * work types so the coordinator sees WHY work didn't happen, not
 * just an empty feed. The banner is NOT a notification (cannot be
 * snoozed/dismissed) — it pins until the pause clears.
 */
export interface PulsePausedBanner {
  paused: boolean
  pausedAt: string | null
  pausedReason: string | null
  ceilingCents: number
  spendCents: number
  utilisation: number
  /** Nominal earliest auto-resume time (next UTC midnight). */
  resumeAt: string
  /** Per-work-type skip counts during this paused window. Read from
   *  paused_period_skipped where status='pending'. Empty when the
   *  pause is brand-new and no cron has tried to run yet. */
  skipCounts: Record<string, number>
  /** Total pending skipped rows across all work types. */
  totalSkipped: number
}

export interface PulseAggregateResult {
  items: PulseItem[]
  pausedBanner: PulsePausedBanner | null
}

export async function aggregatePulse(
  supabase: SupabaseClient,
  venueId: string,
  opts: { limit?: number; sinceDays?: number } = {},
): Promise<PulseItem[]> {
  const result = await aggregatePulseFull(supabase, venueId, opts)
  return result.items
}

/**
 * Same as aggregatePulse but also returns the paused banner. The /api/
 * pulse route calls this; the legacy aggregatePulse() return shape is
 * preserved for backward-compat with any internal callers that just
 * want the items.
 */
export async function aggregatePulseFull(
  supabase: SupabaseClient,
  venueId: string,
  opts: { limit?: number; sinceDays?: number } = {},
): Promise<PulseAggregateResult> {
  const limit = opts.limit ?? 50
  const sinceDays = opts.sinceDays ?? 14
  const sinceIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString()

  // Pull active snoozes + dismissals up front so we can filter
  // PulseItem candidates without a per-item query (T4-C).
  //
  // T5-followup-W (2026-05-02): dismissals now decay. Pre-fix the
  // dismiss action was forever — a coordinator who dismissed a
  // pulse item in February would never see that surface re-fire, even
  // if the underlying condition came back six months later. New rule:
  // dismissals stay sticky for 90 days from `created_at`; after that
  // they fall off the hidden set and the item re-surfaces (the
  // coordinator can re-dismiss; that bumps `created_at` via the
  // upsert). snoozed_until > now() filter is unchanged.
  const { data: snoozeRows } = await supabase
    .from('pulse_snoozes')
    .select('item_key, action, snoozed_until, created_at')
    .eq('venue_id', venueId)
  const nowIso = new Date().toISOString()
  const ninetyDaysAgoIso = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const hiddenKeys = new Set<string>()
  for (const r of ((snoozeRows ?? []) as Array<{ item_key: string; action: string; snoozed_until: string | null; created_at: string }>)) {
    if (r.action === 'dismissed') {
      // 90-day TTL on dismissals (eng LOW 24).
      if (r.created_at >= ninetyDaysAgoIso) {
        hiddenKeys.add(r.item_key)
      }
    } else if (r.action === 'snoozed' && r.snoozed_until && r.snoozed_until > nowIso) {
      hiddenKeys.add(r.item_key)
    }
  }

  const items: PulseItem[] = []

  // Notifications.
  const { data: notifs } = await supabase
    .from('admin_notifications')
    .select('id, type, title, body, wedding_id, created_at, read')
    .eq('venue_id', venueId)
    .eq('read', false)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit)
  for (const n of ((notifs ?? []) as NotificationRow[])) {
    items.push({
      id: `notif:${n.id}`,
      source: 'notification',
      priority: notificationPriority(n.type),
      title: n.title,
      body: n.body,
      href: notificationHref(n.type, n.wedding_id),
      createdAt: n.created_at,
      metadata: { type: n.type, wedding_id: n.wedding_id },
    })
  }

  // Anomalies (unacknowledged). T5-followup-W (eng MED 18) — split by
  // severity so the floor matches the alert's importance:
  //   - critical : bypass sinceDays floor (a critical anomaly that
  //                hasn't been acknowledged stays on /pulse until
  //                someone acks it; aging out silently is the bug).
  //   - warning  : standard sinceDays floor (the existing default).
  //   - info     : 14-day hard cap, INDEPENDENT of sinceDays. Info-tier
  //                alerts decay so the feed doesn't drown in low-signal
  //                noise; if sinceDays > 14 the floor is actually
  //                tightened, not relaxed.
  // Three queries instead of one to keep index selectivity right; the
  // dedupe-by-id pass below is idempotent (same alert can't appear
  // twice — they have distinct severities).
  const fourteenDaysAgoIso = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const infoFloorIso = sinceIso > fourteenDaysAgoIso ? sinceIso : fourteenDaysAgoIso

  const { data: criticalAnomalies } = await supabase
    .from('anomaly_alerts')
    .select('id, alert_type, metric_name, severity, ai_explanation, current_value, baseline_value, acknowledged, created_at')
    .eq('venue_id', venueId)
    .eq('acknowledged', false)
    .eq('severity', 'critical')
    .order('created_at', { ascending: false })
    .limit(limit)

  const { data: warningAnomalies } = await supabase
    .from('anomaly_alerts')
    .select('id, alert_type, metric_name, severity, ai_explanation, current_value, baseline_value, acknowledged, created_at')
    .eq('venue_id', venueId)
    .eq('acknowledged', false)
    .eq('severity', 'warning')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit)

  const { data: infoAnomalies } = await supabase
    .from('anomaly_alerts')
    .select('id, alert_type, metric_name, severity, ai_explanation, current_value, baseline_value, acknowledged, created_at')
    .eq('venue_id', venueId)
    .eq('acknowledged', false)
    .eq('severity', 'info')
    .gte('created_at', infoFloorIso)
    .order('created_at', { ascending: false })
    .limit(limit)

  const allAnomalies = [
    ...((criticalAnomalies ?? []) as AnomalyRow[]),
    ...((warningAnomalies ?? []) as AnomalyRow[]),
    ...((infoAnomalies ?? []) as AnomalyRow[]),
  ]
  const seenAnomalyIds = new Set<string>()
  for (const a of allAnomalies) {
    if (seenAnomalyIds.has(a.id)) continue
    seenAnomalyIds.add(a.id)
    const verb = a.current_value !== null && a.baseline_value !== null
      ? `${a.current_value} (baseline ${a.baseline_value})`
      : ''
    items.push({
      id: `anomaly:${a.id}`,
      source: 'anomaly',
      priority: anomalyPriority(a.severity),
      title: `${a.alert_type}: ${a.metric_name}${verb ? ' — ' + verb : ''}`,
      body: a.ai_explanation,
      href: '/intel/anomalies',
      createdAt: a.created_at,
      metadata: { alert_type: a.alert_type, severity: a.severity },
    })
  }

  // Insights (new + high-priority). T5-iota.7: critical-priority
  // insights bypass the sinceDays floor — a 30-day-old risk flag
  // that's never been acted on must keep surfacing on /pulse until
  // it's dismissed or marked acted_on. Pre-fix the >= sinceIso
  // filter was applied uniformly, so a critical risk insight from
  // 30 days ago silently fell off /pulse on day 15 even though the
  // coordinator never resolved it.
  //
  // Strategy: split the read into two queries to keep the index
  // selectivity right (the primary index is on (venue_id, status,
  // created_at)). High-priority gets the sinceDays floor; critical
  // ignores it. dedupeAndLimit catches any overlap.
  const { data: highInsights } = await supabase
    .from('intelligence_insights')
    .select('id, insight_type, title, body, priority, status, context_id, created_at')
    .eq('venue_id', venueId)
    .eq('status', 'new')
    .eq('priority', 'high')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit)

  // Critical-priority carve-out: per T5-iota.7 a critical insight
  // surfaces until the coordinator marks it acted_on or dismisses
  // it. status='new' OR 'seen' both qualify — 'seen' just means the
  // coordinator clicked through to read it, not that they resolved
  // it. Pre-fix the read filtered to status='new' only, so a critical
  // risk-flag the coordinator opened once silently fell off /pulse
  // even though the underlying issue was unaddressed.
  const { data: criticalInsights } = await supabase
    .from('intelligence_insights')
    .select('id, insight_type, title, body, priority, status, context_id, created_at')
    .eq('venue_id', venueId)
    .in('status', ['new', 'seen'])
    .eq('priority', 'critical')
    .order('created_at', { ascending: false })
    .limit(limit)

  const allInsights = [
    ...((criticalInsights ?? []) as InsightRow[]),
    ...((highInsights ?? []) as InsightRow[]),
  ]
  const seenInsightIds = new Set<string>()
  for (const i of allInsights) {
    if (seenInsightIds.has(i.id)) continue
    seenInsightIds.add(i.id)
    const href = i.context_id && /^[0-9a-f-]{36}$/i.test(i.context_id)
      ? `/intel/clients/${i.context_id}`
      : '/intel/insights'
    items.push({
      id: `insight:${i.id}`,
      source: 'insight',
      priority: i.priority,
      title: i.title,
      body: i.body,
      href,
      createdAt: i.created_at,
      metadata: { insight_type: i.insight_type, context_id: i.context_id },
    })
  }

  // Subtract snoozed/dismissed items.
  const visible = items.filter((it) => !hiddenKeys.has(it.id))

  // Sort by priority then recency. Stable ordering: same priority +
  // same created_at preserve their source-order.
  visible.sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (pr !== 0) return pr
    return b.createdAt.localeCompare(a.createdAt)
  })

  const pausedBanner = await loadPausedBanner(supabase, venueId)
  return { items: visible.slice(0, limit), pausedBanner }
}

/**
 * Load the cost-ceiling pause banner data (T5-eta.1). Returns null
 * when the venue isn't paused — the route renders nothing in that
 * case. When paused, returns enough context for the banner to show
 * since-when, the ceiling, and what got skipped during the window.
 */
async function loadPausedBanner(
  supabase: SupabaseClient,
  venueId: string,
): Promise<PulsePausedBanner | null> {
  const { data: cfg } = await supabase
    .from('venue_config')
    .select('autonomous_paused, autonomous_paused_at, autonomous_paused_reason, daily_cost_ceiling_cents')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (!cfg || !(cfg.autonomous_paused as boolean)) return null

  const ceilingCents = (cfg.daily_cost_ceiling_cents as number) ?? 500

  // Compute spend the same way getCostCeilingStatus does so the
  // banner number matches the cost-ceiling cron summary. Today's
  // UTC window.
  const utcDayStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
  ).toISOString()
  const { data: spendRows } = await supabase
    .from('api_costs')
    .select('cost')
    .eq('venue_id', venueId)
    .gte('created_at', utcDayStart)
  const spendDollars = (spendRows ?? []).reduce(
    (sum, r) => sum + Number((r as { cost: number | string }).cost ?? 0),
    0,
  )
  const spendCents = Math.round(spendDollars * 100)

  // Skip-count breakdown from paused_period_skipped (T5-eta.2).
  // Pending rows for this venue, grouped by work_type. When the
  // table doesn't exist yet (migration 161 not applied), we
  // gracefully return zero counts so the banner still renders.
  const skipCounts: Record<string, number> = {}
  let totalSkipped = 0
  try {
    const { data: skipped } = await supabase
      .from('paused_period_skipped')
      .select('work_type')
      .eq('venue_id', venueId)
      .eq('status', 'pending')
    for (const row of ((skipped ?? []) as Array<{ work_type: string }>)) {
      skipCounts[row.work_type] = (skipCounts[row.work_type] ?? 0) + 1
      totalSkipped++
    }
  } catch {
    // table not yet present — banner still renders with zeros.
  }

  // Next UTC midnight as the "earliest plausible auto-resume" hint.
  const now = new Date()
  const resumeAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString()

  return {
    paused: true,
    pausedAt: (cfg.autonomous_paused_at as string | null) ?? null,
    pausedReason: (cfg.autonomous_paused_reason as string | null) ?? null,
    ceilingCents,
    spendCents,
    utilisation: ceilingCents > 0 ? spendCents / ceilingCents : 0,
    resumeAt,
    skipCounts,
    totalSkipped,
  }
}

/** Pure helper — cap items to a limit. Exported for unit tests. */
export function dedupeAndLimit<T extends { id: string }>(items: T[], limit: number): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const it of items) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    out.push(it)
    if (out.length >= limit) break
  }
  return out
}

export const __test__ = {
  notificationPriority,
  anomalyPriority,
  PRIORITY_RANK,
  dedupeAndLimit,
}
