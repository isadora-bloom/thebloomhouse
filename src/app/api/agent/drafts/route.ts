import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import {
  approveDraft,
  rejectDraft,
  editAndApproveDraft,
  sendApprovedDraft,
} from '@/lib/services/email-pipeline'

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function getAuthVenue() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('venue_id')
    .eq('id', user.id)
    .single()

  return profile?.venue_id
    ? { userId: user.id, venueId: profile.venue_id as string }
    : null
}

// ---------------------------------------------------------------------------
// GET — List drafts
//   ?status=pending|approved|rejected|sent (default: pending)
//   ?limit=20
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') ?? 'pending'
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100)

    const validStatuses = ['pending', 'approved', 'rejected', 'sent']
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    const { data: drafts, error } = await supabase
      .from('drafts')
      .select(`
        *,
        interactions:interaction_id (
          id,
          subject,
          body_preview,
          gmail_thread_id,
          timestamp
        )
      `)
      .eq('venue_id', auth.venueId)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ drafts: drafts ?? [] })
  } catch (err) {
    console.error('[api/agent/drafts] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Approve, reject, or edit+approve a draft
//   Body: {
//     draftId: string,
//     action: 'approve' | 'reject' | 'edit_approve',
//     editedBody?: string,    (required for edit_approve)
//     reason?: string         (optional for reject)
//   }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { draftId, action, editedBody, reason } = body

    if (!draftId || typeof draftId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid draftId' },
        { status: 400 }
      )
    }

    const validActions = ['approve', 'reject', 'edit_approve']
    if (!action || !validActions.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action. Must be one of: ${validActions.join(', ')}` },
        { status: 400 }
      )
    }

    if (action === 'edit_approve' && (!editedBody || typeof editedBody !== 'string')) {
      return NextResponse.json(
        { error: 'editedBody is required for edit_approve action' },
        { status: 400 }
      )
    }

    switch (action) {
      case 'approve':
        await approveDraft(draftId, auth.userId)
        break
      case 'reject':
        await rejectDraft(draftId, auth.userId, reason)
        break
      case 'edit_approve':
        await editAndApproveDraft(draftId, auth.userId, editedBody!)
        break
    }

    return NextResponse.json({ success: true, action })
  } catch (err) {
    console.error('[api/agent/drafts] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PATCH — Send an approved draft
//   Body: { draftId: string }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { draftId } = body

    if (!draftId || typeof draftId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid draftId' },
        { status: 400 }
      )
    }

    await sendApprovedDraft(draftId)

    return NextResponse.json({ success: true, sent: true })
  } catch (err) {
    console.error('[api/agent/drafts] PATCH error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
