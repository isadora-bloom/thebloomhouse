import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// POST { tourId, cancellationReason?, cancellationNote? }
//
// Flips tours.outcome → 'cancelled' and (optionally) records a structured
// reason + free-text note. Migration 166 added the columns; this route is
// the canonical writer for the coordinator-driven path.
//
// Body shape:
//   { tourId: string,
//     cancellationReason?: 'weather' | 'date_conflict' | 'family_emergency'
//                        | 'venue_concern' | 'travel_blocker' | 'rescheduled'
//                        | 'no_show_followup' | 'other',
//     cancellationNote?: string  // ≤ 280 chars }
//
// Auth: coordinator / manager / org_admin / super_admin. The tour must
// belong to the caller's venue (or org for admins). Mirrors the pattern
// in /api/agent/post-tour-brief.
//
// Backwards compatibility: callers that pass no reason still flip the
// outcome to 'cancelled' (existing behaviour). The reason fields stay
// NULL — same as every legacy row.
// ---------------------------------------------------------------------------

const VALID_REASONS = new Set([
  'weather',
  'date_conflict',
  'family_emergency',
  'venue_concern',
  'travel_blocker',
  'rescheduled',
  'no_show_followup',
  'other',
])

const MAX_NOTE_CHARS = 280

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    tourId?: string
    cancellationReason?: string
    cancellationNote?: string
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const tourId = body?.tourId
  if (!tourId || typeof tourId !== 'string') {
    return NextResponse.json({ error: 'tourId is required' }, { status: 400 })
  }

  // Validate reason (optional). Reject unknown buckets so the DB CHECK
  // never has to bounce the write.
  let reason: string | null = null
  if (body.cancellationReason !== undefined && body.cancellationReason !== null) {
    if (typeof body.cancellationReason !== 'string') {
      return NextResponse.json(
        { error: 'cancellationReason must be a string' },
        { status: 400 }
      )
    }
    if (body.cancellationReason !== '' && !VALID_REASONS.has(body.cancellationReason)) {
      return NextResponse.json(
        {
          error:
            'cancellationReason must be one of: weather, date_conflict, family_emergency, venue_concern, travel_blocker, rescheduled, no_show_followup, other',
        },
        { status: 400 }
      )
    }
    reason = body.cancellationReason === '' ? null : body.cancellationReason
  }

  // Validate note (optional, capped). Trimmed; empty → null.
  let note: string | null = null
  if (body.cancellationNote !== undefined && body.cancellationNote !== null) {
    if (typeof body.cancellationNote !== 'string') {
      return NextResponse.json(
        { error: 'cancellationNote must be a string' },
        { status: 400 }
      )
    }
    const trimmed = body.cancellationNote.trim()
    if (trimmed.length > MAX_NOTE_CHARS) {
      return NextResponse.json(
        { error: `cancellationNote exceeds ${MAX_NOTE_CHARS} characters` },
        { status: 400 }
      )
    }
    note = trimmed.length === 0 ? null : trimmed
  }

  try {
    const service = createServiceClient()
    const { data: tour } = await service
      .from('tours')
      .select('id, venue_id, outcome, venues:venues!inner(org_id)')
      .eq('id', tourId)
      .maybeSingle()

    if (!tour) {
      return NextResponse.json({ error: 'Tour not found' }, { status: 404 })
    }

    const tourVenueId = tour.venue_id as string
    const tourOrgId = (
      tour.venues as unknown as { org_id: string | null } | null
    )?.org_id

    const isAdmin = auth.role === 'org_admin' || auth.role === 'super_admin'
    if (!isAdmin && tourVenueId !== auth.venueId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (isAdmin && auth.orgId && tourOrgId && tourOrgId !== auth.orgId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Build the update payload. Only set columns the caller actually
    // touched so partial updates (e.g., backfilling a reason on an
    // already-cancelled tour) work without clobbering the existing note.
    const updates: Record<string, unknown> = { outcome: 'cancelled' }
    if (reason !== null || body.cancellationReason !== undefined) {
      updates.cancellation_reason = reason
    }
    if (note !== null || body.cancellationNote !== undefined) {
      updates.cancellation_note = note
    }

    const { error: updErr } = await service
      .from('tours')
      .update(updates)
      .eq('id', tourId)

    if (updErr) {
      console.error('[api/agent/tour-cancel] update failed:', updErr.message)
      return NextResponse.json(
        { error: 'Failed to update tour' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      tourId,
      outcome: 'cancelled',
      cancellationReason: reason,
      cancellationNote: note,
    })
  } catch (err) {
    console.error('[api/agent/tour-cancel] POST error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
