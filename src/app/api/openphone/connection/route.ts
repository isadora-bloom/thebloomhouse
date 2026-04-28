/**
 * /api/openphone/connection
 *
 *   GET    → load the venue's openphone_connections row (api key masked)
 *   PUT    → upsert the api key + workspace label + per-number enabled flags
 *   DELETE → tear down the connection (sets is_active=false, keeps history)
 *
 * The sensitive api_key is never returned to the client — we only
 * indicate whether one is configured. The settings page paste-box stays
 * empty unless the coordinator types a new value.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import type { OpenPhonePhoneNumber } from '@/lib/services/openphone'

interface PublicConnection {
  hasApiKey: boolean
  workspaceLabel: string | null
  isActive: boolean
  lastSyncedAt: string | null
  phoneNumbers: OpenPhonePhoneNumber[]
}

function maskedView(row: Record<string, unknown> | null): PublicConnection {
  if (!row) {
    return {
      hasApiKey: false,
      workspaceLabel: null,
      isActive: false,
      lastSyncedAt: null,
      phoneNumbers: [],
    }
  }
  const phoneNumbers = Array.isArray(row.phone_numbers)
    ? (row.phone_numbers as OpenPhonePhoneNumber[])
    : []
  return {
    hasApiKey: typeof row.api_key === 'string' && (row.api_key as string).length > 0,
    workspaceLabel: (row.workspace_label as string | null) ?? null,
    isActive: (row.is_active as boolean | null) ?? false,
    lastSyncedAt: (row.last_synced_at as string | null) ?? null,
    phoneNumbers,
  }
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('openphone_connections')
    .select('api_key, workspace_label, is_active, last_synced_at, phone_numbers')
    .eq('venue_id', auth.venueId)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ connection: maskedView(data) })
}

export async function PUT(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => null)) as {
    apiKey?: string | null
    workspaceLabel?: string | null
    phoneNumbers?: OpenPhonePhoneNumber[]
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const supabase = createServiceClient()

  // Read existing row to figure out whether we're creating or updating
  // and whether to preserve the existing key when only flags changed.
  const { data: existing } = await supabase
    .from('openphone_connections')
    .select('id, api_key, phone_numbers')
    .eq('venue_id', auth.venueId)
    .maybeSingle()

  const trimmedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!existing && !trimmedKey) {
    return NextResponse.json(
      { error: 'API key is required when creating an OpenPhone connection.' },
      { status: 400 }
    )
  }

  const payload: Record<string, unknown> = {
    venue_id: auth.venueId,
    is_active: true,
    updated_at: new Date().toISOString(),
  }

  // Only overwrite api_key when a new one was supplied. An empty paste
  // box on a follow-up save means "leave it alone".
  if (trimmedKey) {
    payload.api_key = trimmedKey
  } else if (!existing) {
    // Should never reach here — the early return above catches it.
    payload.api_key = ''
  }

  if (body.workspaceLabel !== undefined) {
    payload.workspace_label =
      typeof body.workspaceLabel === 'string' && body.workspaceLabel.trim()
        ? body.workspaceLabel.trim()
        : null
  }

  if (Array.isArray(body.phoneNumbers)) {
    payload.phone_numbers = body.phoneNumbers
  }

  const { data, error } = await supabase
    .from('openphone_connections')
    .upsert(payload, { onConflict: 'venue_id' })
    .select('api_key, workspace_label, is_active, last_synced_at, phone_numbers')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ connection: maskedView(data) })
}

export async function DELETE() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('openphone_connections')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('venue_id', auth.venueId)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
