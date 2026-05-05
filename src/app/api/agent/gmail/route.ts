import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { getOAuthUrl, handleOAuthCallback, getGmailClient, getConnections } from '@/lib/services/gmail'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createLogger, newCorrelationId } from '@/lib/observability/logger'
import { redactError } from '@/lib/observability/redact'

// ---------------------------------------------------------------------------
// GET — Two modes:
//   ?action=auth-url&redirectUri=URL  → returns { url: '...' }
//   (no action)                        → returns connections + status
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const start = Date.now()
  const correlationId = newCorrelationId()
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const log = createLogger({ venueId: auth.venueId, correlationId, actor: 'coordinator' })

  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')
    log.info('gmail.connections.get', { event_type: 'gmail_connections_get', outcome: 'ok', data: { action } })

    // --- Generate OAuth URL ---
    if (action === 'auth-url') {
      const redirectUri = searchParams.get('redirectUri')

      if (!redirectUri) {
        return NextResponse.json(
          { error: 'Missing redirectUri query parameter' },
          { status: 400 }
        )
      }

      const url = getOAuthUrl(auth.venueId, redirectUri)

      if (!url) {
        return NextResponse.json(
          { error: 'Gmail integration is not configured. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' },
          { status: 503 }
        )
      }

      return NextResponse.json({ url })
    }

    // --- Check connection status ---
    // Return ALL connections for the venue
    const connections = await getConnections(auth.venueId)

    if (connections.length === 0) {
      // Fallback: check legacy venue_config
      const supabase = createServiceClient()
      const { data: config } = await supabase
        .from('venue_config')
        .select('gmail_tokens, coordinator_email')
        .eq('venue_id', auth.venueId)
        .single()

      if (!config?.gmail_tokens) {
        return NextResponse.json({ connected: false, connections: [] })
      }

      // Legacy tokens exist but no connections yet — verify
      let email: string | undefined
      try {
        const gmail = await getGmailClient(auth.venueId)
        if (gmail) {
          const profile = await gmail.users.getProfile({ userId: 'me' })
          email = profile.data.emailAddress ?? undefined
        }
      } catch {
        email = config.coordinator_email ?? undefined
      }

      const { data: syncState } = await supabase
        .from('email_sync_state')
        .select('last_sync_at, status, error_message')
        .eq('venue_id', auth.venueId)
        .maybeSingle()

      return NextResponse.json({
        connected: true,
        email: email ?? config.coordinator_email ?? undefined,
        lastSync: syncState?.last_sync_at ?? null,
        syncStatus: syncState?.status ?? null,
        error: syncState?.error_message ?? undefined,
        connections: [],
      })
    }

    // Return connection list + overall status
    const supabase = createServiceClient()
    const { data: syncState } = await supabase
      .from('email_sync_state')
      .select('last_sync_at, status, error_message')
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    // Look up coordinator names for each connection
    const userIds = connections.filter((c) => c.user_id).map((c) => c.user_id!)
    let userMap: Record<string, string> = {}
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, first_name, last_name')
        .in('id', userIds)
      if (profiles) {
        for (const p of profiles) {
          const name = [p.first_name, p.last_name].filter(Boolean).join(' ')
          userMap[p.id as string] = name || 'Unknown'
        }
      }
    }

    const primary = connections.find((c) => c.is_primary)

    const payload = {
      connected: connections.some((c) => c.status === 'active'),
      email: primary?.email_address ?? connections[0]?.email_address ?? undefined,
      lastSync: syncState?.last_sync_at ?? null,
      syncStatus: syncState?.status ?? null,
      error: syncState?.error_message ?? undefined,
      connections: connections.map((c) => ({
        id: c.id,
        emailAddress: c.email_address,
        isPrimary: c.is_primary,
        label: c.label,
        syncEnabled: c.sync_enabled,
        lastSyncAt: c.last_sync_at,
        status: c.status,
        errorMessage: c.error_message,
        userId: c.user_id,
        userName: c.user_id ? userMap[c.user_id] ?? null : null,
        createdAt: c.created_at,
      })),
    }
    log.info('gmail.connections.list.ok', {
      event_type: 'gmail_connections_list',
      outcome: 'ok',
      latency_ms: Date.now() - start,
      data: { connection_count: connections.length },
    })
    return NextResponse.json(payload)
  } catch (err) {
    log.error('gmail.connections.get.error', {
      event_type: 'gmail_connections_get',
      outcome: 'fail',
      latency_ms: Date.now() - start,
      data: { error: redactError(err) },
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Handle Gmail OAuth callback
//   Body: { code: string, redirectUri: string }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const start = Date.now()
  const correlationId = newCorrelationId()
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const log = createLogger({ venueId: auth.venueId, correlationId, actor: 'coordinator' })
  log.info('gmail.oauth.callback.start', { event_type: 'gmail_oauth_callback', outcome: 'ok' })

  try {
    const body = await request.json()
    const { code, redirectUri } = body

    if (!code || typeof code !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid authorization code' },
        { status: 400 }
      )
    }

    if (!redirectUri || typeof redirectUri !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid redirectUri' },
        { status: 400 }
      )
    }

    const connectionId = await handleOAuthCallback(auth.venueId, code, redirectUri, auth.userId)

    if (!connectionId) {
      return NextResponse.json(
        { error: 'Failed to complete Gmail OAuth flow' },
        { status: 500 }
      )
    }

    // Fetch the connected email + sync info to return
    const supabase = createServiceClient()

    // Try to get the email from the profile
    let email: string | undefined
    try {
      const gmail = await getGmailClient(auth.venueId, connectionId)
      if (gmail) {
        const profile = await gmail.users.getProfile({ userId: 'me' })
        email = profile.data.emailAddress ?? undefined

        // Also store it as coordinator_email for quick lookups
        if (email) {
          await supabase
            .from('venue_config')
            .update({ coordinator_email: email })
            .eq('venue_id', auth.venueId)
        }
      }
    } catch {
      // Best effort — email retrieval is not critical here
    }

    const { data: syncState } = await supabase
      .from('email_sync_state')
      .select('last_sync_at')
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    log.info('gmail.oauth.callback.ok', {
      event_type: 'gmail_oauth_callback',
      outcome: 'ok',
      latency_ms: Date.now() - start,
      data: { connectionId },
    })
    return NextResponse.json({
      success: true,
      connected: true,
      connectionId,
      email: email ?? undefined,
      lastSync: syncState?.last_sync_at ?? null,
    })
  } catch (err) {
    log.error('gmail.oauth.callback.error', {
      event_type: 'gmail_oauth_callback',
      outcome: 'fail',
      latency_ms: Date.now() - start,
      data: { error: redactError(err) },
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// DELETE — Disconnect a Gmail connection
//   ?connectionId=xxx  → delete specific connection
//   (no connectionId)  → delete ALL connections + legacy tokens
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  const start = Date.now()
  const correlationId = newCorrelationId()
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const log = createLogger({ venueId: auth.venueId, correlationId, actor: 'coordinator' })

  try {
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get('connectionId')
    const supabase = createServiceClient()
    log.info('gmail.connections.delete.start', {
      event_type: 'gmail_connections_delete',
      outcome: 'ok',
      data: { connectionId: connectionId ?? 'all' },
    })

    if (connectionId) {
      // Delete a specific connection
      const { error: connError } = await supabase
        .from('gmail_connections')
        .delete()
        .eq('id', connectionId)
        .eq('venue_id', auth.venueId)

      if (connError) {
        log.error('gmail.connections.delete.error', {
          event_type: 'gmail_connections_delete',
          outcome: 'fail',
          latency_ms: Date.now() - start,
          data: { error: redactError(connError), connectionId },
        })
        return NextResponse.json({ error: 'Failed to disconnect Gmail account' }, { status: 500 })
      }

      // If this was the primary, promote another connection
      const { data: remaining } = await supabase
        .from('gmail_connections')
        .select('id, is_primary')
        .eq('venue_id', auth.venueId)
        .order('created_at', { ascending: true })

      if (remaining && remaining.length > 0 && !remaining.some((r) => r.is_primary)) {
        await supabase
          .from('gmail_connections')
          .update({ is_primary: true })
          .eq('id', remaining[0].id)
      }

      // If no connections left, clear legacy tokens too
      if (!remaining || remaining.length === 0) {
        await supabase
          .from('venue_config')
          .update({ gmail_tokens: null })
          .eq('venue_id', auth.venueId)

        await supabase
          .from('email_sync_state')
          .delete()
          .eq('venue_id', auth.venueId)
      }

      log.info('gmail.connections.delete.ok', {
        event_type: 'gmail_connections_delete',
        outcome: 'ok',
        latency_ms: Date.now() - start,
        data: { connectionId },
      })
      return NextResponse.json({ success: true })
    }

    // Delete ALL connections + legacy tokens
    await supabase
      .from('gmail_connections')
      .delete()
      .eq('venue_id', auth.venueId)

    const { error: tokenError } = await supabase
      .from('venue_config')
      .update({ gmail_tokens: null })
      .eq('venue_id', auth.venueId)

    if (tokenError) {
      log.error('gmail.connections.delete-all.error', {
        event_type: 'gmail_connections_delete',
        outcome: 'fail',
        latency_ms: Date.now() - start,
        data: { error: redactError(tokenError) },
      })
      return NextResponse.json({ error: 'Failed to disconnect Gmail' }, { status: 500 })
    }

    await supabase
      .from('email_sync_state')
      .delete()
      .eq('venue_id', auth.venueId)

    log.info('gmail.connections.delete-all.ok', {
      event_type: 'gmail_connections_delete',
      outcome: 'ok',
      latency_ms: Date.now() - start,
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    log.error('gmail.connections.delete.error', {
      event_type: 'gmail_connections_delete',
      outcome: 'fail',
      latency_ms: Date.now() - start,
      data: { error: redactError(err) },
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PATCH — Update a connection (set primary, edit label, toggle sync)
//   Body: { connectionId: string, isPrimary?: boolean, label?: string, syncEnabled?: boolean }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const start = Date.now()
  const correlationId = newCorrelationId()
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const log = createLogger({ venueId: auth.venueId, correlationId, actor: 'coordinator' })

  try {
    const body = await request.json()
    const { connectionId, isPrimary, label, syncEnabled } = body
    log.info('gmail.connections.patch.start', {
      event_type: 'gmail_connections_patch',
      outcome: 'ok',
      data: { connectionId },
    })

    if (!connectionId) {
      return NextResponse.json({ error: 'Missing connectionId' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // If setting as primary, unset all others first
    if (isPrimary === true) {
      await supabase
        .from('gmail_connections')
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq('venue_id', auth.venueId)
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }

    if (isPrimary !== undefined) updates.is_primary = isPrimary
    if (label !== undefined) updates.label = label
    if (syncEnabled !== undefined) updates.sync_enabled = syncEnabled

    const { error } = await supabase
      .from('gmail_connections')
      .update(updates)
      .eq('id', connectionId)
      .eq('venue_id', auth.venueId)

    if (error) {
      log.error('gmail.connections.patch.error', {
        event_type: 'gmail_connections_patch',
        outcome: 'fail',
        latency_ms: Date.now() - start,
        data: { error: redactError(error), connectionId },
      })
      return NextResponse.json({ error: 'Failed to update connection' }, { status: 500 })
    }

    log.info('gmail.connections.patch.ok', {
      event_type: 'gmail_connections_patch',
      outcome: 'ok',
      latency_ms: Date.now() - start,
      data: { connectionId },
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    log.error('gmail.connections.patch.error', {
      event_type: 'gmail_connections_patch',
      outcome: 'fail',
      latency_ms: Date.now() - start,
      data: { error: redactError(err) },
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
