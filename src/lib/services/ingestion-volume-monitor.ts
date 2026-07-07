/**
 * Bloom House: Per-channel ingestion-volume anomaly monitor.
 *
 * REMEDIATION-PLAN-2026-07-07.md Phase R2 ("Ingestion monitoring").
 *
 * WHY THIS EXISTS
 * In April-June 2026 the Knot email ingestion silently regressed on Rixey:
 * Gmail was receiving ~10 new Knot couples a month but the pipeline captured
 * only ~2, and nothing alerted for two months (see
 * bloom-knot-ingestion-regression memory + the pipeline.ts fix, 68b4277).
 * The existing anomaly detector watches funnel metrics (inquiry_volume is
 * weddings-keyed) — a channel that stops MINTING rows is invisible to it.
 * This monitor watches the raw inbound `interactions` stream per channel,
 * so a single channel going quiet fires an alert even while total volume
 * looks healthy.
 *
 * DETECTION RULE (backtested against the Apr-Jun 2026 Knot regression by
 * scripts/backtest-ingestion-monitor.ts — see that file for the output):
 *   - Channel = sender-domain family of inbound interactions
 *     (knot / weddingwire / zola / calendly / honeybook / direct_email)
 *     plus non-email interaction types (sms / call / meeting).
 *   - recent  = count of inbound rows in the trailing 21 days
 *   - baseline = median 21-day count over the prior ~90 days
 *     (11 sliding windows ending 0,7,...,70 days before the recent window)
 *   - Alert when baseline >= 6 AND recent < 40% of baseline.
 *     critical below 20%, warning below 40%.
 *   The baseline >= 6 floor keeps naturally sparse channels (WeddingWire at
 *   ~1-5/month on Rixey) from alerting on noise.
 *
 * TIME AXIS: buckets on `interactions.timestamp` (event time), NOT
 * `created_at` (ingest time). Rows only exist once ingested, so a broken
 * channel shows up as missing recent event-time rows either way — but
 * created_at is destroyed by bulk re-imports (the 2026-07-03 Gmail re-sync
 * stamped every historical row with the same created_at), which would make
 * an ingest-time baseline meaningless.
 *
 * WRITE PATH: anomaly_alerts, same table the metric/availability detectors
 * in intel/anomaly-detection.ts write and /api/intel/anomalies +
 * /intel/anomalies read. Deterministic explanation (explanation_source
 * 'rule') — no LLM call, so no cost-ceiling gate. Idempotent per
 * venue+channel: updates the open row instead of stacking a new alert
 * every day the outage persists.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Trailing window whose count is compared against baseline. */
export const RECENT_WINDOW_DAYS = 21
/** Baseline = median of sliding 21-day windows sampled at this step... */
export const BASELINE_STEP_DAYS = 7
/** ...this many samples deep (11 x 7 = windows ending up to 70 days before
 *  the recent window; earliest window start is 91 days before it). */
export const BASELINE_SAMPLES = 11
/** Total history needed per run: recent window + deepest baseline window. */
export const LOOKBACK_DAYS =
  RECENT_WINDOW_DAYS + (BASELINE_SAMPLES - 1) * BASELINE_STEP_DAYS + RECENT_WINDOW_DAYS // 112
/** Channels whose baseline median is below this never alert (too sparse). */
export const MIN_BASELINE_MEDIAN = 6
/** recent/baseline below this ratio -> warning. */
export const ALERT_RATIO = 0.4
/** recent/baseline below this ratio -> critical. */
export const CRITICAL_RATIO = 0.2
/** After an operator acknowledges an ingestion alert, stay quiet on that
 *  venue+channel for this many days before minting a fresh row. */
const REALERT_COOLDOWN_DAYS = 14

export const INGESTION_ALERT_TYPE = 'ingestion_volume_drop'
export const INGESTION_METRIC_PREFIX = 'ingestion_volume_'

// ---------------------------------------------------------------------------
// Channel classification
// ---------------------------------------------------------------------------

/** Minimal slice of an interactions row the detector needs. */
export interface IngestionEventRow {
  timestamp: string | null
  from_email: string | null
  type: string | null
}

/**
 * Sender-domain family -> canonical channel key. Aligns with the channel
 * taxonomy the pipeline uses for linkSignal ('knot' | 'weddingwire' |
 * 'zola' | ...; see formLeadSourceToChannel in email/pipeline.ts).
 * `interactions` has no channel column — from_email + type is the honest
 * signal that exists on every row.
 */
export function deriveIngestionChannel(
  fromEmail: string | null,
  type: string | null,
): string {
  const e = (fromEmail ?? '').toLowerCase()
  if (e.includes('theknot')) return 'knot'
  if (e.includes('weddingwire')) return 'weddingwire'
  if (e.includes('zola')) return 'zola'
  if (e.includes('calendly')) return 'calendly'
  if (e.includes('honeybook')) return 'honeybook'
  if (type && type !== 'email') return type // sms / call / meeting
  return 'direct_email'
}

// ---------------------------------------------------------------------------
// Pure detector core (shared with scripts/backtest-ingestion-monitor.ts)
// ---------------------------------------------------------------------------

export interface ChannelVolumeStat {
  channel: string
  /** Inbound count in the trailing RECENT_WINDOW_DAYS ending at asOf. */
  recentCount: number
  /** Median 21-day count across the baseline windows. */
  baselineMedian: number
  /** recentCount / baselineMedian; null when baseline is 0. */
  ratio: number | null
  alerted: boolean
  severity: 'warning' | 'critical' | null
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Run the volume rule over a set of inbound interaction rows as of a given
 * instant. Pure — no DB, no clock. The backtest feeds it historical rows;
 * the cron feeds it a live query. Rows with timestamps after `asOf` are
 * ignored so the backtest can replay past days from today's table.
 */
export function computeChannelVolumeStats(
  rows: IngestionEventRow[],
  asOf: Date,
): ChannelVolumeStat[] {
  const asOfMs = asOf.getTime()
  const recentStartMs = asOfMs - RECENT_WINDOW_DAYS * DAY_MS

  // Per-channel event timestamps (ms), oldest data we care about only.
  const byChannel = new Map<string, number[]>()
  const minMs = asOfMs - LOOKBACK_DAYS * DAY_MS
  for (const r of rows) {
    if (!r.timestamp) continue
    const t = new Date(r.timestamp).getTime()
    if (Number.isNaN(t) || t < minMs || t > asOfMs) continue
    const ch = deriveIngestionChannel(r.from_email, r.type)
    const arr = byChannel.get(ch)
    if (arr) arr.push(t)
    else byChannel.set(ch, [t])
  }

  const stats: ChannelVolumeStat[] = []
  for (const [channel, times] of byChannel) {
    const countIn = (endMs: number): number => {
      const startMs = endMs - RECENT_WINDOW_DAYS * DAY_MS
      let n = 0
      for (const t of times) if (t > startMs && t <= endMs) n++
      return n
    }

    const recentCount = countIn(asOfMs)
    const baselineCounts: number[] = []
    for (let k = 0; k < BASELINE_SAMPLES; k++) {
      baselineCounts.push(countIn(recentStartMs - k * BASELINE_STEP_DAYS * DAY_MS))
    }
    const baselineMedian = median(baselineCounts)
    const ratio = baselineMedian > 0 ? recentCount / baselineMedian : null

    let severity: 'warning' | 'critical' | null = null
    if (baselineMedian >= MIN_BASELINE_MEDIAN && ratio !== null && ratio < ALERT_RATIO) {
      severity = ratio < CRITICAL_RATIO ? 'critical' : 'warning'
    }

    stats.push({
      channel,
      recentCount,
      baselineMedian,
      ratio,
      alerted: severity !== null,
      severity,
    })
  }

  // Stable ordering: alerting channels first, then by baseline size.
  stats.sort((a, b) =>
    Number(b.alerted) - Number(a.alerted) || b.baselineMedian - a.baselineMedian,
  )
  return stats
}

// ---------------------------------------------------------------------------
// DB read
// ---------------------------------------------------------------------------

/**
 * Pull the venue's inbound interactions for the detector lookback.
 * Paged — a busy venue can exceed PostgREST's 1000-row page.
 */
async function fetchInboundRows(
  venueId: string,
  asOf: Date,
): Promise<IngestionEventRow[]> {
  const supabase = createServiceClient()
  const sinceIso = new Date(asOf.getTime() - LOOKBACK_DAYS * DAY_MS).toISOString()
  const rows: IngestionEventRow[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('interactions')
      .select('timestamp, from_email, type')
      .eq('venue_id', venueId)
      .eq('direction', 'inbound')
      .gte('timestamp', sinceIso)
      .lte('timestamp', asOf.toISOString())
      .order('timestamp', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error(`[ingestion-monitor] Error fetching interactions:`, error.message)
      break
    }
    rows.push(...((data ?? []) as IngestionEventRow[]))
    if (!data || data.length < PAGE) break
  }
  return rows
}

// ---------------------------------------------------------------------------
// Alert writer
// ---------------------------------------------------------------------------

function channelLabel(channel: string): string {
  const labels: Record<string, string> = {
    knot: 'The Knot',
    weddingwire: 'WeddingWire',
    zola: 'Zola',
    calendly: 'Calendly',
    honeybook: 'HoneyBook',
    direct_email: 'Direct email',
    sms: 'SMS',
    call: 'Phone calls',
    meeting: 'Meetings',
  }
  return labels[channel] ?? channel.replace(/_/g, ' ')
}

function buildExplanation(stat: ChannelVolumeStat): string {
  const pct = stat.ratio !== null ? Math.round(stat.ratio * 100) : 0
  return (
    `${channelLabel(stat.channel)} inbound volume has collapsed to ${pct}% of its own ` +
    `baseline: ${stat.recentCount} messages in the last ${RECENT_WINDOW_DAYS} days vs a ` +
    `typical ${stat.baselineMedian} per ${RECENT_WINDOW_DAYS}-day window. When one channel ` +
    `goes quiet while others stay normal, the usual cause is an ingestion break ` +
    `(Gmail label/filter routing, sync scope, a platform relay format change) rather ` +
    `than real demand. The April-June 2026 Knot regression looked exactly like this.`
  )
}

interface WrittenAlert {
  id: string
  venue_id: string
  metric_name: string
  severity: string
}

/**
 * Detect + persist for one venue. Returns the alert rows written (created
 * or refreshed). No LLM calls — pure counting, so no cost-ceiling gate.
 */
export async function runIngestionVolumeMonitor(
  venueId: string,
  asOf: Date = new Date(),
): Promise<WrittenAlert[]> {
  const supabase = createServiceClient()
  const rows = await fetchInboundRows(venueId, asOf)
  const stats = computeChannelVolumeStats(rows, asOf)
  const written: WrittenAlert[] = []

  for (const stat of stats) {
    if (!stat.alerted || !stat.severity) continue

    const metricName = `${INGESTION_METRIC_PREFIX}${stat.channel}`
    const explanation = buildExplanation(stat)
    const causes = [
      {
        source: 'ingestion_volume',
        channel: stat.channel,
        recentCount: stat.recentCount,
        baselineMedian: stat.baselineMedian,
        windowDays: RECENT_WINDOW_DAYS,
        cause: `Inbound ${channelLabel(stat.channel)} messages stopped arriving at the usual rate.`,
        likelihood: 'high' as const,
        action:
          `Check the Gmail connection, label filters, and sync scope for ${channelLabel(stat.channel)} ` +
          `senders; then spot-check the source inbox directly for messages Bloom never captured.`,
      },
    ]

    // Idempotent per venue+channel — mirrors the availability-anomaly
    // upsert in intel/anomaly-detection.ts. While the drop persists we
    // refresh the open row daily instead of stacking duplicates; after an
    // acknowledge we stay quiet for REALERT_COOLDOWN_DAYS.
    const { data: existingRows, error: existingErr } = await supabase
      .from('anomaly_alerts')
      .select('id, acknowledged, created_at')
      .eq('venue_id', venueId)
      .eq('alert_type', INGESTION_ALERT_TYPE)
      .eq('metric_name', metricName)
      .order('created_at', { ascending: false })
      .limit(1)

    if (existingErr) {
      console.error(`[ingestion-monitor] Error checking existing alert:`, existingErr.message)
      continue
    }

    const existing = existingRows?.[0]
    if (existing) {
      if (!existing.acknowledged) {
        const { data: updated, error: updateErr } = await supabase
          .from('anomaly_alerts')
          .update({
            current_value: stat.recentCount,
            baseline_value: stat.baselineMedian,
            change_percent: stat.ratio !== null ? stat.ratio - 1 : null,
            severity: stat.severity,
            ai_explanation: explanation,
            causes,
            explanation_source: 'rule',
          })
          .eq('id', existing.id)
          .select('id, venue_id, metric_name, severity')
          .single()
        if (updateErr) {
          console.error(`[ingestion-monitor] Failed to update alert:`, updateErr.message)
          continue
        }
        if (updated) written.push(updated as WrittenAlert)
        continue
      }
      const ageDays =
        (asOf.getTime() - new Date(existing.created_at as string).getTime()) / DAY_MS
      if (ageDays < REALERT_COOLDOWN_DAYS) continue // operator saw it recently
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('anomaly_alerts')
      .insert({
        venue_id: venueId,
        alert_type: INGESTION_ALERT_TYPE,
        metric_name: metricName,
        current_value: stat.recentCount,
        baseline_value: stat.baselineMedian,
        change_percent: stat.ratio !== null ? stat.ratio - 1 : null,
        severity: stat.severity,
        ai_explanation: explanation,
        causes,
        acknowledged: false,
        explanation_source: 'rule',
      })
      .select('id, venue_id, metric_name, severity')
      .single()

    if (insertErr) {
      console.error(`[ingestion-monitor] Failed to insert alert:`, insertErr.message)
      continue
    }
    if (inserted) {
      written.push(inserted as WrittenAlert)
      console.log(
        `[ingestion-monitor] ${stat.severity.toUpperCase()}: ${stat.channel} volume ` +
          `${stat.recentCount}/${RECENT_WINDOW_DAYS}d vs baseline ${stat.baselineMedian} ` +
          `for venue ${venueId}`,
      )
    }
  }

  return written
}

/**
 * Run the monitor for every active venue. Per-venue failures are contained
 * so one venue can't nuke the cron tick (same shape as runAllVenueAnomalies).
 */
export async function runIngestionVolumeMonitorAllVenues(): Promise<
  Record<string, WrittenAlert[]>
> {
  const supabase = createServiceClient()
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('active', true)

  if (error || !venues || venues.length === 0) {
    console.warn('[ingestion-monitor] No active venues found')
    return {}
  }

  const results: Record<string, WrittenAlert[]> = {}
  for (const v of venues) {
    const id = v.id as string
    try {
      results[id] = await runIngestionVolumeMonitor(id)
    } catch (err) {
      console.error(`[ingestion-monitor] Failed for venue ${id}:`, err)
      results[id] = []
    }
  }
  return results
}
