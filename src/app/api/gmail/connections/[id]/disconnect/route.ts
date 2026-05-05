/**
 * DELETE /api/gmail/connections/:id/disconnect
 *
 * Disconnects a Gmail connection (PROJECT-AUDIT-V2 GAP-13):
 *   1. Verifies the caller is a platform user and owns the connection.
 *   2. Revokes the refresh token at https://oauth2.googleapis.com/revoke.
 *   3. Deletes the gmail_connections row.
 *   4. Promotes the next-oldest active row to primary if the deleted
 *      row was primary.
 *
 * Returns { ok: boolean, reason?: string }.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { recordCounter } from '@/lib/observability/metrics'
import { redactError } from '@/lib/observability/redact'
import { createNotification } from '@/lib/services/admin-notifications'

async function revokeAtGoogle(token: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    )
    // 200 OK on success; 400 when the token is already invalid — treat
    // both as "done" because the local outcome is the same.
    return res.ok || res.status === 400
  } catch (err) {
    console.warn('[gmail/disconnect] revoke request failed:', redactError(err))
    return false
  }
}

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  if (!id || typeof id !== 'string') {
    return NextResponse.json(
      { ok: false, reason: 'missing_connection_id' },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()

  // Look the row up and verify ownership.
  type ConnectionRow = {
    id: string
    venue_id: string
    is_primary: boolean
    email_address: string | null
    gmail_tokens: { refresh_token?: string; access_token?: string } | null
  }
  let row: ConnectionRow | null = null
  try {
    const { data, error } = await supabase
      .from('gmail_connections')
      .select('id, venue_id, is_primary, email_address, gmail_tokens')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    row = (data as unknown as ConnectionRow | null) ?? null
  } catch (err) {
    console.error('[gmail/disconnect] lookup failed:', redactError(err))
    return NextResponse.json(
      { ok: false, reason: 'lookup_failed' },
      { status: 500 },
    )
  }

  if (!row) {
    return NextResponse.json({ ok: false, reason: 'not_found' }, { status: 404 })
  }
  if (row.venue_id !== auth.venueId) {
    return NextResponse.json({ ok: false, reason: 'forbidden' }, { status: 403 })
  }

  // Best-effort token revoke. We prefer the refresh token because
  // revoking it cascades to all access tokens minted from it.
  const tokens = row.gmail_tokens ?? {}
  const revokeTarget = tokens.refresh_token ?? tokens.access_token
  let revokedAtGoogle = false
  if (revokeTarget) {
    revokedAtGoogle = await revokeAtGoogle(revokeTarget)
  }

  // Delete the row.
  try {
    const { error: deleteError } = await supabase
      .from('gmail_connections')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)
    if (deleteError) throw deleteError
  } catch (err) {
    console.error('[gmail/disconnect] delete failed:', redactError(err))
    return NextResponse.json(
      { ok: false, reason: 'delete_failed' },
      { status: 500 },
    )
  }

  // If the deleted row was primary, promote another active connection.
  if (row.is_primary) {
    try {
      const { data: remaining } = await supabase
        .from('gmail_connections')
        .select('id')
        .eq('venue_id', auth.venueId)
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .limit(1)
      if (remaining && remaining.length > 0) {
        await supabase
          .from('gmail_connections')
          .update({ is_primary: true, updated_at: new Date().toISOString() })
          .eq('id', remaining[0].id)
      } else {
        // No active connections left — clear the legacy fallback so the
        // email-poll cron doesn't keep trying with stale tokens.
        await supabase
          .from('venue_config')
          .update({ gmail_tokens: null })
          .eq('venue_id', auth.venueId)
      }
    } catch (err) {
      console.warn('[gmail/disconnect] primary promotion failed:', redactError(err))
    }
  }

  await recordCounter('gmail_oauth_disconnect', {
    venueId: auth.venueId,
    dimension: {
      revoked_at_google: revokedAtGoogle,
      had_token: Boolean(revokeTarget),
    },
  })

  // Notify the coordinator so they know their inbox is no longer connected.
  // Writes an admin_notifications row of type 'gmail_disconnected' so the
  // coordinator sees a banner in the Agent dashboard.
  try {
    const emailLabel = row.email_address ?? `connection ${id.slice(0, 8)}`
    await createNotification({
      venueId: auth.venueId,
      type: 'gmail_disconnected',
      title: 'Gmail inbox disconnected',
      body: `${emailLabel} has been disconnected. Sage can no longer poll or send from this inbox. Reconnect in Settings → Agent → Gmail Connections.`,
    })
  } catch (err) {
    // Non-fatal — the disconnect succeeded; notification failure should
    // not block the response.
    console.warn('[gmail/disconnect] notification write failed:', redactError(err))
  }

  return NextResponse.json({ ok: true, revokedAtGoogle })
}
