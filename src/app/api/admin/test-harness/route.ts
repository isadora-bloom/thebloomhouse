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
 *   - compute_weekly_learned: invokes weekly-learned for the venue.
 *   - apply_daily_decay: runs the heat-mapping decay + cooling warnings
 *     + auto-mark-lost pass for the venue. Returns the DecaySummary.
 *   - import_identity_candidates: writes tangential_signals via the
 *     vision-extraction path (fires signal↔signal enqueue from F1).
 *   - enqueue_identity_matches: runs the person↔person matcher after
 *     a new person lands. Returns EnqueueResult.
 *   - record_engagement_event: fires a single engagement_event + heat
 *     recalc (for testing heat acceleration without the pipeline).
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

    if (action === 'apply_daily_decay') {
      const { applyDailyDecay } = await import('@/lib/services/heat-mapping')
      const result = await applyDailyDecay(venueId)
      return NextResponse.json({ ok: true, result })
    }

    if (action === 'import_identity_candidates') {
      const { importIdentityCandidates } = await import('@/lib/services/tangential-signals-import')
      const { createServiceClient } = await import('@/lib/supabase/service')
      const opts = payload.options as unknown as {
        candidates: Parameters<typeof importIdentityCandidates>[0]['candidates']
        sourceEntryId?: string | null
        sourceContext?: string | null
        signalDate?: string | null
      }
      const result = await importIdentityCandidates({
        supabase: createServiceClient(),
        venueId,
        candidates: opts.candidates,
        sourceEntryId: opts.sourceEntryId ?? null,
        sourceContext: opts.sourceContext ?? null,
        signalDate: opts.signalDate ?? null,
      })
      return NextResponse.json({ ok: true, result })
    }

    if (action === 'enqueue_identity_matches') {
      const { enqueueIdentityMatches } = await import('@/lib/services/identity-enqueue')
      const { createServiceClient } = await import('@/lib/supabase/service')
      const newPersonId = (payload.options as { newPersonId?: string } | undefined)?.newPersonId
      if (!newPersonId) {
        return NextResponse.json({ error: 'options.newPersonId required' }, { status: 400 })
      }
      const result = await enqueueIdentityMatches({
        supabase: createServiceClient(),
        venueId,
        newPersonId,
      })
      return NextResponse.json({ ok: true, result })
    }

    if (action === 'record_engagement_event') {
      const { recordEngagementEvent } = await import('@/lib/services/heat-mapping')
      const opts = payload.options as unknown as {
        weddingId: string
        eventType: string
        metadata?: Record<string, unknown>
      }
      if (!opts?.weddingId || !opts?.eventType) {
        return NextResponse.json({ error: 'options.weddingId and options.eventType required' }, { status: 400 })
      }
      const result = await recordEngagementEvent(venueId, opts.weddingId, opts.eventType, opts.metadata)
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
