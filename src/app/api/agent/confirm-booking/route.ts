import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Confirm Booking API
//
// POST — Coordinator response to a `booking_confirmation_prompt` notification.
//   Body: { notificationId, weddingId, confirmed: boolean }
//
// If confirmed=true:
//   1. Mark the notification read.
//   2. UPDATE weddings SET status='booked' WHERE id=weddingId.
//   3. The trigger `trg_weddings_stamp_status_dates` (migration 073) stamps
//      booked_at=now() automatically.
//   4. The trigger `trg_weddings_sync_availability` bumps
//      venue_availability.booked_count for the wedding_date — status flips
//      to 'booked' when booked_count hits max_events, otherwise stays
//      'available' with one slot consumed.
//   5. No explicit venue_availability write from this route; the trigger
//      owns the sync.
//
// If confirmed=false (coordinator dismissed):
//   1. Mark the notification read. No state change to the wedding.
//
// Auth: the coordinator must be authenticated to the venue the notification
// belongs to. Uses getPlatformAuth + an eq check so a user can't confirm
// bookings at another venue by guessing UUIDs.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: { notificationId?: string; weddingId?: string; confirmed?: boolean }
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { notificationId, weddingId, confirmed } = payload
  if (!notificationId || typeof confirmed !== 'boolean') {
    return NextResponse.json(
      { error: 'Missing notificationId or confirmed' },
      { status: 400 }
    )
  }

  const supabase = createServiceClient()

  // Verify the notification belongs to this venue before any state change.
  const { data: notifRow, error: notifErr } = await supabase
    .from('admin_notifications')
    .select('id, venue_id, wedding_id, type')
    .eq('id', notificationId)
    .maybeSingle()

  if (notifErr || !notifRow) {
    return NextResponse.json(
      { error: 'Notification not found' },
      { status: 404 }
    )
  }

  if (notifRow.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (notifRow.type !== 'booking_confirmation_prompt') {
    return NextResponse.json(
      { error: 'Notification is not a booking prompt' },
      { status: 400 }
    )
  }

  // If confirming, flip the wedding status. The DB triggers handle
  // booked_at stamping and venue_availability.booked_count sync.
  if (confirmed) {
    const targetWeddingId = weddingId || notifRow.wedding_id
    if (!targetWeddingId) {
      return NextResponse.json(
        { error: 'Notification has no linked wedding' },
        { status: 400 }
      )
    }

    // Cross-venue defence: ensure the wedding is also scoped to this venue
    // before we transition it. Catches payload spoofing.
    const { data: weddingRow, error: weddingErr } = await supabase
      .from('weddings')
      .select('id, venue_id, status')
      .eq('id', targetWeddingId)
      .maybeSingle()

    if (weddingErr || !weddingRow) {
      return NextResponse.json(
        { error: 'Wedding not found' },
        { status: 404 }
      )
    }

    if (weddingRow.venue_id !== auth.venueId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Idempotent — if the coordinator confirms twice (double-click), the
    // second update is a no-op at the state level; booked_at stays the
    // value the trigger set on the first transition.
    if (weddingRow.status !== 'booked' && weddingRow.status !== 'completed') {
      const { error: updateErr } = await supabase
        .from('weddings')
        .update({ status: 'booked' })
        .eq('id', targetWeddingId)

      if (updateErr) {
        return NextResponse.json(
          { error: updateErr.message },
          { status: 500 }
        )
      }
      // Coordinator-confirmed booking — write a contract_signed
      // touchpoint with the wedding's first-touch source so /intel/
      // sources counts this in funnel conversion. Best-effort.
      try {
        const { recordStatusChangeTouchpoint } = await import('@/lib/services/touchpoints')
        const { data: w } = await supabase.from('weddings').select('source').eq('id', targetWeddingId).maybeSingle()
        await recordStatusChangeTouchpoint(auth.venueId, targetWeddingId, 'booked', {
          source: (w?.source as string | null) ?? null,
          medium: 'coordinator',
          metadata: { confirmed_by: 'coordinator_ui' },
        })
      } catch (err) {
        console.warn('[confirm-booking] touchpoint failed:', err)
      }
    }
  }

  // Always mark read — confirmed or dismissed, the prompt is resolved.
  const { error: markErr } = await supabase
    .from('admin_notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('id', notificationId)

  if (markErr) {
    return NextResponse.json(
      { error: markErr.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true, confirmed })
}
