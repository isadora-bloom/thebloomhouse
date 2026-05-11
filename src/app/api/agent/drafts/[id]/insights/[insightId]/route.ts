/**
 * Bloom House - Wave 26 per-insight correction endpoint.
 *
 * PATCH /api/agent/drafts/[id]/insights/[insightId]
 *   Operator flags a learning as wrong. Writes operator_correction
 *   on the insight row and unwinds the underlying persistence (e.g.
 *   deactivates the voice_preferences row or the knowledge_captures
 *   row that this insight created).
 *
 *   Body: { correction: string }
 *
 * Why this matters
 * ----------------
 * Wave 4 doctrine: every learning has visible evidence and a way for
 * the operator to override. Without this endpoint, a wrong analyzer
 * call would silently poison the voice / knowledge sinks. With it,
 * the operator can correct in one click and the platform unwinds.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; insightId: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: draftId, insightId } = await params
  if (!draftId || !insightId) {
    return NextResponse.json(
      { error: 'Missing draftId or insightId in path' },
      { status: 400 },
    )
  }

  let body: { correction?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const correction = typeof body.correction === 'string' ? body.correction.trim() : ''
  if (!correction) {
    return NextResponse.json(
      { error: 'correction is required and must be a non-empty string' },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()

  const { data: insight, error: fetchErr } = await supabase
    .from('draft_edit_insights')
    .select('id, venue_id, draft_id, persisted_to, persisted_ref')
    .eq('id', insightId)
    .eq('draft_id', draftId)
    .maybeSingle()

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  }
  if (!insight) {
    return NextResponse.json({ error: 'Insight not found' }, { status: 404 })
  }

  // Scope guard.
  if (auth.venueId && (insight.venue_id as string) !== auth.venueId) {
    if (auth.role !== 'admin' && auth.role !== 'manager') {
      return NextResponse.json(
        { error: 'Cannot correct insights outside your scope' },
        { status: 403 },
      )
    }
  }

  // Unwind persistence. We deactivate rather than hard-delete so the
  // audit trail (when, who) is preserved. Wave 4 evidence doctrine.
  const persistedTo = insight.persisted_to as string
  const persistedRef = insight.persisted_ref as string | null

  if (persistedRef) {
    try {
      if (persistedTo === 'voice_preferences') {
        // No "active" column on voice_preferences. The cleanest unwind
        // is to delete the row - voice_preferences is a small per-venue
        // table and the upsert+delete pattern is reversible. The
        // correction text lives on the insight row as the audit trail.
        await supabase.from('voice_preferences').delete().eq('id', persistedRef)
      } else if (persistedTo === 'knowledge_captures') {
        // knowledge_captures has an active flag - deactivate rather
        // than delete so any prior cross-references stay intact.
        await supabase
          .from('knowledge_captures')
          .update({ active: false })
          .eq('id', persistedRef)
      }
    } catch (err) {
      console.warn('[api/agent/drafts/insights] unwind threw:', err)
      // Continue - we still want the correction stamp written.
    }
  }

  const { error: updErr } = await supabase
    .from('draft_edit_insights')
    .update({
      operator_correction: correction.slice(0, 1000),
      operator_acknowledged_at: new Date().toISOString(),
      persisted_ref: null, // unwound
    })
    .eq('id', insightId)

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, unwound: persistedRef !== null })
}
