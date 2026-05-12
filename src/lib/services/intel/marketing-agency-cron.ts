/**
 * Bloom House — Wave 6E follow-up.
 *
 * Cron implementations for the agency tracker:
 *
 *   - agency-activity-sweep: detects new kpi_missed + report_late
 *     events and writes them to agency_activity_log, so the timeline
 *     self-populates between operator-entered notes.
 *
 *   - tbh-reports-monthly: walks every agency with an active
 *     engagement and generates an internal-mode TBH Report covering
 *     the prior calendar month, persisting to tbh_reports.
 *
 *   - agency-document-orphans: removes storage objects whose
 *     agency_documents row was soft-deleted >30 days ago.
 *
 * All three are idempotent and safe to re-run.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { computeKpiPerformance } from './marketing-agency-kpi-performance'
import {
  computeTbhReport,
  type TbhReportRow,
} from './marketing-agency-tbh-report'

const STORAGE_BUCKET = 'agency-documents'

// ===========================================================================
// agency-activity-sweep
// ===========================================================================

export interface ActivitySweepResult {
  agenciesScanned: number
  engagementsScanned: number
  kpiMissedWritten: number
  reportLateWritten: number
  errors: string[]
}

// Cadence string → days threshold. If the operator hasn't logged a
// report_received activity within this many days the report is "late".
const REPORT_LATE_THRESHOLD_DAYS: Record<string, number> = {
  weekly_email: 10,
  biweekly_call: 18,
  monthly_dashboard: 38,
  monthly_call: 38,
  quarterly_review: 100,
  on_demand: 365, // effectively never auto-flag
  other: 365,
}

const SUPPRESS_DUPLICATE_DAYS = 14

interface AgencyRow {
  id: string
  name: string
  org_id: string | null
  venue_id: string | null
}

interface EngagementRow {
  id: string
  agency_id: string
  venue_id: string
  reporting_cadence: string | null
}

interface RecentActivityRow {
  kind: string
  occurred_at: string
  payload: Record<string, unknown> | null
}

export async function runAgencyActivitySweep(): Promise<ActivitySweepResult> {
  const service = createServiceClient()
  const result: ActivitySweepResult = {
    agenciesScanned: 0,
    engagementsScanned: 0,
    kpiMissedWritten: 0,
    reportLateWritten: 0,
    errors: [],
  }

  // Walk all non-deleted agencies that have at least one active
  // engagement. No active engagement → nothing for this sweep to do.
  const { data: agencies } = await service
    .from('marketing_agencies')
    .select('id, name, org_id, venue_id')
    .is('deleted_at', null)
  if (!agencies || agencies.length === 0) return result

  const agencyById = new Map<string, AgencyRow>()
  for (const a of agencies as AgencyRow[]) agencyById.set(a.id, a)
  result.agenciesScanned = agencyById.size

  for (const agency of agencyById.values()) {
    // Active engagements for this agency.
    const { data: engagements } = await service
      .from('venue_agency_engagements')
      .select('id, agency_id, venue_id, reporting_cadence')
      .eq('agency_id', agency.id)
      .is('deleted_at', null)
      .is('ended_at', null)

    const engs = (engagements ?? []) as EngagementRow[]
    if (engs.length === 0) continue
    result.engagementsScanned += engs.length

    const venueIds = Array.from(new Set(engs.map((e) => e.venue_id)))

    // --- KPI-miss detection ---
    try {
      const kpiRows = await computeKpiPerformance({
        agencyId: agency.id,
        venueIds,
        windowDays: 90,
        includeRetired: false,
      })
      const missed = kpiRows.filter((r) => r.status === 'miss')
      if (missed.length > 0) {
        // Pull the most-recent kpi_missed entries for this agency so we
        // can suppress duplicates within SUPPRESS_DUPLICATE_DAYS.
        const since = new Date(
          Date.now() - SUPPRESS_DUPLICATE_DAYS * 86_400_000,
        ).toISOString()
        const { data: recent } = await service
          .from('agency_activity_log')
          .select('kind, occurred_at, payload')
          .eq('agency_id', agency.id)
          .gte('occurred_at', since)
          .eq('kind', 'kpi_missed')
          .is('deleted_at', null)
        const recentKpiIds = new Set<string>()
        for (const row of (recent ?? []) as RecentActivityRow[]) {
          const id = row.payload?.kpi_id
          if (typeof id === 'string') recentKpiIds.add(id)
        }
        for (const m of missed) {
          if (recentKpiIds.has(m.kpiId)) continue
          await service.from('agency_activity_log').insert({
            agency_id: agency.id,
            venue_id: venueIds[0] ?? null,
            kind: 'kpi_missed',
            summary: `KPI missed: ${m.metricDisplay} (target ${m.targetValue} ${m.targetUnit}/${m.targetWindow}, gap ${m.gapPct?.toFixed(0) ?? '?'}%)`,
            body: m.reasoning,
            payload: {
              kpi_id: m.kpiId,
              metric_name: m.metricName,
              target_value: m.targetValue,
              actual_value: m.actualValue,
              gap_pct: m.gapPct,
              status: m.status,
            },
            recorded_by: null,
          })
          result.kpiMissedWritten += 1
        }
      }
    } catch (err) {
      result.errors.push(
        `kpi_miss agency=${agency.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // --- Report-late detection ---
    try {
      for (const eng of engs) {
        const cadence = eng.reporting_cadence ?? null
        if (!cadence) continue
        const threshold = REPORT_LATE_THRESHOLD_DAYS[cadence] ?? null
        if (!threshold || threshold >= 365) continue

        // Pull last report_received OR report_late entry for this engagement.
        const { data: recent } = await service
          .from('agency_activity_log')
          .select('kind, occurred_at')
          .eq('agency_id', agency.id)
          .eq('engagement_id', eng.id)
          .in('kind', ['report_received', 'report_late'])
          .is('deleted_at', null)
          .order('occurred_at', { ascending: false })
          .limit(5)

        const last = (recent ?? []) as RecentActivityRow[]
        const lastReceived = last.find((r) => r.kind === 'report_received')
        const lastLate = last.find((r) => r.kind === 'report_late')

        const daysSinceReceived = lastReceived
          ? (Date.now() - new Date(lastReceived.occurred_at).getTime()) /
            86_400_000
          : Infinity
        const daysSinceLate = lastLate
          ? (Date.now() - new Date(lastLate.occurred_at).getTime()) /
            86_400_000
          : Infinity

        if (
          daysSinceReceived > threshold &&
          daysSinceLate > SUPPRESS_DUPLICATE_DAYS
        ) {
          await service.from('agency_activity_log').insert({
            agency_id: agency.id,
            engagement_id: eng.id,
            venue_id: eng.venue_id,
            kind: 'report_late',
            summary: `No ${cadence.replace(/_/g, ' ')} report received in ${Math.round(threshold)} days`,
            body: null,
            payload: {
              cadence,
              threshold_days: threshold,
              last_received_at: lastReceived?.occurred_at ?? null,
            },
            recorded_by: null,
          })
          result.reportLateWritten += 1
        }
      }
    } catch (err) {
      result.errors.push(
        `report_late agency=${agency.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return result
}

// ===========================================================================
// tbh-reports-monthly
// ===========================================================================

export interface MonthlyReportSweepResult {
  agenciesScanned: number
  reportsGenerated: number
  reportsSkipped: number
  errors: string[]
}

function priorMonthRange(): { start: string; end: string } {
  // Returns the first and last day of the calendar month before today.
  const now = new Date()
  const firstOfThisMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  )
  const lastOfPrior = new Date(firstOfThisMonth.getTime() - 86_400_000)
  const firstOfPrior = new Date(
    Date.UTC(lastOfPrior.getUTCFullYear(), lastOfPrior.getUTCMonth(), 1),
  )
  return {
    start: firstOfPrior.toISOString().slice(0, 10),
    end: lastOfPrior.toISOString().slice(0, 10),
  }
}

export async function runTbhReportsMonthly(): Promise<MonthlyReportSweepResult> {
  const service = createServiceClient()
  const result: MonthlyReportSweepResult = {
    agenciesScanned: 0,
    reportsGenerated: 0,
    reportsSkipped: 0,
    errors: [],
  }
  const period = priorMonthRange()

  const { data: agencies } = await service
    .from('marketing_agencies')
    .select('id, name')
    .is('deleted_at', null)
  if (!agencies || agencies.length === 0) return result

  for (const agency of agencies as Array<{ id: string; name: string }>) {
    result.agenciesScanned += 1
    try {
      // Walk active engagements to gather venue scope.
      const { data: engagements } = await service
        .from('venue_agency_engagements')
        .select('venue_id, ended_at, started_at')
        .eq('agency_id', agency.id)
        .is('deleted_at', null)
      const eligibleEngagements = (engagements ?? []).filter((e) => {
        // Engagement must overlap the period.
        const start = (e.started_at as string) ?? null
        const end = (e.ended_at as string) ?? null
        if (start && start > period.end) return false
        if (end && end < period.start) return false
        return true
      })
      if (eligibleEngagements.length === 0) {
        result.reportsSkipped += 1
        continue
      }
      const venueIds = Array.from(
        new Set(eligibleEngagements.map((e) => e.venue_id as string)),
      )

      // Skip if a report already exists for this exact period+mode (the
      // cron is idempotent; manual regeneration uses the same path).
      const { data: existing } = await service
        .from('tbh_reports')
        .select('id')
        .eq('agency_id', agency.id)
        .eq('mode', 'internal')
        .eq('period_start', period.start)
        .eq('period_end', period.end)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle()
      if (existing) {
        result.reportsSkipped += 1
        continue
      }

      const report: TbhReportRow = await computeTbhReport({
        agencyId: agency.id,
        venueIds,
        periodStart: period.start,
        periodEnd: period.end,
        mode: 'internal',
        generatedBy: null,
      })
      // Successful generate (even the "no data" stub counts as generated).
      void report
      result.reportsGenerated += 1
    } catch (err) {
      result.errors.push(
        `agency=${agency.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return result
}

// ===========================================================================
// agency-document-orphans
// ===========================================================================

export interface OrphanSweepResult {
  candidates: number
  removed: number
  errors: string[]
}

const ORPHAN_RETENTION_DAYS = 30

export async function runAgencyDocumentOrphans(): Promise<OrphanSweepResult> {
  const service = createServiceClient()
  const result: OrphanSweepResult = {
    candidates: 0,
    removed: 0,
    errors: [],
  }
  const cutoff = new Date(
    Date.now() - ORPHAN_RETENTION_DAYS * 86_400_000,
  ).toISOString()

  // Soft-deleted documents past the retention window.
  const { data: orphans } = await service
    .from('agency_documents')
    .select('id, file_url, deleted_at')
    .not('deleted_at', 'is', null)
    .lte('deleted_at', cutoff)
    .not('file_url', 'is', null)

  result.candidates = orphans?.length ?? 0
  if (!orphans || orphans.length === 0) return result

  // Group paths by 100 at a time (Supabase remove limit).
  const pathsToRemove = orphans
    .map((o) => o.file_url as string)
    .filter((p) => p && !/^https?:\/\//.test(p))

  for (let i = 0; i < pathsToRemove.length; i += 100) {
    const batch = pathsToRemove.slice(i, i + 100)
    const remove = await service.storage
      .from(STORAGE_BUCKET)
      .remove(batch)
    if (remove.error) {
      result.errors.push(remove.error.message)
      continue
    }
    result.removed += remove.data?.length ?? 0
  }
  return result
}
