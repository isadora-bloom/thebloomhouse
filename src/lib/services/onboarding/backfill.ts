/**
 * Onboarding backfill orchestrator (ARCH-18.2 / 18.3-C / 18.3-D /
 * LIMB-16.3).
 *
 * Computes per-category historical-coverage status for a venue +
 * persists into onboarding_backfill_progress so the
 * /onboarding/project Day 5 checklist + the Go Live gate can read it.
 *
 * For each category the orchestrator queries the canonical source-of-
 * truth table, finds (oldest, newest, row_count), and classifies:
 *   - not_started — zero rows
 *   - partial      — some rows but < 12mo coverage
 *   - complete     — >= 12mo coverage measured by (newest - oldest)
 *   - skipped      — coordinator opted out (preserved across re-runs)
 *
 * The aggregate readiness score is the % of categories at 'complete'
 * or 'skipped' (excluding 'not_started' from the denominator only when
 * there's a structural reason — see CATEGORY_REQUIRED).
 *
 * Pure helpers (computeStatus, scoreCoverage) are unit-testable.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const DAY_MS = 86_400_000
export const TWELVE_MONTHS_MS = 365 * DAY_MS

export type BackfillCategory =
  | 'email_history'
  | 'marketing_spend'
  | 'pricing_history'
  | 'absences'
  | 'property_state'
  | 'marketing_channels'
  | 'weather'
  | 'search_trends'
  | 'fred'
  | 'cultural_moments'

export type BackfillStatus = 'not_started' | 'partial' | 'complete' | 'skipped'

export interface CategoryCoverage {
  category: BackfillCategory
  status: BackfillStatus
  oldest_at: string | null
  newest_at: string | null
  row_count: number
  /** Days of coverage between oldest_at and newest_at; 0 when not_started. */
  coverage_days: number
  /** Free-text describing what the category needs (rendered in UI). */
  hint: string
}

/**
 * Categories required for the venue to count as backfilled. Some
 * categories (cultural_moments, fred) are nice-to-have — a venue can
 * Go Live without them. Required categories MUST hit complete or
 * skipped before the gate opens.
 */
const CATEGORY_REQUIRED: Record<BackfillCategory, boolean> = {
  email_history: true,
  marketing_spend: true,
  pricing_history: true,
  absences: false,         // optional — many venues have no historical absences
  property_state: false,   // optional — most venues haven't renovated
  marketing_channels: true,
  weather: true,
  search_trends: true,
  fred: false,             // optional — national series available cross-venue
  cultural_moments: false, // optional — coordinator-curated
}

/**
 * Per-category hints rendered in the UI. Tells the coordinator what
 * to do to move from not_started/partial → complete.
 */
const CATEGORY_HINTS: Record<BackfillCategory, string> = {
  email_history: 'Run 12-month Gmail backfill from /onboarding/project Day 1.',
  marketing_spend: 'Upload monthly ad-spend CSV via /portal/marketing-channels-config or paste into the Tell-Sage box.',
  pricing_history: 'Log each base-price + capacity change from the past 12 months on /agent/settings.',
  absences: 'Add coordinator absence windows on /portal/absences-config (optional — only if relevant).',
  property_state: 'Add renovation / closure / vendor-change windows on /portal/property-state-config (optional).',
  marketing_channels: 'Confirm each channel\'s activated_at on /portal/marketing-channels-config (Instagram since Q3, etc.).',
  weather: 'Trigger 12-month weather backfill via /api/onboarding/backfill?category=weather.',
  search_trends: 'Trigger 12-month SerpAPI trend backfill via /api/onboarding/backfill?category=search_trends.',
  fred: 'Auto-fetched by daily cron once activated (optional — national series, not venue-specific).',
  cultural_moments: 'Add any historical moments (royal wedding, viral aesthetic shift) on /intel/cultural-moments (optional).',
}

/**
 * Pure: classify a category given (rowCount, oldest, newest) tuple.
 * Returns the right status + the coverage_days metric for the UI.
 */
export function computeStatus(args: {
  rowCount: number
  oldest: Date | null
  newest: Date | null
  /** Coordinator-skipped marker preserved from previous evaluations. */
  isSkipped?: boolean
}): { status: BackfillStatus; coverage_days: number } {
  if (args.isSkipped) return { status: 'skipped', coverage_days: 0 }
  if (args.rowCount === 0 || !args.oldest || !args.newest) {
    return { status: 'not_started', coverage_days: 0 }
  }
  const coverage_days = Math.max(
    0,
    Math.floor((args.newest.getTime() - args.oldest.getTime()) / DAY_MS),
  )
  if (coverage_days >= 365) return { status: 'complete', coverage_days }
  return { status: 'partial', coverage_days }
}

/**
 * Pure: aggregate readiness score from per-category coverage.
 * Returns 0..100. Required categories drag the score; optional
 * categories add bonus when they're complete or skipped but don't
 * subtract when not_started.
 *
 * Calculation:
 *   required complete/skipped → +1 point per required category
 *   optional complete/skipped → +0.5 bonus per optional category
 *   denominator: required.length (so a venue with all required at
 *     complete + zero optional still scores 100; optional categories
 *     can push beyond but capped at 100)
 */
export function scoreCoverage(coverages: CategoryCoverage[]): number {
  let pointsEarned = 0
  let pointsRequired = 0
  for (const cov of coverages) {
    const isRequired = CATEGORY_REQUIRED[cov.category]
    const isComplete = cov.status === 'complete' || cov.status === 'skipped'
    if (isRequired) {
      pointsRequired += 1
      if (isComplete) pointsEarned += 1
    } else if (isComplete) {
      pointsEarned += 0.5  // bonus
    }
  }
  if (pointsRequired === 0) return 0
  return Math.min(100, Math.round((pointsEarned / pointsRequired) * 100))
}

interface DbRow {
  category: string
  status: string
  oldest_at: string | null
  newest_at: string | null
  row_count: number
  skipped_reason: string | null
}

/**
 * Query each canonical table for (count, min, max) and produce a
 * fresh CategoryCoverage. Persists into onboarding_backfill_progress
 * (upsert by venue+category).
 */
export async function refreshBackfillStatus(
  supabase: SupabaseClient,
  venueId: string,
): Promise<CategoryCoverage[]> {
  // Pull existing skipped flags first so we preserve coordinator opt-outs.
  const { data: existing } = await supabase
    .from('onboarding_backfill_progress')
    .select('category, status, skipped_reason')
    .eq('venue_id', venueId)
  const skippedSet = new Set(
    ((existing ?? []) as DbRow[])
      .filter((r) => r.status === 'skipped')
      .map((r) => r.category),
  )

  // Each category has its own (table, dateColumn) tuple. Build them
  // first as a registry so adding a new category later is a one-line
  // change here.
  const queries: Array<{
    category: BackfillCategory
    table: string
    dateColumn: string
    extraFilter?: { column: string; value: unknown }
  }> = [
    { category: 'email_history',     table: 'interactions',           dateColumn: 'timestamp' },
    { category: 'marketing_spend',   table: 'marketing_spend',        dateColumn: 'month' },
    { category: 'pricing_history',   table: 'pricing_history',        dateColumn: 'changed_at' },
    { category: 'absences',          table: 'coordinator_absences',   dateColumn: 'start_at' },
    { category: 'property_state',    table: 'venue_operational_state', dateColumn: 'start_at' },
    { category: 'marketing_channels', table: 'marketing_channels',    dateColumn: 'activated_at' },
    { category: 'weather',           table: 'weather_data',           dateColumn: 'date' },
    { category: 'search_trends',     table: 'search_trends',          dateColumn: 'week' },
    { category: 'fred',              table: 'fred_indicators',        dateColumn: 'observation_date' },
    { category: 'cultural_moments',  table: 'cultural_moments',       dateColumn: 'start_at',
      extraFilter: { column: 'status', value: 'confirmed' } },
  ]

  const out: CategoryCoverage[] = []
  for (const q of queries) {
    let oldest: Date | null = null
    let newest: Date | null = null
    let rowCount = 0
    try {
      // Most categories scope by venue_id. fred + cultural_moments
      // are global tables (no venue_id column).
      const isGlobal = q.table === 'fred_indicators' || q.table === 'cultural_moments'

      let baseQuery = supabase
        .from(q.table)
        .select(q.dateColumn, { count: 'exact', head: false })
        .order(q.dateColumn, { ascending: true })
        .limit(1)
      if (!isGlobal) baseQuery = baseQuery.eq('venue_id', venueId)
      if (q.extraFilter) baseQuery = baseQuery.eq(q.extraFilter.column, q.extraFilter.value)

      const { data: oldestData, count: cnt, error: oldestErr } = await baseQuery
      if (oldestErr) throw oldestErr

      rowCount = cnt ?? 0
      if (oldestData && oldestData.length > 0) {
        const v = (oldestData[0] as unknown as Record<string, string | null>)[q.dateColumn]
        oldest = v ? new Date(v) : null
      }

      if (rowCount > 0) {
        let newestQuery = supabase
          .from(q.table)
          .select(q.dateColumn)
          .order(q.dateColumn, { ascending: false })
          .limit(1)
        if (!isGlobal) newestQuery = newestQuery.eq('venue_id', venueId)
        if (q.extraFilter) newestQuery = newestQuery.eq(q.extraFilter.column, q.extraFilter.value)
        const { data: newestData, error: newestErr } = await newestQuery
        if (newestErr) throw newestErr
        if (newestData && newestData.length > 0) {
          const v = (newestData[0] as unknown as Record<string, string | null>)[q.dateColumn]
          newest = v ? new Date(v) : null
        }
      }
    } catch (err) {
      // Non-existent table (e.g. fred_observations on a project where
      // it hasn't shipped yet) → treat as not_started rather than
      // throwing the whole status check. The orchestrator stays
      // resilient to schema drift.
      console.warn(`[onboarding-backfill] ${q.category} (${q.table}) query failed:`, err instanceof Error ? err.message : err)
    }

    const isSkipped = skippedSet.has(q.category)
    const { status, coverage_days } = computeStatus({ rowCount, oldest, newest, isSkipped })

    out.push({
      category: q.category,
      status,
      oldest_at: oldest?.toISOString() ?? null,
      newest_at: newest?.toISOString() ?? null,
      row_count: rowCount,
      coverage_days,
      hint: CATEGORY_HINTS[q.category],
    })

    // Upsert into onboarding_backfill_progress. Skipped rows keep
    // their skipped_reason; non-skipped rows just get fresh status.
    if (!isSkipped) {
      await supabase
        .from('onboarding_backfill_progress')
        .upsert({
          venue_id: venueId,
          category: q.category,
          status,
          oldest_at: oldest?.toISOString() ?? null,
          newest_at: newest?.toISOString() ?? null,
          row_count: rowCount,
          last_evaluated_at: new Date().toISOString(),
        }, { onConflict: 'venue_id,category' })
    } else {
      // Skipped rows still get last_evaluated_at refreshed (so the
      // UI knows the orchestrator considered them) but keep
      // status='skipped' + the original skipped_reason.
      await supabase
        .from('onboarding_backfill_progress')
        .update({
          oldest_at: oldest?.toISOString() ?? null,
          newest_at: newest?.toISOString() ?? null,
          row_count: rowCount,
          last_evaluated_at: new Date().toISOString(),
        })
        .eq('venue_id', venueId)
        .eq('category', q.category)
    }
  }

  return out
}

/** Backfill score for the Go Live gate. 0-100. */
export async function computeBackfillScore(
  supabase: SupabaseClient,
  venueId: string,
): Promise<{ score: number; coverages: CategoryCoverage[]; categoriesRequired: BackfillCategory[] }> {
  const coverages = await refreshBackfillStatus(supabase, venueId)
  const score = scoreCoverage(coverages)
  const categoriesRequired = (Object.keys(CATEGORY_REQUIRED) as BackfillCategory[])
    .filter((k) => CATEGORY_REQUIRED[k])
  return { score, coverages, categoriesRequired }
}

/**
 * Coordinator manually marks a category as skipped (e.g., venue
 * brand-new with no historical pricing). Records reason + actor.
 */
export async function skipBackfillCategory(
  supabase: SupabaseClient,
  args: {
    venueId: string
    category: BackfillCategory
    reason: string
    skippedBy: string | null
  },
): Promise<void> {
  await supabase
    .from('onboarding_backfill_progress')
    .upsert({
      venue_id: args.venueId,
      category: args.category,
      status: 'skipped',
      skipped_reason: args.reason,
      skipped_by: args.skippedBy,
      last_evaluated_at: new Date().toISOString(),
    }, { onConflict: 'venue_id,category' })
}

// Pure helpers re-exported for unit tests.
export const __test__ = {
  computeStatus,
  scoreCoverage,
  CATEGORY_REQUIRED,
  CATEGORY_HINTS,
  TWELVE_MONTHS_MS,
}
