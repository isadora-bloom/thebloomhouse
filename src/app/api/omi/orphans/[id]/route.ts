/**
 * /api/omi/orphans/[id]
 *
 * Phase 7 Task 61. Coordinator triage of un-matched Omi transcripts.
 *
 *   PATCH { attachToTourId } → attach the orphan's transcript to an existing
 *                              tour (appends to tours.transcript, copies the
 *                              omi_session_id, marks the orphan 'attached').
 *   PATCH { dismiss: true }  → mark orphan status='dismissed'. No tour write.
 *
 * The tour must belong to the same venue as the orphan. We enforce that on
 * the server side, not just in the UI, because orphans and tours live in
 * different tables and a sloppy client could cross-bind them.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const dismiss = (body as { dismiss?: unknown }).dismiss === true
  const attachToTourId =
    typeof (body as { attachToTourId?: unknown }).attachToTourId === 'string'
      ? ((body as { attachToTourId?: string }).attachToTourId as string)
      : null

  if (!dismiss && !attachToTourId) {
    return NextResponse.json(
      { error: 'Either attachToTourId or dismiss=true is required' },
      { status: 400 }
    )
  }

  const service = createServiceClient()
  const nowIso = new Date().toISOString()

  // Load orphan, scoped to the caller's venue.
  const { data: orphan, error: orphanErr } = await service
    .from('tour_transcript_orphans')
    .select('id, venue_id, omi_session_id, transcript, status')
    .eq('id', id)
    .eq('venue_id', auth.venueId)
    .maybeSingle()

  if (orphanErr) {
    console.error('[api/omi/orphans] load error:', orphanErr.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!orphan) {
    return NextResponse.json({ error: 'Orphan not found' }, { status: 404 })
  }
  if (orphan.status !== 'pending') {
    return NextResponse.json(
      { error: `Orphan already ${orphan.status}` },
      { status: 409 }
    )
  }

  // --- Dismiss path ---------------------------------------------------------
  if (dismiss) {
    const { error: dErr } = await service
      .from('tour_transcript_orphans')
      .update({ status: 'dismissed' })
      .eq('id', orphan.id)
      .eq('venue_id', auth.venueId)
    if (dErr) {
      console.error('[api/omi/orphans] dismiss error:', dErr.message)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    return NextResponse.json({ success: true, status: 'dismissed' })
  }

  // --- Attach path ----------------------------------------------------------
  const { data: tour, error: tourErr } = await service
    .from('tours')
    .select('id, venue_id, transcript')
    .eq('id', attachToTourId as string)
    .eq('venue_id', auth.venueId)
    .maybeSingle()

  if (tourErr) {
    console.error('[api/omi/orphans] tour load error:', tourErr.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!tour) {
    return NextResponse.json(
      { error: 'Tour not found for this venue' },
      { status: 404 }
    )
  }

  const current = typeof tour.transcript === 'string' ? tour.transcript : ''
  const orphanText = typeof orphan.transcript === 'string' ? orphan.transcript : ''
  const nextTranscript = current ? `${current} ${orphanText}` : orphanText

  const { error: upErr } = await service
    .from('tours')
    .update({
      transcript: nextTranscript,
      omi_session_id: orphan.omi_session_id,
      transcript_received_at: nowIso,
    })
    .eq('id', tour.id)
    .eq('venue_id', auth.venueId)

  if (upErr) {
    console.error('[api/omi/orphans] tour update error:', upErr.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const { error: markErr } = await service
    .from('tour_transcript_orphans')
    .update({
      status: 'attached',
      attached_to_tour_id: tour.id,
      attached_at: nowIso,
    })
    .eq('id', orphan.id)
    .eq('venue_id', auth.venueId)

  if (markErr) {
    console.error('[api/omi/orphans] mark error:', markErr.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    status: 'attached',
    tourId: tour.id,
  })
}
