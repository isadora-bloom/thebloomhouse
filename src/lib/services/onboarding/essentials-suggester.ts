/**
 * Essentials suggester (T5-γ.3 / Playbook Part 20.5).
 *
 * Reads essentials_action_log to detect coordinators who consistently
 * dismiss high-density cards on a surface. When a coordinator has 5+
 * dismissed_card events at level_at_action='expanded' OR 'everything'
 * on the same surface within the last 30 days, the system fires a
 * per-user admin_notification suggesting they drop the surface to
 * 'recommended' density.
 *
 * Pre-this-file the action log was being WRITTEN by the slider UI but
 * NEVER READ by anything (Pattern A: ship-without-consumer). This service
 * closes the loop so the slider's learning promise actually delivers.
 *
 * Invoked nightly by /api/cron?job=essentials_suggest. Idempotent — the
 * 30d suppression window prevents the cron from re-firing the same
 * suggestion every day once the threshold is crossed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// Threshold: 5 dismissals at high-density level over 30d → suggest.
// Tuned for "consistent pattern" not "noisy weekday" — a coordinator
// might dismiss 1-2 cards on a busy day; 5 across 30d is signal.
const DISMISSAL_THRESHOLD = 5
const WINDOW_DAYS = 30

const HIGH_DENSITY_LEVELS = new Set(['expanded', 'everything'])

export interface SuggesterRunSummary {
  rowsScanned: number
  uniqueUserSurfaces: number
  suggestionsFired: number
  suppressedAlreadyOpen: number
  errors: number
  perSuggestion: Array<{
    userId: string
    venueId: string
    surface: string
    dismissalsLast30d: number
    fired: boolean
    reason?: string
  }>
}

interface ActionLogRow {
  user_id: string
  venue_id: string
  surface: string
  level_at_action: string
  action: string
}

interface ExistingNotificationRow {
  venue_id: string
  user_id: string | null
  body: string | null
}

/**
 * Run the suggester sweep. Returns a per-suggestion summary.
 *
 * Idempotency: before firing a notification, check that no
 * essentials_suggestion row of the same (venue_id, user_id, surface)
 * has been written in the last WINDOW_DAYS. The surface is encoded
 * into the body's JSON payload, so we filter on body LIKE.
 */
export async function runEssentialsSuggester(
  supabase: SupabaseClient,
): Promise<SuggesterRunSummary> {
  const summary: SuggesterRunSummary = {
    rowsScanned: 0,
    uniqueUserSurfaces: 0,
    suggestionsFired: 0,
    suppressedAlreadyOpen: 0,
    errors: 0,
    perSuggestion: [],
  }

  const cutoffIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // 1. Pull the last 30d of dismissal events at high-density levels.
  const { data: rows, error: logErr } = await supabase
    .from('essentials_action_log')
    .select('user_id, venue_id, surface, level_at_action, action')
    .eq('action', 'dismissed_card')
    .gte('created_at', cutoffIso)

  if (logErr) {
    console.error('[essentials-suggester] failed to read action log:', logErr.message)
    summary.errors += 1
    return summary
  }

  const logRows = (rows ?? []) as ActionLogRow[]
  summary.rowsScanned = logRows.length

  // 2. Group by (user, venue, surface). Only count high-density rows.
  const counts = new Map<string, { user_id: string; venue_id: string; surface: string; count: number }>()
  for (const row of logRows) {
    if (!HIGH_DENSITY_LEVELS.has(row.level_at_action)) continue
    const key = `${row.user_id}|${row.venue_id}|${row.surface}`
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
    } else {
      counts.set(key, {
        user_id: row.user_id,
        venue_id: row.venue_id,
        surface: row.surface,
        count: 1,
      })
    }
  }

  summary.uniqueUserSurfaces = counts.size

  // 3. Filter to ones that crossed the threshold.
  const candidates = Array.from(counts.values()).filter((c) => c.count >= DISMISSAL_THRESHOLD)
  if (candidates.length === 0) return summary

  // 4. Pull existing essentials_suggestion notifications in window so we
  //    can dedupe on (venue_id, user_id, surface). The surface is encoded
  //    in the body's JSON payload — we read the body and decode.
  const venueIds = Array.from(new Set(candidates.map((c) => c.venue_id)))
  const userIds = Array.from(new Set(candidates.map((c) => c.user_id)))

  const { data: existingRows, error: existingErr } = await supabase
    .from('admin_notifications')
    .select('venue_id, user_id, body')
    .eq('type', 'essentials_suggestion')
    .gte('created_at', cutoffIso)
    .in('venue_id', venueIds)
    .in('user_id', userIds)

  if (existingErr) {
    console.error('[essentials-suggester] failed to read existing notifications:', existingErr.message)
    summary.errors += 1
    return summary
  }

  const openSet = new Set<string>()
  for (const row of (existingRows ?? []) as ExistingNotificationRow[]) {
    if (!row.user_id) continue
    let surface: string | null = null
    if (row.body) {
      try {
        const parsed = JSON.parse(row.body) as { surface?: unknown }
        if (parsed && typeof parsed.surface === 'string') surface = parsed.surface
      } catch {
        // body wasn't JSON for whatever reason — skip
      }
    }
    if (!surface) continue
    openSet.add(`${row.venue_id}|${row.user_id}|${surface}`)
  }

  // 5. Fire notifications for the candidates that don't already have an
  //    open suggestion in window.
  for (const cand of candidates) {
    const dedupKey = `${cand.venue_id}|${cand.user_id}|${cand.surface}`
    if (openSet.has(dedupKey)) {
      summary.suppressedAlreadyOpen += 1
      summary.perSuggestion.push({
        userId: cand.user_id,
        venueId: cand.venue_id,
        surface: cand.surface,
        dismissalsLast30d: cand.count,
        fired: false,
        reason: 'already_open_in_window',
      })
      continue
    }

    const payload = {
      type: 'essentials_suggestion',
      surface: cand.surface,
      suggested_level: 'recommended',
      dismissals_30d: cand.count,
    }

    const { error: insertErr } = await supabase.from('admin_notifications').insert({
      venue_id: cand.venue_id,
      user_id: cand.user_id,
      type: 'essentials_suggestion',
      title: `Want to set ${cand.surface} to Recommended?`,
      body: JSON.stringify(payload),
    })

    if (insertErr) {
      console.error(
        `[essentials-suggester] failed to insert notification for user=${cand.user_id} venue=${cand.venue_id} surface=${cand.surface}:`,
        insertErr.message,
      )
      summary.errors += 1
      summary.perSuggestion.push({
        userId: cand.user_id,
        venueId: cand.venue_id,
        surface: cand.surface,
        dismissalsLast30d: cand.count,
        fired: false,
        reason: 'insert_failed',
      })
      continue
    }

    summary.suggestionsFired += 1
    summary.perSuggestion.push({
      userId: cand.user_id,
      venueId: cand.venue_id,
      surface: cand.surface,
      dismissalsLast30d: cand.count,
      fired: true,
    })
  }

  return summary
}

// Pure-test export.
export const __test__ = {
  DISMISSAL_THRESHOLD,
  WINDOW_DAYS,
  HIGH_DENSITY_LEVELS,
}
