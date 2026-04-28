/**
 * POST /api/zoom/sync
 *
 * Triggers an on-demand sync of Zoom recordings for the caller's venue.
 * Runs the same path the daily cron uses — fetches recordings in the
 * lookback window, dedups against processed_zoom_meetings, downloads new
 * transcripts, and surfaces them as `interactions` rows of type='meeting'.
 *
 * Auth: platform user only.
 *
 * Body (optional): { sinceDays?: number } — defaults to 30. Capped at 90.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { syncMeetings } from '@/lib/services/zoom'

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 })
  }

  let sinceDays = 30
  try {
    const body = (await request.json().catch(() => ({}))) as { sinceDays?: number }
    if (typeof body.sinceDays === 'number' && body.sinceDays > 0) {
      sinceDays = Math.min(90, Math.floor(body.sinceDays))
    }
  } catch {
    // Empty body is fine
  }

  try {
    const result = await syncMeetings(auth.venueId, { sinceDays })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    if (err instanceof Error && err.message === 'reconnect needed') {
      return NextResponse.json(
        { ok: false, reason: 'reconnect_needed' },
        { status: 409 }
      )
    }
    console.error('[zoom/sync] failed:', err)
    return NextResponse.json(
      {
        ok: false,
        reason: 'sync_failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}
