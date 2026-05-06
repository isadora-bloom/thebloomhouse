import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Auto-Send Cancel API
//
// POST — Cancel a pending auto-send before it fires.
//   Body: { notificationId, draftId }
//
// Marks the admin_notification as read and the draft as rejected with
// reason 'cancelled_auto_send'. Auth: coordinator must own the draft's
// venue. Pre-fix any caller could pass any draftId/notificationId and
// reject another venue's pending draft + write a feedback record into
// that venue's draft_feedback table. Per 2026-05-06 audit Lens 1.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const { notificationId, draftId } = body as {
      notificationId: string
      draftId: string
    }

    if (!notificationId || !draftId) {
      return NextResponse.json(
        { error: 'Missing notificationId or draftId' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Ownership pre-check: verify the draft belongs to a venue the
    // authenticated user can access. Admins bypass — they may operate
    // across the org. Demo mode: confined to the Crestwood allowlist
    // (already enforced by getPlatformAuth returning isDemo=true with
    // a fixed venueId, so the eq check below holds).
    const isAdmin = auth.role === 'org_admin' || auth.role === 'super_admin'
    const { data: draftOwnership } = await supabase
      .from('drafts')
      .select('venue_id')
      .eq('id', draftId)
      .maybeSingle()

    if (!draftOwnership) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
    }
    if (!isAdmin && draftOwnership.venue_id !== auth.venueId) {
      return NextResponse.json(
        { error: 'Forbidden: draft belongs to another venue' },
        { status: 403 }
      )
    }

    // Conditional cancel: only transition if the draft is still in
    // auto_send_pending. Once the flush cron has claimed it
    // ('auto_send_sending'), Gmail may already have the message — we
    // must not race-write 'rejected' over a successful send. Returning
    // zero rows here tells the caller they clicked too late.
    const { data: cancelled, error: cancelErr } = await supabase
      .from('drafts')
      .update({
        status: 'rejected',
        feedback_notes: 'cancelled_auto_send',
        approved_at: new Date().toISOString(),
      })
      .eq('id', draftId)
      .eq('status', 'auto_send_pending')
      .select('id')

    if (cancelErr) {
      return NextResponse.json(
        { error: cancelErr.message },
        { status: 500 }
      )
    }

    if (!cancelled || cancelled.length === 0) {
      // Either already sent, already rejected, or claimed mid-send.
      // Still mark the notification as read so the coordinator stops
      // seeing the cancel prompt.
      await supabase
        .from('admin_notifications')
        .update({
          read: true,
          read_at: new Date().toISOString(),
        })
        .eq('id', notificationId)

      return NextResponse.json({
        success: true,
        cancelled: false,
        reason: 'Draft was already sent or no longer pending',
      })
    }

    // Mark the notification as read (cancelled)
    await supabase
      .from('admin_notifications')
      .update({
        read: true,
        read_at: new Date().toISOString(),
      })
      .eq('id', notificationId)

    // Create a feedback record for the learning loop
    const { data: draft } = await supabase
      .from('drafts')
      .select('venue_id, draft_body, subject, context_type')
      .eq('id', draftId)
      .single()

    if (draft) {
      // T5-α.1 fix: schema columns are action / original_body /
      // rejection_reason / metadata (jsonb). Previous writer used
      // non-existent feedback_type + original_subject + email_category
      // so every cancel here was silently dropping zero rows.
      await supabase.from('draft_feedback').insert({
        venue_id: draft.venue_id,
        draft_id: draftId,
        action: 'rejected',
        original_body: (draft.draft_body as string) ?? '',
        rejection_reason: 'cancelled_auto_send',
        metadata: {
          original_subject: (draft.subject as string) ?? '',
          email_category: (draft.context_type as string) ?? 'inquiry',
        },
      })
    }

    return NextResponse.json({ success: true, cancelled: true })
  } catch (err) {
    console.error('[auto-send-cancel] POST failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
