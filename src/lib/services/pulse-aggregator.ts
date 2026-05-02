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

export async function aggregatePulse(
  supabase: SupabaseClient,
  venueId: string,
  opts: { limit?: number; sinceDays?: number } = {},
): Promise<PulseItem[]> {
  const limit = opts.limit ?? 50
  const sinceDays = opts.sinceDays ?? 14
  const sinceIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString()

  // Pull active snoozes + dismissals up front so we can filter
  // PulseItem candidates without a per-item query (T4-C). dismissed
  // = forever-hidden; snoozed_until > now() = currently hidden;
  // expired snoozes fall off the filter naturally.
  const { data: snoozeRows } = await supabase
    .from('pulse_snoozes')
    .select('item_key, action, snoozed_until')
    .eq('venue_id', venueId)
  const nowIso = new Date().toISOString()
  const hiddenKeys = new Set<string>()
  for (const r of ((snoozeRows ?? []) as Array<{ item_key: string; action: string; snoozed_until: string | null }>)) {
    if (r.action === 'dismissed') {
      hiddenKeys.add(r.item_key)
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

  // Anomalies (unacknowledged).
  const { data: anomalies } = await supabase
    .from('anomaly_alerts')
    .select('id, alert_type, metric_name, severity, ai_explanation, current_value, baseline_value, acknowledged, created_at')
    .eq('venue_id', venueId)
    .eq('acknowledged', false)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit)
  for (const a of ((anomalies ?? []) as AnomalyRow[])) {
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

  // Insights (new + high-priority).
  const { data: insights } = await supabase
    .from('intelligence_insights')
    .select('id, insight_type, title, body, priority, status, context_id, created_at')
    .eq('venue_id', venueId)
    .eq('status', 'new')
    .in('priority', ['critical', 'high'])
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit)
  for (const i of ((insights ?? []) as InsightRow[])) {
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

  return visible.slice(0, limit)
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
