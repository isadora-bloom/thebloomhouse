/**
 * GET /api/cron/replay-paused-skipped (T5-eta.2 / Stream M)
 *
 * 00:05 UTC daily sweeper. Reads paused_period_skipped rows in
 * status='pending' and, per affected venue, builds a summary
 * notification listing what got skipped during the previous paused
 * window — with a one-click "Run now" backfill the coordinator can
 * trigger from /pulse.
 *
 * Pre-this-cron: filterActiveVenues silently dropped paused venues.
 * Coordinators returning after a 24h pause had no way to see "weekly
 * digest skipped Monday, anomaly run skipped Mon, weekly briefing
 * skipped Mon." This sweeper turns the silent drops into a single
 * actionable notification per venue.
 *
 * Two cleanup behaviors:
 *   1. Pending rows older than 7 days → status='expired' (the work
 *      they represent is no longer relevant — a stale digest from
 *      last Monday isn't worth backfilling on Friday).
 *   2. Venues whose pause has cleared → emit a 'paused_period_recap'
 *      notification with skip counts grouped by work_type.
 *
 * Auth: same Bearer CRON_SECRET pattern as /api/cron.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { createNotification } from '@/lib/services/admin-notifications'

interface SkippedRow {
  id: string
  venue_id: string
  work_type: string
  scheduled_for: string
  skipped_at: string
}

interface RecapResult {
  venuesNotified: number
  skipsExpired: number
  skipsPending: number
  perVenue: Array<{
    venueId: string
    pausedNow: boolean
    skipCounts: Record<string, number>
    notified: boolean
  }>
}

async function buildRecap(): Promise<RecapResult> {
  const supabase = createServiceClient()
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()

  // Step 1: expire pending rows older than 7 days. The work is too
  // stale to backfill (a digest skipped 8 days ago isn't worth
  // running today). Idempotent: re-runs find nothing.
  await supabase
    .from('paused_period_skipped')
    .update({ status: 'expired', expires_at: new Date().toISOString() })
    .eq('status', 'pending')
    .lt('skipped_at', sevenDaysAgo)

  // Step 2: pull every still-pending row.
  const { data: rows } = await supabase
    .from('paused_period_skipped')
    .select('id, venue_id, work_type, scheduled_for, skipped_at')
    .eq('status', 'pending')

  const pending = ((rows ?? []) as SkippedRow[])

  // Group by venue.
  const byVenue = new Map<string, SkippedRow[]>()
  for (const row of pending) {
    if (!byVenue.has(row.venue_id)) byVenue.set(row.venue_id, [])
    byVenue.get(row.venue_id)!.push(row)
  }

  // Pre-fetch which venues are still paused — only emit the "Run now"
  // recap notification once a venue's pause has cleared. While the
  // venue is still paused, the /pulse banner (T5-eta.1) shows the
  // ongoing-pause state; layering a notification on top would just
  // double-surface the same fact.
  const venueIds = [...byVenue.keys()]
  const pausedSet = new Set<string>()
  if (venueIds.length > 0) {
    const { data: cfgs } = await supabase
      .from('venue_config')
      .select('venue_id, autonomous_paused')
      .in('venue_id', venueIds)
    for (const cfg of ((cfgs ?? []) as Array<{ venue_id: string; autonomous_paused: boolean }>)) {
      if (cfg.autonomous_paused) pausedSet.add(cfg.venue_id)
    }
  }

  const summary: RecapResult = {
    venuesNotified: 0,
    skipsExpired: 0, // computed below from before/after counts is overkill; report 0 here, the lt() update doesn't return count cheaply
    skipsPending: pending.length,
    perVenue: [],
  }

  for (const [venueId, venueRows] of byVenue.entries()) {
    const skipCounts: Record<string, number> = {}
    for (const r of venueRows) {
      skipCounts[r.work_type] = (skipCounts[r.work_type] ?? 0) + 1
    }
    const pausedNow = pausedSet.has(venueId)
    let notified = false

    if (!pausedNow) {
      // Pause cleared — coordinator can act on the backlog now.
      const total = venueRows.length
      const breakdown = Object.entries(skipCounts)
        .map(([wt, n]) => `${n} ${wt.replace(/_/g, ' ')}${n > 1 ? 's' : ''}`)
        .join(', ')

      try {
        await createNotification({
          venueId,
          type: 'paused_period_recap',
          title: `${total} task${total === 1 ? '' : 's'} skipped during cost-ceiling pause`,
          body: JSON.stringify({
            skipCounts,
            breakdown,
            replayUrl: '/pulse',
            // Run-now action goes through the dedicated backfill
            // endpoint POST /api/agent/cost-ceiling/replay which
            // marks rows as replayed and re-fires the work types
            // (subject to current ceiling).
            replayActionUrl: '/api/agent/cost-ceiling/replay',
            replayActionMethod: 'POST',
          }),
        })
        notified = true
      } catch (err) {
        console.warn(`[replay-paused-skipped] notification failed for ${venueId}:`, err)
      }
    }

    summary.perVenue.push({ venueId, pausedNow, skipCounts, notified })
    if (notified) summary.venuesNotified++
  }

  return summary
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await buildRecap()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[replay-paused-skipped] failed:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    )
  }
}
