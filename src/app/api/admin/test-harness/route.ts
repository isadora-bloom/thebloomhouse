/**
 * PRIVATE admin test harness — invokes server-side service functions
 * for behavioural tests that can't run from a standalone Node script.
 *
 * Gated by CRON_SECRET (same shared secret Vercel cron uses). This
 * endpoint is NOT surfaced in any UI, has NO user-level auth, and is
 * only reachable by clients that know the secret. If CRON_SECRET is
 * unset in the environment, the endpoint returns 501 so it's inert
 * in any deployment that forgot to configure it.
 *
 * Supported actions:
 *   - process_incoming_email: runs the full email-pipeline ingest path
 *     (classify → resolve → match → draft → signal cross-check) for a
 *     synthetic email. Returns the PipelineResult.
 *   - generate_inquiry_draft: invokes inquiry-brain directly with the
 *     provided InquiryDraftOptions. Returns the DraftResult shape.
 *
 * Usage example (from the e2e test harness):
 *   POST /api/admin/test-harness
 *   Header: Authorization: Bearer <CRON_SECRET>
 *   Body: { action: 'process_incoming_email', venueId, email: {...} }
 */

import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'Admin test harness disabled (CRON_SECRET unset)' }, { status: 501 })
  }
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: { action?: string; venueId?: string; email?: Record<string, unknown>; options?: Record<string, unknown> }
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const action = payload.action
  const venueId = payload.venueId
  if (!action || !venueId) {
    return NextResponse.json({ error: 'action and venueId are required' }, { status: 400 })
  }

  try {
    if (action === 'process_incoming_email') {
      const { processIncomingEmail } = await import('@/lib/services/email-pipeline')
      const email = payload.email as unknown as {
        messageId: string; threadId: string; from: string; to: string
        subject: string; body: string; date: string
        connectionId?: string; labels?: string[]; headers?: Record<string, string>
      }
      const result = await processIncomingEmail(venueId, email)
      return NextResponse.json({ ok: true, result })
    }

    if (action === 'generate_inquiry_draft') {
      const { generateInquiryDraft } = await import('@/lib/services/inquiry-brain')
      const result = await generateInquiryDraft(
        payload.options as unknown as Parameters<typeof generateInquiryDraft>[0]
      )
      return NextResponse.json({ ok: true, result })
    }

    if (action === 'compute_weekly_learned') {
      const { computeWeeklyLearned } = await import('@/lib/services/weekly-learned')
      const result = await computeWeeklyLearned(venueId)
      return NextResponse.json({ ok: true, result })
    }

    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
      { status: 500 }
    )
  }
}
