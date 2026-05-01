/**
 * Bloom House: Anomaly Detection Service
 *
 * Compares current venue metrics against baselines (prior period of same length)
 * and generates alerts when deviations exceed thresholds.
 *
 * Metrics monitored:
 *   - inquiry_volume: count of new inquiries
 *   - response_time: avg minutes to first response
 *   - tour_conversion: tours / inquiries
 *   - booking_rate: bookings / tours
 *   - avg_booking_value: mean booking value
 *   - lost_deal_rate: lost / total inquiries
 *
 * For warning/critical severity, calls AI to explain probable causes
 * and suggest concrete actions.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Severity = 'info' | 'warning' | 'critical'

interface MetricConfig {
  threshold: number
  description: string
}

interface MetricValues {
  current: number
  baseline: number
}

interface AICause {
  cause: string
  likelihood: 'high' | 'medium' | 'low'
  action: string
}

interface AIExplanation {
  explanation: string
  causes: AICause[]
}

interface AnomalyAlert {
  id: string
  venue_id: string
  alert_type: string
  metric_name: string
  current_value: number
  baseline_value: number
  change_percent: number
  severity: Severity
  ai_explanation: string | null
  causes: AICause[] | null
  acknowledged: boolean
  created_at: string
  venues?: { name: string | null } | null
}

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

const METRICS: Record<string, MetricConfig> = {
  inquiry_volume: { threshold: 0.25, description: 'count of new inquiries' },
  response_time: { threshold: 1.0, description: 'avg minutes to first response' },
  tour_conversion: { threshold: 0.20, description: 'tours / inquiries ratio' },
  booking_rate: { threshold: 0.25, description: 'bookings / tours ratio' },
  avg_booking_value: { threshold: 0.20, description: 'average booking value' },
  lost_deal_rate: { threshold: 0.30, description: 'lost deals / total inquiries ratio' },
  engagement_rate: { threshold: 0.25, description: 'Engagement rate per inquiry' },
  // Connective tissue (gap G — 2026-04-30): Phase B metrics get
  // anomaly-monitored too. Big drops in candidate volume mean the
  // platform changed an export format or an integration broke.
  // Spikes in conflicts mean attribution rules need tuning. Drops
  // in auto-link rate mean the matching engine is mis-firing.
  candidate_volume: { threshold: 0.30, description: 'count of new platform-signal candidates' },
  attribution_conflict_rate: { threshold: 0.40, description: 'share of new attributions flagging conflicts vs legacy source' },
  auto_link_rate: { threshold: 0.25, description: 'share of new candidates auto-linked to leads (Tier 1 + Tier 2 AI)' },
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

// ---------------------------------------------------------------------------
// Metric queries
// ---------------------------------------------------------------------------

/**
 * Compute a single metric's value for a venue within a date range.
 * Returns null if the metric cannot be computed (e.g. no data in range).
 */
async function queryMetric(
  venueId: string,
  metricName: string,
  periodStart: string,
  periodEnd: string
): Promise<number | null> {
  const supabase = createServiceClient()

  switch (metricName) {
    // ----- inquiry_volume: count weddings with inquiry_date in period -----
    case 'inquiry_volume': {
      const { count, error } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)

      if (error) {
        console.error(`[anomaly] Error querying inquiry_volume:`, error.message)
        return null
      }
      return count ?? 0
    }

    // ----- response_time: avg (first_response_at - inquiry_date) in minutes -----
    case 'response_time': {
      const { data, error } = await supabase
        .from('weddings')
        .select('inquiry_date, first_response_at')
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)
        .not('first_response_at', 'is', null)

      if (error) {
        console.error(`[anomaly] Error querying response_time:`, error.message)
        return null
      }
      if (!data || data.length === 0) return null

      const totalMinutes = data.reduce((sum, row) => {
        const inquiry = new Date(row.inquiry_date as string).getTime()
        const response = new Date(row.first_response_at as string).getTime()
        return sum + (response - inquiry) / 60_000
      }, 0)

      return totalMinutes / data.length
    }

    // ----- tour_conversion: count(tour_date not null) / count(inquiry_date) -----
    case 'tour_conversion': {
      const { count: totalCount, error: totalError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)

      if (totalError) {
        console.error(`[anomaly] Error querying tour_conversion total:`, totalError.message)
        return null
      }
      if (!totalCount || totalCount === 0) return null

      const { count: tourCount, error: tourError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)
        .not('tour_date', 'is', null)

      if (tourError) {
        console.error(`[anomaly] Error querying tour_conversion tours:`, tourError.message)
        return null
      }

      return (tourCount ?? 0) / totalCount
    }

    // ----- booking_rate: count(booked_at not null) / count(tour_date not null) -----
    case 'booking_rate': {
      const { count: tourCount, error: tourError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)
        .not('tour_date', 'is', null)

      if (tourError) {
        console.error(`[anomaly] Error querying booking_rate tours:`, tourError.message)
        return null
      }
      if (!tourCount || tourCount === 0) return null

      const { count: bookedCount, error: bookedError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)
        .not('booked_at', 'is', null)

      if (bookedError) {
        console.error(`[anomaly] Error querying booking_rate bookings:`, bookedError.message)
        return null
      }

      return (bookedCount ?? 0) / tourCount
    }

    // ----- avg_booking_value: avg(booking_value) where booked_at in period -----
    case 'avg_booking_value': {
      const { data, error } = await supabase
        .from('weddings')
        .select('booking_value')
        .eq('venue_id', venueId)
        .gte('booked_at', periodStart)
        .lt('booked_at', periodEnd)
        .not('booking_value', 'is', null)

      if (error) {
        console.error(`[anomaly] Error querying avg_booking_value:`, error.message)
        return null
      }
      if (!data || data.length === 0) return null

      const total = data.reduce((sum, row) => sum + Number(row.booking_value), 0)
      return total / data.length
    }

    // ----- lost_deal_rate: count(status='lost') / count(*) in period -----
    case 'lost_deal_rate': {
      const { count: totalCount, error: totalError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)

      if (totalError) {
        console.error(`[anomaly] Error querying lost_deal_rate total:`, totalError.message)
        return null
      }
      if (!totalCount || totalCount === 0) return null

      const { count: lostCount, error: lostError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)
        .eq('status', 'lost')

      if (lostError) {
        console.error(`[anomaly] Error querying lost_deal_rate lost:`, lostError.message)
        return null
      }

      return (lostCount ?? 0) / totalCount
    }

    // ----- engagement_rate: engagement events / inquiry weddings -----
    // Connects the Agent's heat mapping data into anomaly detection.
    // A drop in engagement rate may indicate couples are losing interest
    // or the portal/emails aren't driving interaction.
    case 'engagement_rate': {
      // Use occurred_at (event time) not created_at (processing time)
      // per Playbook 12.2 + ANTI-2.6.4. Migration 089 added occurred_at
      // for exactly this reason — on backfilled venues, created_at
      // collapses every historical event to the import day.
      //
      // Filter direction='inbound' per INV-16. "Engagement rate" =
      // couple-side activity divided by inquiries. Outbound auto-sends
      // counted here would falsely lift the rate every time we replied
      // to anyone.
      const { count: engagementCount, error: engError } = await supabase
        .from('engagement_events')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('direction', 'inbound')
        .gte('occurred_at', periodStart)
        .lt('occurred_at', periodEnd)

      if (engError) {
        console.error(`[anomaly] Error querying engagement_rate events:`, engError.message)
        return null
      }

      const { count: inquiryCount, error: inqError } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .gte('inquiry_date', periodStart)
        .lt('inquiry_date', periodEnd)

      if (inqError) {
        console.error(`[anomaly] Error querying engagement_rate inquiries:`, inqError.message)
        return null
      }
      if (!inquiryCount || inquiryCount === 0) return null

      return (engagementCount ?? 0) / inquiryCount
    }

    // ----- candidate_volume: count of candidate_identities created -----
    // Excludes anonymous (which never become candidates) by virtue of
    // the table itself.
    case 'candidate_volume': {
      const { count, error } = await supabase
        .from('candidate_identities')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .is('deleted_at', null)
        .gte('first_seen', periodStart)
        .lt('first_seen', periodEnd)

      if (error) {
        console.error(`[anomaly] Error querying candidate_volume:`, error.message)
        return null
      }
      return count ?? 0
    }

    // ----- attribution_conflict_rate: conflict rows / total live attributions ----
    case 'attribution_conflict_rate': {
      const { count: total, error: totErr } = await supabase
        .from('attribution_events')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .is('reverted_at', null)
        .gte('decided_at', periodStart)
        .lt('decided_at', periodEnd)
      if (totErr) {
        console.error(`[anomaly] Error querying attribution_conflict_rate total:`, totErr.message)
        return null
      }
      if (!total || total === 0) return null

      const { count: conflictCount, error: cErr } = await supabase
        .from('attribution_events')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .is('reverted_at', null)
        .not('conflict_with_legacy_source', 'is', null)
        .gte('decided_at', periodStart)
        .lt('decided_at', periodEnd)
      if (cErr) {
        console.error(`[anomaly] Error querying attribution_conflict_rate conflicts:`, cErr.message)
        return null
      }
      return (conflictCount ?? 0) / total
    }

    // ----- auto_link_rate: candidates resolved this period / candidates created this period ----
    case 'auto_link_rate': {
      const { count: created, error: cErr } = await supabase
        .from('candidate_identities')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .is('deleted_at', null)
        .gte('first_seen', periodStart)
        .lt('first_seen', periodEnd)
      if (cErr) {
        console.error(`[anomaly] Error querying auto_link_rate created:`, cErr.message)
        return null
      }
      if (!created || created === 0) return null

      const { count: resolved, error: rErr } = await supabase
        .from('candidate_identities')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .is('deleted_at', null)
        .gte('first_seen', periodStart)
        .lt('first_seen', periodEnd)
        .not('resolved_wedding_id', 'is', null)
      if (rErr) {
        console.error(`[anomaly] Error querying auto_link_rate resolved:`, rErr.message)
        return null
      }
      return (resolved ?? 0) / created
    }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// AI explanation
// ---------------------------------------------------------------------------

/**
 * Internal Context bundle threaded into the AI hypothesis prompt
 * (T2-B Phase 2 / LIMB-16.2.1-3). Pre-T2-B the AI prompt had nothing
 * but the metric numbers — so it always defaulted to funnel-shape
 * causes regardless of whether a coordinator was on vacation, the
 * venue was mid-renovation, or pricing had changed. This bundle
 * provides the real-world causal context the AI should weigh first.
 */
interface InternalContextBundle {
  /** Coordinator absences whose window overlaps the analysis period. */
  absences: Array<{
    consultant: string | null
    reason: string
    startAt: string
    endAt: string
    handoff: string | null
  }>
  /** Property-level state windows (renovation, closure, vendor change,
   *  policy change, force-majeure) overlapping the analysis period. */
  operationalState: Array<{
    type: string
    title: string
    description: string | null
    affectedSpace: string | null
    startAt: string
    endAt: string | null
  }>
  /** Pricing changes (base_price, capacity, calculator config) that
   *  landed within the analysis window. */
  pricingChanges: Array<{
    field: string
    oldValue: unknown
    newValue: unknown
    changedAt: string
    notes: string | null
  }>
  /** Active marketing channels for this venue. Lets the AI consider
   *  channel-mix shifts in its hypotheses. */
  marketingChannels: Array<{ key: string; label: string; category: string | null }>
}

async function loadInternalContextForAnomaly(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  periodStart: string,
  periodEnd: string,
): Promise<InternalContextBundle> {
  const [absRes, stateRes, priceRes, channelRes] = await Promise.all([
    // Absences whose window OVERLAPS the analysis period.
    // Overlap = NOT (end < periodStart OR start > periodEnd).
    supabase
      .from('coordinator_absences')
      .select('assigned_consultant_id, reason, start_at, end_at, handoff_notes')
      .eq('venue_id', venueId)
      .is('deleted_at', null)
      .lte('start_at', periodEnd)
      .gte('end_at', periodStart),
    // Operational state windows overlapping. end_at IS NULL = ongoing,
    // implicitly overlaps any periodEnd.
    supabase
      .from('venue_operational_state')
      .select('state_type, start_at, end_at, title, description, affected_space')
      .eq('venue_id', venueId)
      .is('deleted_at', null)
      .lte('start_at', periodEnd)
      .or(`end_at.is.null,end_at.gte.${periodStart}`),
    // Pricing changes inside the period.
    supabase
      .from('pricing_history')
      .select('field_name, old_value, new_value, changed_at, notes')
      .eq('venue_id', venueId)
      .gte('changed_at', periodStart)
      .lte('changed_at', periodEnd)
      .order('changed_at', { ascending: false })
      .limit(10),
    // All active marketing channels.
    supabase
      .from('marketing_channels')
      .select('key, label, category')
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .is('deleted_at', null)
      .limit(40),
  ])

  // Resolve consultant names for absences. Best-effort — null on miss.
  const consultantIds = ((absRes.data ?? []) as Array<{ assigned_consultant_id: string | null }>)
    .map((a) => a.assigned_consultant_id)
    .filter((v): v is string => Boolean(v))
  const nameMap = new Map<string, string>()
  if (consultantIds.length > 0) {
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name')
      .in('id', consultantIds)
    for (const p of (profiles ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
      if (name) nameMap.set(p.id, name)
    }
  }

  return {
    absences: ((absRes.data ?? []) as Array<{
      assigned_consultant_id: string | null
      reason: string
      start_at: string
      end_at: string
      handoff_notes: string | null
    }>).map((a) => ({
      consultant: a.assigned_consultant_id ? nameMap.get(a.assigned_consultant_id) ?? 'Unknown coordinator' : null,
      reason: a.reason,
      startAt: a.start_at,
      endAt: a.end_at,
      handoff: a.handoff_notes,
    })),
    operationalState: ((stateRes.data ?? []) as Array<{
      state_type: string
      title: string
      description: string | null
      affected_space: string | null
      start_at: string
      end_at: string | null
    }>).map((s) => ({
      type: s.state_type,
      title: s.title,
      description: s.description,
      affectedSpace: s.affected_space,
      startAt: s.start_at,
      endAt: s.end_at,
    })),
    pricingChanges: ((priceRes.data ?? []) as Array<{
      field_name: string
      old_value: unknown
      new_value: unknown
      changed_at: string
      notes: string | null
    }>).map((p) => ({
      field: p.field_name,
      oldValue: p.old_value,
      newValue: p.new_value,
      changedAt: p.changed_at,
      notes: p.notes,
    })),
    marketingChannels: ((channelRes.data ?? []) as Array<{
      key: string
      label: string
      category: string | null
    }>),
  }
}

function formatInternalContextForPrompt(ctx: InternalContextBundle): string {
  const parts: string[] = []
  if (ctx.absences.length > 0) {
    parts.push('Coordinator absences during this period:')
    for (const a of ctx.absences) {
      const who = a.consultant ?? 'Whole venue'
      const handoff = a.handoff ? ` (handoff: ${a.handoff})` : ''
      parts.push(`  - ${who} — ${a.reason} (${a.startAt} → ${a.endAt})${handoff}`)
    }
  }
  if (ctx.operationalState.length > 0) {
    parts.push('Property operational state during this period:')
    for (const s of ctx.operationalState) {
      const space = s.affectedSpace ? ` [${s.affectedSpace}]` : ''
      const desc = s.description ? ` — ${s.description}` : ''
      const end = s.endAt ?? 'ongoing'
      parts.push(`  - [${s.type}] ${s.title}${space} (${s.startAt} → ${end})${desc}`)
    }
  }
  if (ctx.pricingChanges.length > 0) {
    parts.push('Pricing changes during this period:')
    for (const p of ctx.pricingChanges) {
      const old = JSON.stringify(p.oldValue)
      const next = JSON.stringify(p.newValue)
      const note = p.notes ? ` (${p.notes})` : ''
      parts.push(`  - ${p.field}: ${old} → ${next} on ${p.changedAt}${note}`)
    }
  }
  if (ctx.marketingChannels.length > 0) {
    const labels = ctx.marketingChannels.map((c) => `${c.label} [${c.key}]`).join(', ')
    parts.push(`Active marketing channels: ${labels}`)
  }
  if (parts.length === 0) {
    return 'Internal context: none logged for this period.'
  }
  return parts.join('\n')
}

/**
 * Ask AI to explain a metric anomaly and suggest causes + actions.
 *
 * T2-B Phase 2: now threads Internal Context (absences, operational
 * state, pricing changes, marketing channels) into the prompt so the
 * hypothesis chain weighs real-world causes BEFORE chasing funnel
 * shape. Per Playbook LIMB-16.2.1-3 + ARCH-19.4.
 */
async function getAIExplanation(
  venueId: string,
  metricName: string,
  currentValue: number,
  baselineValue: number,
  changePercent: number,
  periodStart: string,
  periodEnd: string,
): Promise<AIExplanation | null> {
  try {
    const supabase = createServiceClient()
    const internalCtx = await loadInternalContextForAnomaly(
      supabase, venueId, periodStart, periodEnd,
    )
    const internalCtxBlock = formatInternalContextForPrompt(internalCtx)

    const result = await callAIJson<AIExplanation>({
      systemPrompt: `You are a wedding venue operations analyst. When given a metric anomaly,
provide a concise explanation and 2-3 possible causes ranked by likelihood, each with one
concrete action the venue team can take this week.

If the venue's Internal Context (coordinator absences, property state changes, pricing
changes, marketing channels) is provided, weigh those causes BEFORE generic funnel shape
explanations. A coordinator on vacation explains a response-time drop better than
"funnel issues" does.

Return JSON with this exact shape:
{
  "explanation": "Brief plain-English summary of what the anomaly means",
  "causes": [
    {
      "cause": "Description of the possible cause",
      "likelihood": "high" | "medium" | "low",
      "action": "One specific action to investigate or address this"
    }
  ]
}

Be specific to the wedding venue industry. Reference seasonality, marketing channels,
competitor behavior, and operational factors where relevant.`,

      userPrompt: `Anomaly detected for a wedding venue:

Metric: ${metricName} (${METRICS[metricName]?.description ?? metricName})
Current period value: ${formatMetricValue(metricName, currentValue)}
Baseline (prior period): ${formatMetricValue(metricName, baselineValue)}
Change: ${changePercent > 0 ? '+' : ''}${(changePercent * 100).toFixed(1)}%
Analysis window: ${periodStart} → ${periodEnd}

${internalCtxBlock}

Provide 2-3 possible causes ranked by likelihood, each with one concrete action.
Weight Internal Context findings heavily — if a coordinator was out, the venue was
in renovation, or pricing changed, those are more likely than generic funnel causes.`,

      maxTokens: 600,
      temperature: 0.3,
      venueId,
      taskType: 'anomaly_explanation',
    })

    return result
  } catch (err) {
    console.error(`[anomaly] AI explanation failed for ${metricName}:`, err)
    return null
  }
}

/**
 * Format a metric value for display in the AI prompt.
 */
function formatMetricValue(metricName: string, value: number): string {
  switch (metricName) {
    case 'inquiry_volume':
      return `${Math.round(value)} inquiries`
    case 'response_time':
      return `${Math.round(value)} minutes`
    case 'tour_conversion':
    case 'booking_rate':
    case 'lost_deal_rate':
      return `${(value * 100).toFixed(1)}%`
    case 'avg_booking_value':
      return `$${Math.round(value).toLocaleString()}`
    case 'engagement_rate':
      return `${(value * 100).toFixed(1)}% engagement per inquiry`
    case 'candidate_volume':
      return `${Math.round(value)} new candidates`
    case 'attribution_conflict_rate':
      return `${(value * 100).toFixed(1)}% of attributions flagged conflict`
    case 'auto_link_rate':
      return `${(value * 100).toFixed(1)}% of candidates auto-linked`
    default:
      return String(value)
  }
}

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Run anomaly detection for a single venue. Compares the last `periodDays`
 * against the prior period of equal length. Creates alerts for any metric
 * where the change exceeds its threshold.
 *
 * Severity logic:
 *   |change| > threshold * 2  → 'critical'
 *   |change| > threshold      → 'warning'
 *   otherwise                 → skip (no alert)
 *
 * For warning/critical, calls AI to explain causes.
 * Returns the array of created alert rows.
 */
export async function runAnomalyDetection(
  venueId: string,
  periodDays = 7
): Promise<AnomalyAlert[]> {
  const now = new Date().toISOString()
  const periodStart = daysAgo(periodDays)
  const baselineStart = daysAgo(periodDays * 2)

  const createdAlerts: AnomalyAlert[] = []
  const supabase = createServiceClient()

  for (const [metricName, config] of Object.entries(METRICS)) {
    // Query current and baseline periods
    const [current, baseline] = await Promise.all([
      queryMetric(venueId, metricName, periodStart, now),
      queryMetric(venueId, metricName, baselineStart, periodStart),
    ])

    // Skip if either period has no data
    if (current === null || baseline === null) continue

    // Compute change percent (avoid division by zero)
    if (baseline === 0) continue
    const changePercent = (current - baseline) / baseline
    const absChange = Math.abs(changePercent)

    // Determine severity
    let severity: Severity
    if (absChange > config.threshold * 2) {
      severity = 'critical'
    } else if (absChange > config.threshold) {
      severity = 'warning'
    } else {
      continue // Within normal range — no alert
    }

    // Get AI explanation for warning/critical
    const aiResult = await getAIExplanation(
      venueId,
      metricName,
      current,
      baseline,
      changePercent,
      periodStart,
      now,
    )

    // Determine alert type based on direction
    const direction = changePercent > 0 ? 'increase' : 'decrease'
    const alertType = `${metricName}_${direction}`

    // Insert the alert
    const { data, error } = await supabase
      .from('anomaly_alerts')
      .insert({
        venue_id: venueId,
        alert_type: alertType,
        metric_name: metricName,
        current_value: current,
        baseline_value: baseline,
        change_percent: changePercent,
        severity,
        ai_explanation: aiResult?.explanation ?? null,
        causes: aiResult?.causes ?? null,
        acknowledged: false,
      })
      .select()
      .single()

    if (error) {
      console.error(`[anomaly] Failed to insert alert for ${metricName}:`, error.message)
      continue
    }

    createdAlerts.push(data as AnomalyAlert)

    console.log(
      `[anomaly] ${severity.toUpperCase()} alert: ${metricName} ` +
        `${direction} ${(absChange * 100).toFixed(1)}% for venue ${venueId}`
    )
  }

  return createdAlerts
}

// ---------------------------------------------------------------------------
// Availability anomaly detection
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface MonthBucket {
  year: number
  month: number // 0-indexed
  bookedSlots: number
  totalSlots: number
  saturdayBooked: number
  saturdayTotal: number
  nonSatBooked: number
  nonSatTotal: number
  earliestDate: Date
}

/**
 * Detect seasonal availability anomalies: months with unusually high demand,
 * or months where Saturdays are filling fast while weekdays remain wide open.
 *
 * Reads venue_availability for the next 12 months. Uses static templates for
 * ai_explanation (no AI call). Idempotent via causes->>'source'='availability'
 * + causes->>'month' lookup. No-ops cleanly if the venue has no availability
 * rows yet (the data may simply not have been touched by the coordinator).
 */
export async function detectAvailabilityAnomalies(
  venueId: string
): Promise<AnomalyAlert[]> {
  const supabase = createServiceClient()
  const createdAlerts: AnomalyAlert[] = []

  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setMonth(end.getMonth() + 12)

  const startIso = start.toISOString().slice(0, 10)
  const endIso = end.toISOString().slice(0, 10)

  const { data: rows, error } = await supabase
    .from('venue_availability')
    .select('date, status, max_events, booked_count')
    .eq('venue_id', venueId)
    .gte('date', startIso)
    .lt('date', endIso)

  if (error) {
    console.error(`[anomaly] Error querying venue_availability:`, error.message)
    return []
  }
  if (!rows || rows.length === 0) {
    // Nothing to analyse. Stay quiet, don't throw.
    return []
  }

  // Group rows by calendar month, tallying booked vs capacity per month and
  // separately for Saturdays vs non-Saturdays.
  const buckets = new Map<string, MonthBucket>()
  for (const r of rows) {
    const date = new Date(r.date as string)
    if (isNaN(date.getTime())) continue

    const year = date.getUTCFullYear()
    const month = date.getUTCMonth()
    const key = `${year}-${String(month + 1).padStart(2, '0')}`

    const max = Math.max(1, Number(r.max_events) || 1)
    const booked = Math.min(max, Math.max(0, Number(r.booked_count) || 0))
    const isSaturday = date.getUTCDay() === 6

    let b = buckets.get(key)
    if (!b) {
      b = {
        year,
        month,
        bookedSlots: 0,
        totalSlots: 0,
        saturdayBooked: 0,
        saturdayTotal: 0,
        nonSatBooked: 0,
        nonSatTotal: 0,
        earliestDate: date,
      }
      buckets.set(key, b)
    }
    b.bookedSlots += booked
    b.totalSlots += max
    if (isSaturday) {
      b.saturdayBooked += booked
      b.saturdayTotal += max
    } else {
      b.nonSatBooked += booked
      b.nonSatTotal += max
    }
    if (date < b.earliestDate) b.earliestDate = date
  }

  const msPerDay = 24 * 60 * 60 * 1000

  for (const [key, b] of buckets.entries()) {
    if (b.totalSlots <= 0) continue

    const monthName = MONTH_NAMES[b.month]
    const fillRate = b.bookedSlots / b.totalSlots
    const daysOut = Math.round((b.earliestDate.getTime() - now.getTime()) / msPerDay)

    // Rule A: overall fill > 80% with the month still more than 60 days out.
    const isHighDemand = fillRate > 0.80 && daysOut > 60

    // Rule B: Saturdays > 90% filled AND non-Saturdays < 30%.
    const satFill = b.saturdayTotal > 0 ? b.saturdayBooked / b.saturdayTotal : 0
    const nonSatFill = b.nonSatTotal > 0 ? b.nonSatBooked / b.nonSatTotal : 0
    const isSaturdayDemand =
      b.saturdayTotal > 0 &&
      b.nonSatTotal > 0 &&
      satFill > 0.90 &&
      nonSatFill < 0.30

    // Prefer the more specific Saturday signal over the general one when both
    // trip, so the venue sees one actionable alert, not two.
    let alertType: string | null = null
    let explanation: string | null = null
    if (isSaturdayDemand) {
      alertType = 'availability_saturday_demand'
      explanation = `Saturdays in ${monthName} are filling fast; weekdays still wide open.`
    } else if (isHighDemand) {
      alertType = 'availability_high_demand'
      explanation =
        `Unusually high demand for ${monthName} dates. ` +
        `Currently ${b.bookedSlots}/${b.totalSlots} slots filled.`
    }

    if (!alertType || !explanation) continue

    // Idempotent upsert: look for an existing row with the same source+month.
    const { data: existing, error: existingErr } = await supabase
      .from('anomaly_alerts')
      .select('id, acknowledged')
      .eq('venue_id', venueId)
      .eq('alert_type', alertType)
      .filter('causes->>source', 'eq', 'availability')
      .filter('causes->>month', 'eq', key)
      .limit(1)

    if (existingErr) {
      console.error(`[anomaly] Error checking availability alert:`, existingErr.message)
      continue
    }

    const causes = [
      {
        source: 'availability',
        month: key,
        monthName,
        fillRate: Number(fillRate.toFixed(3)),
        saturdayFillRate: Number(satFill.toFixed(3)),
        nonSaturdayFillRate: Number(nonSatFill.toFixed(3)),
        bookedSlots: b.bookedSlots,
        totalSlots: b.totalSlots,
        action: isSaturdayDemand
          ? `Promote weekday weddings in ${monthName} or consider a Friday/Sunday incentive.`
          : `Review pricing and inventory for ${monthName} before the remaining dates sell out.`,
      },
    ]

    const severity: Severity = isSaturdayDemand || fillRate > 0.90 ? 'warning' : 'info'

    if (existing && existing.length > 0) {
      const { data: updated, error: updateErr } = await supabase
        .from('anomaly_alerts')
        .update({
          current_value: b.bookedSlots,
          baseline_value: b.totalSlots,
          change_percent: fillRate,
          severity,
          ai_explanation: explanation,
          causes,
        })
        .eq('id', existing[0].id)
        .select()
        .single()

      if (updateErr) {
        console.error(`[anomaly] Failed to update availability alert:`, updateErr.message)
        continue
      }
      if (updated) createdAlerts.push(updated as AnomalyAlert)
      continue
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('anomaly_alerts')
      .insert({
        venue_id: venueId,
        alert_type: alertType,
        metric_name: 'availability_fill_rate',
        current_value: b.bookedSlots,
        baseline_value: b.totalSlots,
        change_percent: fillRate,
        severity,
        ai_explanation: explanation,
        causes,
        acknowledged: false,
      })
      .select()
      .single()

    if (insertErr) {
      console.error(`[anomaly] Failed to insert availability alert:`, insertErr.message)
      continue
    }
    if (inserted) createdAlerts.push(inserted as AnomalyAlert)
  }

  return createdAlerts
}

// ---------------------------------------------------------------------------
// Run for all venues
// ---------------------------------------------------------------------------

/**
 * Run anomaly detection for every active venue.
 * Returns a map of venueId -> array of created alerts.
 */
export async function runAllVenueAnomalies(): Promise<Record<string, AnomalyAlert[]>> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .eq('active', true)

  if (error || !venues || venues.length === 0) {
    console.warn('[anomaly] No active venues found')
    return {}
  }

  // Cost-ceiling gate: skip venues whose autonomous behavior is
  // paused (cost ceiling reached or coordinator override). Anomaly
  // detection fires LLM hypothesis generation per metric per venue
  // — proactive insights — exactly the kind of work the playbook says
  // to pause when a venue hits 100% ceiling. OPS-21.4.3.
  const venueIds = venues.map((v) => v.id as string)
  const { filterActiveVenues } = await import('@/lib/services/cost-ceiling')
  const { active, skipped } = await filterActiveVenues(venueIds)
  if (skipped.length > 0) {
    console.log(`[anomaly] Skipping ${skipped.length} paused venue(s); running ${active.length}`)
  }

  const results: Record<string, AnomalyAlert[]> = {}

  for (const id of active) {
    const metricAlerts = await runAnomalyDetection(id)

    // Availability anomalies are additive: they live in the same table so
    // they surface alongside metric anomalies on the dashboard + /intel/anomalies.
    // Guarded so a single venue's failure can't nuke the whole cron run.
    let availabilityAlerts: AnomalyAlert[] = []
    try {
      availabilityAlerts = await detectAvailabilityAnomalies(id)
    } catch (err) {
      console.error(`[anomaly] Availability detection failed for venue ${id}:`, err)
    }

    results[id] = [...metricAlerts, ...availabilityAlerts]
  }

  return results
}

// ---------------------------------------------------------------------------
// Alert queries
// ---------------------------------------------------------------------------

/**
 * Get all unacknowledged alerts for a venue, most recent first.
 */
export async function getActiveAlerts(venueId: string): Promise<AnomalyAlert[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('anomaly_alerts')
    .select('*, venues:venue_id(name)')
    .eq('venue_id', venueId)
    .eq('acknowledged', false)
    .order('created_at', { ascending: false })

  if (error) {
    console.error(`[anomaly] Error fetching active alerts:`, error.message)
    return []
  }

  return (data ?? []) as AnomalyAlert[]
}

/**
 * Mark an alert as acknowledged by a specific user.
 */
export async function acknowledgeAlert(
  alertId: string,
  userId: string
): Promise<boolean> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('anomaly_alerts')
    .update({
      acknowledged: true,
      acknowledged_by: userId,
    })
    .eq('id', alertId)

  if (error) {
    console.error(`[anomaly] Error acknowledging alert ${alertId}:`, error.message)
    return false
  }

  return true
}
