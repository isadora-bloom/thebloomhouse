/**
 * Source-freshness monitor.
 *
 * For every `tracked_sources` row (graveyard=false) on a venue, this
 * service computes the current data-gap (days since the most-recent
 * marketing_spend upload for that source) and classifies it into one
 * of four buckets:
 *
 *   - fresh : current_gap_days < expected_cadence_days
 *   - warm  : >= cadence and < 1.5x cadence
 *   - hot   : >= 1.5x and < 3x cadence
 *   - cold  : >= 3x cadence
 *
 * The cron at /api/cron?job=source_freshness uses `reminder_due` to
 * decide which rows fire an admin_notifications row. The page at
 * /intel/sources/track shows the full report with badges.
 *
 * Suppression rules (anti-spam):
 *   - Don't fire if last_reminded_at < 7 days ago (one fire per week max).
 *   - Don't fire if last_dismissed_at < 14 days ago (coordinator
 *     explicitly waved it away — give them two weeks).
 *
 * The service deliberately does NOT mutate state; the caller (cron
 * handler) is responsible for stamping `last_reminded_at` after a
 * successful notification. Keeps the function easy to test + reusable
 * from /intel/sources read paths.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { getSourceLabel, SOURCE_REGISTRY } from '@/config/source-registry'

export type FreshnessStatus = 'fresh' | 'warm' | 'hot' | 'cold'

export interface FreshnessReport {
  venueId: string
  source_key: string
  source_label: string
  last_upload_at: string | null
  expected_cadence_days: number
  current_gap_days: number
  status: FreshnessStatus
  reminder_due: boolean
}

interface TrackedSourceRow {
  id: string
  venue_id: string
  source_key: string
  expected_cadence_days: number
  last_reminded_at: string | null
  last_dismissed_at: string | null
}

interface SpendRow {
  source: string | null
  // marketing_spend.month is a date column. For "last upload" we want
  // the most recent UPDATE, not just the month — so we pull updated_at.
  updated_at: string | null
  created_at: string | null
  month: string | null
}

const SEVEN_DAYS_MS = 7 * 86_400_000
const FOURTEEN_DAYS_MS = 14 * 86_400_000

function classify(gapDays: number, cadenceDays: number): FreshnessStatus {
  if (gapDays < cadenceDays) return 'fresh'
  if (gapDays < cadenceDays * 1.5) return 'warm'
  if (gapDays < cadenceDays * 3) return 'hot'
  return 'cold'
}

/**
 * Compute one freshness report per active tracked source for a venue.
 *
 * Returns an empty array if the venue has no tracked sources or every
 * tracked source is graveyard=true.
 */
export async function computeFreshnessReports(
  venueId: string,
  opts: { now?: Date } = {},
): Promise<FreshnessReport[]> {
  const now = opts.now ?? new Date()
  const supabase = createServiceClient()

  const { data: tracked, error: trackedErr } = await supabase
    .from('tracked_sources')
    .select('id, venue_id, source_key, expected_cadence_days, last_reminded_at, last_dismissed_at')
    .eq('venue_id', venueId)
    .eq('graveyard', false)

  if (trackedErr || !tracked || tracked.length === 0) {
    return []
  }

  const trackedRows = tracked as TrackedSourceRow[]
  const sourceKeys = trackedRows.map((r) => r.source_key)

  // Pull the most recent marketing_spend row per (venue_id, source).
  // We over-select (every spend row for the venue + listed sources) and
  // group in code — keeps the query simple and avoids per-source N+1.
  const { data: spendData, error: spendErr } = await supabase
    .from('marketing_spend')
    .select('source, updated_at, created_at, month')
    .eq('venue_id', venueId)
    .in('source', sourceKeys)
    .order('updated_at', { ascending: false })

  if (spendErr) {
    console.error('[source-freshness] spend lookup failed:', spendErr)
  }

  const latestBySource = new Map<string, string>()
  for (const row of (spendData ?? []) as SpendRow[]) {
    if (!row.source) continue
    const existing = latestBySource.get(row.source)
    // Use updated_at first, fall back to created_at, then to the
    // first-of-month month value as a last resort.
    const candidate =
      row.updated_at ??
      row.created_at ??
      (row.month ? new Date(row.month).toISOString() : null)
    if (!candidate) continue
    if (!existing || new Date(candidate).getTime() > new Date(existing).getTime()) {
      latestBySource.set(row.source, candidate)
    }
  }

  const reports: FreshnessReport[] = []
  for (const row of trackedRows) {
    const lastUploadAt = latestBySource.get(row.source_key) ?? null
    const cadence = row.expected_cadence_days

    let gapDays: number
    if (lastUploadAt) {
      gapDays = Math.floor((now.getTime() - new Date(lastUploadAt).getTime()) / 86_400_000)
    } else {
      // Never uploaded — measure from when tracking started so the
      // first reminder fires `cadence` days after opt-in, not immediately.
      // We approximate that by treating "no upload" as a gap equal to
      // cadence + 1 (one day past due). The page can show a clearer
      // "never uploaded" badge using last_upload_at === null.
      gapDays = cadence + 1
    }

    const status = classify(gapDays, cadence)
    const isStale = status !== 'fresh'

    let reminderDue = isStale
    if (reminderDue && row.last_reminded_at) {
      const sinceReminded = now.getTime() - new Date(row.last_reminded_at).getTime()
      if (sinceReminded < SEVEN_DAYS_MS) reminderDue = false
    }
    if (reminderDue && row.last_dismissed_at) {
      const sinceDismissed = now.getTime() - new Date(row.last_dismissed_at).getTime()
      if (sinceDismissed < FOURTEEN_DAYS_MS) reminderDue = false
    }

    reports.push({
      venueId: row.venue_id,
      source_key: row.source_key,
      source_label: getSourceLabel(row.source_key),
      last_upload_at: lastUploadAt,
      expected_cadence_days: cadence,
      current_gap_days: gapDays,
      status,
      reminder_due: reminderDue,
    })
  }

  return reports
}

/**
 * Format the suggested next-cadence message for the notification body.
 * Pure helper, exported for the cron + the UI to share copy.
 */
export function suggestNextCadence(report: FreshnessReport): string {
  if (report.last_upload_at === null) {
    return `You started tracking ${report.source_label} but have not uploaded any data yet. Drop the first month into the brain dump to start the scorecard.`
  }
  const months = Math.max(1, Math.round(report.expected_cadence_days / 30))
  const cadenceWord = months === 1 ? 'this month' : `the last ${months} months`
  return `Time to upload ${report.source_label} for ${cadenceWord}. The brain dump accepts CSVs, screenshots, or pasted numbers.`
}

/**
 * Convenience helper — returns just the source keys present in the
 * curated registry. Useful for filtering / validation in the page.
 */
export function knownRegistryKeys(): Set<string> {
  return new Set(SOURCE_REGISTRY.map((e) => e.key))
}
