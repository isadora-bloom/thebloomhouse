import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Auto-Send Cancel API
//
// POST — Cancel a pending auto-send before it fires.
//   Body: { notificationId, draftId }
//
// Marks the admin_notification as read and the draft as rejected with
// reason 'cancelled_auto_send'.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
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

    // Mark the notification as read (cancelled)
    await supabase
      .from('admin_notifications')
      .update({
        read: true,
        read_at: new Date().toISOString(),
      })
      .eq('id', notificationId)

    // Mark the draft as rejected with cancellation reason
    await supabase
      .from('drafts')
      .update({
        status: 'rejected',
        feedback_notes: 'cancelled_auto_send',
        approved_at: new Date().toISOString(),
      })
      .eq('id', draftId)

    // Create a feedback record for the learning loop
    const { data: draft } = await supabase
      .from('drafts')
      .select('venue_id, draft_body, subject, context_type')
      .eq('id', draftId)
      .single()

    if (draft) {
      await supabase.from('draft_feedback').insert({
        venue_id: draft.venue_id,
        draft_id: draftId,
        feedback_type: 'rejected',
        original_subject: (draft.subject as string) ?? '',
        original_body: (draft.draft_body as string) ?? '',
        rejection_reason: 'cancelled_auto_send',
        email_category: (draft.context_type as string) ?? 'inquiry',
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
