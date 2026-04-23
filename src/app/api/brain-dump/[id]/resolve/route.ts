import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

/**
 * Resolve a pending brain-dump clarification.
 *
 * POST /api/brain-dump/:id/resolve
 * Body: { action: 'confirm' | 'dismiss', answer?: string }
 *
 * Confirm writes the coordinator's answer into clarification_answer,
 * flips parse_status to 'confirmed', and stamps resolved_at. Dismiss
 * flips parse_status to 'dismissed'. Neither branch re-runs the
 * classifier — the spec's intent here is human-in-the-loop: the
 * coordinator's plain-English answer is authoritative.
 *
 * Venue-scoped: the entry's venue_id must match the caller's venue.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'Missing entry id' }, { status: 400 })

  let body: { action?: string; answer?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const action = body.action
  if (action !== 'confirm' && action !== 'dismiss') {
    return NextResponse.json({ error: 'action must be "confirm" or "dismiss"' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: entry, error: fetchErr } = await supabase
    .from('brain_dump_entries')
    .select('id, venue_id, parse_status')
    .eq('id', id)
    .single()
  if (fetchErr || !entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  if (entry.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const updates: Record<string, unknown> = {
    parse_status: action === 'confirm' ? 'confirmed' : 'dismissed',
    resolved_at: new Date().toISOString(),
  }
  if (action === 'confirm' && body.answer?.trim()) {
    updates.clarification_answer = body.answer.trim()
  }

  const { error: updateErr } = await supabase
    .from('brain_dump_entries')
    .update(updates)
    .eq('id', id)
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  return NextResponse.json({ id, status: updates.parse_status })
}
