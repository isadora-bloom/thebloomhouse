/**
 * Bloom House - Wave 26 draft-insights endpoint.
 *
 * GET  /api/agent/drafts/[id]/insights
 *   Returns the draft_edit_insights rows for this draft so the post-
 *   approve learning toast can render them. Used by the
 *   "I noticed N things from your edits" modal in the approval queue.
 *
 * POST /api/agent/drafts/[id]/insights/acknowledge
 *   (Implemented in ./acknowledge/route.ts - bulk-stamp all insights
 *   for this draft as acknowledged.)
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  refuseDemo,
} from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { apiError } from '@/lib/api/api-error'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: draftId } = await params
  if (!draftId) {
    return NextResponse.json({ error: 'Missing draftId' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Scope guard - confirm the draft belongs to a venue the caller can see.
  const { data: draftRow } = await supabase
    .from('drafts')
    .select('venue_id')
    .eq('id', draftId)
    .maybeSingle()

  if (!draftRow) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  }

  // The old carve-out tested for the roles 'admin' and 'manager'. No row
  // has ever carried 'admin', so org_admins were refused and the check
  // turned on a string nobody uses. assertCanAccessVenue knows the real
  // vocabulary, and refuses a demo caller any venue outside Crestwood.
  const decision = await assertCanAccessVenue(auth, draftRow.venue_id as string)
  if (!decision.ok) {
    return NextResponse.json(
      { error: 'Cannot view insights for a draft outside your scope' },
      { status: 403 },
    )
  }

  const { data: insights, error } = await supabase
    .from('draft_edit_insights')
    .select(
      'id, insight_kind, sage_text, operator_text, learning_summary, persisted_to, persisted_ref, confidence_0_100, operator_visible, operator_acknowledged_at, operator_correction, created_at',
    )
    .eq('draft_id', draftId)
    .order('created_at', { ascending: true })

  if (error) {
    return apiError(error)
  }

  return NextResponse.json({ insights: insights ?? [] })
}

/** POST acknowledges all insights for this draft (bulk operator
 *  dismiss-the-toast action). The granular per-insight correction is on
 *  the [insightId] route. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The demo identity is an anonymous visitor. It may read the insights;
  // it may not stamp them acknowledged.
  const demoRefusal = refuseDemo(auth)
  if (demoRefusal) return demoRefusal

  const { id: draftId } = await params
  if (!draftId) {
    return NextResponse.json({ error: 'Missing draftId' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: draftRow } = await supabase
    .from('drafts')
    .select('venue_id')
    .eq('id', draftId)
    .maybeSingle()

  if (!draftRow) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  }

  const decision = await assertCanAccessVenue(auth, draftRow.venue_id as string)
  if (!decision.ok) {
    return NextResponse.json(
      { error: 'Cannot acknowledge insights outside your scope' },
      { status: 403 },
    )
  }

  const { error: updErr } = await supabase
    .from('draft_edit_insights')
    .update({ operator_acknowledged_at: new Date().toISOString() })
    .eq('draft_id', draftId)
    .is('operator_acknowledged_at', null)

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
