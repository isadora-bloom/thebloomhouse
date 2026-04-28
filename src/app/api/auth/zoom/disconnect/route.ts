/**
 * POST /api/auth/zoom/disconnect
 *
 * Body: { connectionId?: string }
 *
 * Disconnects the venue's Zoom connection(s):
 *   1. Verify the caller is a platform user.
 *   2. If connectionId given, target only that row; otherwise target every
 *      active connection for the venue.
 *   3. Best-effort: revoke the refresh token with Zoom.
 *   4. Delete the row(s). Unlike Gmail (which keeps audit history) Zoom
 *      tokens are short-lived and there's no analytics tying back to the
 *      row id, so a hard delete is fine and matches the spec.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { revokeZoomToken } from '@/lib/services/zoom'

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 })
  }

  let connectionId: string | undefined
  try {
    const body = (await request.json().catch(() => ({}))) as { connectionId?: string }
    connectionId = body.connectionId
  } catch {
    // Empty body is fine — disconnect everything for the venue.
  }

  const supabase = createServiceClient()

  let query = supabase
    .from('zoom_connections')
    .select('id, venue_id, refresh_token, access_token')
    .eq('venue_id', auth.venueId)

  if (connectionId) {
    query = query.eq('id', connectionId)
  }

  const { data: rows, error: loadError } = await query

  if (loadError) {
    console.error('[zoom/disconnect] load error:', loadError.message)
    return NextResponse.json({ ok: false, reason: 'lookup_failed' }, { status: 500 })
  }

  if (!rows || rows.length === 0) {
    // Nothing to do — treat as success so retries are idempotent.
    return NextResponse.json({ ok: true, disconnected: 0 })
  }

  // Best-effort revoke each connection's refresh token in parallel.
  await Promise.all(
    rows.map(async (row) => {
      const target = (row.refresh_token as string | null) ?? (row.access_token as string | null)
      if (target) {
        await revokeZoomToken(target).catch(() => undefined)
      }
    })
  )

  let deleteQuery = supabase
    .from('zoom_connections')
    .delete()
    .eq('venue_id', auth.venueId)
  if (connectionId) {
    deleteQuery = deleteQuery.eq('id', connectionId)
  }
  const { error: deleteError } = await deleteQuery

  if (deleteError) {
    console.error('[zoom/disconnect] delete error:', deleteError.message)
    return NextResponse.json({ ok: false, reason: 'delete_failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, disconnected: rows.length })
}
