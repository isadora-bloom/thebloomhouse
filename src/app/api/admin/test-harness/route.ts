/**
 * PRIVATE admin test harness — invokes server-side service functions
 * for behavioural tests that can't run from a standalone Node script.
 *
 * Gated by TEST_HARNESS_SECRET. Intentionally a SEPARATE secret from
 * CRON_SECRET because CRON_SECRET must be set in prod (Vercel cron
 * needs it), and sharing one secret would mean this destructive
 * endpoint is enabled in prod by default. Prod deploys should leave
 * TEST_HARNESS_SECRET unset — endpoint then returns 501 and is inert.
 * Local dev / CI runs that need the harness set TEST_HARNESS_SECRET
 * explicitly. If you're debugging a production issue and NEED to run
 * this, set TEST_HARNESS_SECRET in Vercel, run the action, unset it.
 *
 * Backward compat: if TEST_HARNESS_SECRET is unset but CRON_SECRET is
 * set AND NODE_ENV !== 'production', we fall back to CRON_SECRET so
 * existing dev scripts keep working. In production this fallback is
 * disabled — TEST_HARNESS_SECRET must be set explicitly.
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
 *   - check_auto_send_eligible: calls autonomous-sender eligibility
 *     check (for testing thread-cap + daily-limit behaviour).
 *
 * Usage example (from the e2e test harness):
 *   POST /api/admin/test-harness
 *   Header: Authorization: Bearer <TEST_HARNESS_SECRET>
 *   Body: { action: 'process_incoming_email', venueId, email: {...} }
 */

import { NextRequest, NextResponse } from 'next/server'

function resolveSecret(): string | null {
  const harnessSecret = process.env.TEST_HARNESS_SECRET
  if (harnessSecret) return harnessSecret
  // Non-prod fallback to CRON_SECRET so local dev / CI without the
  // dedicated harness secret still works. Prod requires explicit set.
  if (process.env.NODE_ENV !== 'production' && process.env.CRON_SECRET) {
    return process.env.CRON_SECRET
  }
  return null
}

export async function POST(request: NextRequest) {
  const expected = resolveSecret()
  if (!expected) {
    return NextResponse.json(
      { error: 'Admin test harness disabled (TEST_HARNESS_SECRET unset)' },
      { status: 501 }
    )
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

    if (action === 'check_auto_send_eligible') {
      const { checkAutoSendEligible } = await import('@/lib/services/autonomous-sender')
      const opts = payload.options as unknown as {
        contextType: string
        confidenceScore: number
        source?: string
        threadId?: string
      }
      const result = await checkAutoSendEligible(venueId, opts)
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
