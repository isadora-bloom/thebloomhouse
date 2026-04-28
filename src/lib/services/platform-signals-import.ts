/**
 * Platform-signals importer — universal path for CSV → tangential_signals.
 *
 * Phase A of the platform-signals build (2026-04-28). Replaces
 * importPlatformActivity (which routed to engagement_events with
 * wedding_id=NULL — the dead-end identified by the audit on the real
 * Rixey Knot CSV). One code path now serves every platform CSV: Knot
 * visitor activities, WeddingWire engagements, Instagram followers,
 * Pinterest saves, Google Business interactions, Facebook page
 * activity. Phase B's matching engine reads from tangential_signals,
 * so this is the inflow that feeds first-touch reattribution.
 *
 * Per row we capture EVERYTHING (raw_row included) so Phase B has
 * whatever it needs without re-importing. extracted_identity carries
 * the parsed first_name / last_initial / last_name / username /
 * city / state / country / email and the raw_row jsonb.
 *
 * Dedup contract: (venue_id, source_platform, action_class,
 * extracted_identity->>name_raw, signal_date). Two identical rows from
 * a re-import never duplicate. Rows where parseVendorDate failed have
 * signal_date=null and dedup falls back to (platform, action, name)
 * — coarser, but a re-import of a date-parse-failure CSV will still
 * collapse to the same set of rows.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PlatformDetector, UniversalSignalRow } from './platform-detectors/types'

export interface PlatformSignalsImportSummary {
  inserted: number
  skipped_duplicate: number
  skipped_unparseable_date: number
  skipped_empty_name: number
  errors: string[]
  /** Per action_class breakdown for sanity in the import summary UI. */
  by_action: Record<string, number>
  /** Per signal_type-future-bridge: which actions had a parsed signal_date
   *  vs not. Used to decide whether the import is good-enough for ROI. */
  date_parse_rate: { parsed: number; unparseable: number }
}

interface ImportArgs {
  supabase: SupabaseClient
  venueId: string
  detector: PlatformDetector
  headers: readonly string[]
  rows: readonly string[][]
  /** Optional brain_dump_entries.id — stored for audit trail and re-runs. */
  brainDumpEntryId?: string
}

/**
 * Map a UniversalSignalRow.action_class to a tangential_signals.signal_type
 * value that's compatible with the existing CHECK enum (migration 085).
 * The new action_class column carries the precise semantics; signal_type
 * stays in the existing enum for back-compat with old readers.
 */
function actionClassToSignalType(actionClass: string, platform: string): string {
  // Instagram-specific bridges — preserve the existing enum where it
  // matched.
  if (platform === 'instagram') {
    if (actionClass === 'follow') return 'instagram_follow'
    if (['like', 'comment', 'mention'].includes(actionClass)) return 'instagram_engagement'
  }
  // Reviews keep their own bucket.
  if (actionClass === 'review') return 'review'
  // Anything else — we don't have a precise pre-existing bucket, so
  // 'analytics_entry' for views/saves/clicks (these are platform
  // analytics-style signals), 'mention' for mentions, 'other' for
  // outliers.
  if (['view', 'save', 'click', 'visit', 'message', 'inquiry', 'call'].includes(actionClass)) {
    return 'analytics_entry'
  }
  if (actionClass === 'mention') return 'mention'
  return 'other'
}

export async function importPlatformSignals(args: ImportArgs): Promise<PlatformSignalsImportSummary> {
  const { supabase, venueId, detector, headers, rows, brainDumpEntryId } = args
  const summary: PlatformSignalsImportSummary = {
    inserted: 0,
    skipped_duplicate: 0,
    skipped_unparseable_date: 0,
    skipped_empty_name: 0,
    errors: [],
    by_action: {},
    date_parse_rate: { parsed: 0, unparseable: 0 },
  }

  // Map every row first so we can see the parse rate before writing.
  const mapped: UniversalSignalRow[] = []
  for (const row of rows) {
    try {
      mapped.push(detector.mapRow(headers, row))
    } catch (err) {
      summary.errors.push(`row map failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Build dedup key Set in ONE paginated query, not per-row. Per-row
  // was the first cut and it died on a 1542-row Knot CSV — 3000+
  // remote round trips. The natural key is (action_class, name_raw,
  // signal_date) scoped to venue + platform.
  //
  // signal_date round-trips as a timestamptz (e.g. "2026-03-30T00:00:00+00:00")
  // but inserts use date-only ISO ("2026-03-30"). Normalize to first
  // 10 chars on both sides so the keys collide.
  //
  // Supabase JS defaults SELECT to 1000 rows. Paginate via .range()
  // so dedup stays correct once the table grows past 1000.
  const normDate = (d: string | null | undefined): string => (d ? String(d).slice(0, 10) : '')
  const dedupKey = (action: string, name: string, date: string | null | undefined) =>
    `${action}|${name}|${normDate(date)}`

  const existingKeys = new Set<string>()
  const PAGE = 1000
  let from = 0
  for (;;) {
    const { data: page, error: pageErr } = await supabase
      .from('tangential_signals')
      .select('action_class, signal_date, extracted_identity')
      .eq('venue_id', venueId)
      .eq('source_platform', detector.key)
      .range(from, from + PAGE - 1)
    if (pageErr) {
      summary.errors.push(`dedup fetch @${from}: ${pageErr.message}`)
      break
    }
    const rowsPage = (page ?? []) as Array<{
      action_class: string | null
      signal_date: string | null
      extracted_identity: Record<string, unknown> | null
    }>
    for (const e of rowsPage) {
      const name = ((e.extracted_identity?.name_raw as string | null) ?? '').toLowerCase()
      const ac = e.action_class ?? ''
      existingKeys.add(dedupKey(ac, name, e.signal_date))
    }
    if (rowsPage.length < PAGE) break
    from += PAGE
  }

  // Build the insert batch in memory. Within-batch dedup uses the
  // same keys so a single import doesn't double-count two identical
  // rows in the same CSV (the ~250 anonymized ' .' rows on the same
  // date and action class collapse to one).
  type InsertRow = {
    venue_id: string
    signal_type: string
    source_platform: string
    action_class: string
    signal_date: string | null
    source_context: string
    extracted_identity: Record<string, unknown>
    match_status: 'unmatched'
    source_entry_id: string | null
  }
  const toInsert: InsertRow[] = []
  const seenInBatch = new Set<string>()

  for (const ur of mapped) {
    if (ur.signal_date) summary.date_parse_rate.parsed++
    else summary.date_parse_rate.unparseable++

    const nameKey = (ur.name_raw ?? '').trim().toLowerCase()
    const k = dedupKey(ur.action_class, nameKey, ur.signal_date)
    if (existingKeys.has(k) || seenInBatch.has(k)) {
      summary.skipped_duplicate++
      continue
    }
    seenInBatch.add(k)

    const extracted_identity: Record<string, unknown> = {
      name_raw: nameKey || null,
      first_name: ur.first_name,
      last_initial: ur.last_initial,
      last_name: ur.last_name,
      username: ur.username,
      email: ur.email,
      city: ur.city,
      state: ur.state,
      country: ur.country,
      raw_row: ur.raw_row,
    }

    toInsert.push({
      venue_id: venueId,
      signal_type: actionClassToSignalType(ur.action_class, detector.key),
      source_platform: detector.key,
      action_class: ur.action_class,
      signal_date: ur.signal_date,
      source_context: ur.source_context,
      extracted_identity,
      match_status: 'unmatched',
      source_entry_id: brainDumpEntryId ?? null,
    })
  }

  // Batch insert in chunks of 200. Supabase's PostgREST cap is 1000
  // rows per request but 200 stays well under any RLS-policy
  // overhead and gives faster feedback on partial errors.
  const CHUNK = 200
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK)
    const { error } = await supabase.from('tangential_signals').insert(chunk)
    if (error) {
      summary.errors.push(`insert chunk @${i}: ${error.message}`)
      continue
    }
    summary.inserted += chunk.length
    for (const r of chunk) {
      summary.by_action[r.action_class] = (summary.by_action[r.action_class] ?? 0) + 1
    }
  }

  return summary
}
