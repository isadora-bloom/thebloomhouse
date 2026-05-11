/**
 * Bloom House - Wave 26 explicit send endpoint.
 *
 * POST /api/agent/drafts/[id]/send
 *
 * Why this exists
 * ---------------
 * Pre-Wave-26 the only outbound send mechanic was the PATCH at
 * /api/agent/drafts (which sends ALL approved drafts? No - just one by
 * body.draftId). That endpoint stays as a backward-compat path for
 * existing callers. Wave 26 adds an explicit per-id endpoint with a
 * cleaner REST shape (operator confirms send on a specific id) and
 * stricter status-machine: a draft MUST be in status='approved' to be
 * sent here. Status='pending' rejects with a clear error so the UI
 * can prompt the operator to approve first.
 *
 * Auto-FLAG-never-AUTO-EXECUTE doctrine (Wave 6D):
 *   - Approve writes the audit row (already does, via
 *     editAndApproveDraft / approveDraft).
 *   - Send is a separate operator decision. The UI MUST show a
 *     confirmation modal before calling this endpoint.
 *
 * Auth: requires getPlatformAuth() (coordinator / manager / admin).
 * Demo mode is blocked - real email sends would go to real recipients
 * which the demo flow never wants.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { sendApprovedDraft } from '@/lib/services/email/pipeline'
import { createServiceClient } from '@/lib/supabase/service'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Demo accounts must not trigger real Gmail sends.
  if (auth.isDemo) {
    return NextResponse.json(
      {
        error:
          'Real-email send is disabled in demo mode. Approve drafts via the UI; the demo flow shows the result without actually mailing the recipient.',
      },
      { status: 403 },
    )
  }

  const { id: draftId } = await params
  if (!draftId || typeof draftId !== 'string') {
    return NextResponse.json({ error: 'Missing draftId in path' }, { status: 400 })
  }

  // Pre-flight: verify the draft is in this venue + status='approved'.
  // Without this guard the underlying sendApprovedDraft would throw
  // generic errors; the API path produces a structured response.
  const supabase = createServiceClient()
  const { data: draft, error: fetchErr } = await supabase
    .from('drafts')
    .select('id, venue_id, status, to_email, subject')
    .eq('id', draftId)
    .maybeSingle()

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  }
  if (!draft) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  }

  // Scope: operator can only send drafts for their own venue. Auth
  // returns auth.venueId; the venue chip in the UI confirms scope.
  if (auth.venueId && (draft.venue_id as string) !== auth.venueId) {
    // Allow cross-venue sends only if the user is an org-level
    // platform admin (super admin handled by RLS already, but the
    // server-side service client bypasses RLS, so we explicit-check).
    if (auth.role !== 'admin' && auth.role !== 'manager') {
      return NextResponse.json(
        { error: 'Cannot send drafts for a venue outside your scope' },
        { status: 403 },
      )
    }
  }

  if (draft.status !== 'approved') {
    return NextResponse.json(
      {
        error: `Draft is in status='${draft.status}'. Only approved drafts can be sent.`,
        currentStatus: draft.status,
      },
      { status: 409 },
    )
  }

  try {
    await sendApprovedDraft(draftId)
    return NextResponse.json({
      ok: true,
      sent: true,
      to: draft.to_email,
      subject: draft.subject,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Send failed'
    console.error('[api/agent/drafts/[id]/send] send failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
