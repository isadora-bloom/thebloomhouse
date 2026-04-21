/**
 * /api/agent/inbox-filters
 *
 * CRUD for per-venue inbox filter rules (venue_email_filters).
 *
 *   GET    → list rules for the authed venue
 *   POST   → create a rule { pattern_type, pattern, action, note? }
 *   DELETE → remove a rule by ?id=...
 *
 * All writes use the service client so RLS doesn't block coordinators, but
 * we enforce venue scoping manually off the auth context.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { clearFilterCache } from '@/lib/services/inbox-filters'

const VALID_PATTERN_TYPES = ['sender_exact', 'sender_domain', 'gmail_label'] as const
const VALID_ACTIONS = ['ignore', 'no_draft'] as const

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_email_filters')
    .select('*')
    .eq('venue_id', auth.venueId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ filters: data ?? [] })
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { pattern_type, pattern, action, note } = body as {
    pattern_type?: string
    pattern?: string
    action?: string
    note?: string | null
  }

  if (!pattern_type || !VALID_PATTERN_TYPES.includes(pattern_type as (typeof VALID_PATTERN_TYPES)[number])) {
    return NextResponse.json({ error: 'Invalid pattern_type' }, { status: 400 })
  }
  if (!pattern || !pattern.trim()) {
    return NextResponse.json({ error: 'Pattern required' }, { status: 400 })
  }
  const normalizedPattern =
    pattern_type === 'gmail_label'
      ? pattern.trim().toUpperCase()
      : pattern.trim().toLowerCase()

  const effectiveAction = VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])
    ? (action as (typeof VALID_ACTIONS)[number])
    : 'ignore'

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_email_filters')
    .upsert(
      {
        venue_id: auth.venueId,
        pattern_type,
        pattern: normalizedPattern,
        action: effectiveAction,
        source: 'manual',
        note: note?.trim() || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'venue_id,pattern_type,pattern' }
    )
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  clearFilterCache(auth.venueId)
  return NextResponse.json({ filter: data })
}

export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })

  const supabase = createServiceClient()
  // Scope delete to venue to prevent cross-tenant deletion.
  const { error } = await supabase
    .from('venue_email_filters')
    .delete()
    .eq('id', id)
    .eq('venue_id', auth.venueId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  clearFilterCache(auth.venueId)
  return NextResponse.json({ success: true })
}
