/**
 * Bloom House — Regenerate a pending draft.
 *
 * POST /api/agent/drafts/[id]/regenerate
 *
 * Why this exists (2026-05-12)
 * ----------------------------
 * Pending drafts get stale fast. Emily Stegmeier's Tent Pricing draft
 * was generated before inquiry-brain v1.4 shipped, so it still tells
 * the couple to "book a tour" even though she scheduled (and cancelled)
 * one. Without a regenerate path the coordinator has to manually edit
 * every stale draft, or reject + wait for a fresh inbound to re-trigger
 * the pipeline.
 *
 * What it does
 * ------------
 * 1. Fetches the draft + its linked interaction (the original couple
 *    message Sage was replying to).
 * 2. Re-runs generateInquiryDraft / generateClientDraft against the
 *    CURRENT lead state — fresh wedding status, fresh tour-state, fresh
 *    engagement events, fresh classifier prompts.
 * 3. Replaces draft_body in place. Keeps the same draft.id so the
 *    approval queue ordering doesn't jitter. Updates prompt_version_used
 *    + original_sage_body so a future diff is meaningful.
 *
 * Behaviour rules
 * ---------------
 * - Only pending drafts can be regenerated. Approved / sent / rejected
 *   drafts are immutable by doctrine (audit trail).
 * - User-edited bodies are OVERWRITTEN — the operator clicked
 *   regenerate explicitly, they know what they're doing.
 * - Per-venue scope: callers can only regenerate their own venue's
 *   drafts. Demo is blocked (we don't burn real Claude tokens on
 *   demo accounts).
 *
 * Auth: getPlatformAuth(). Demo blocked.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  generateInquiryDraft,
  BRAIN_PROMPT_VERSION as INQUIRY_BRAIN_PROMPT_VERSION,
} from '@/lib/services/brain/inquiry'
import {
  generateClientDraft,
  BRAIN_PROMPT_VERSION as CLIENT_BRAIN_PROMPT_VERSION,
} from '@/lib/services/brain/client'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (auth.isDemo) {
    return NextResponse.json(
      { error: 'Regenerate is disabled in demo mode.' },
      { status: 403 },
    )
  }
  if (!auth.venueId) {
    return NextResponse.json(
      { error: 'No venue scope on session' },
      { status: 403 },
    )
  }

  const { id: draftId } = await params
  if (!draftId || typeof draftId !== 'string') {
    return NextResponse.json({ error: 'Missing draftId' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: draft, error: fetchErr } = await supabase
    .from('drafts')
    .select('id, venue_id, wedding_id, interaction_id, status, to_email, subject, context_type')
    .eq('id', draftId)
    .maybeSingle()

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  }
  if (!draft) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  }
  if ((draft.venue_id as string) !== auth.venueId) {
    return NextResponse.json(
      { error: 'Draft is outside your venue scope' },
      { status: 403 },
    )
  }
  if (draft.status !== 'pending') {
    return NextResponse.json(
      {
        error: `Draft is in status='${draft.status}'. Only pending drafts can be regenerated.`,
        currentStatus: draft.status,
      },
      { status: 409 },
    )
  }

  // Load the linked inbound interaction so the brain has the couple's
  // original message to reply to. Without an interaction_id we can't
  // reliably regenerate — the inquiry-brain needs context.
  const interactionId = draft.interaction_id as string | null
  if (!interactionId) {
    return NextResponse.json(
      { error: 'Draft has no linked interaction — cannot regenerate.' },
      { status: 422 },
    )
  }

  const { data: interaction, error: interErr } = await supabase
    .from('interactions')
    .select('id, from_email, from_name, subject, full_body, body_preview, wedding_id')
    .eq('id', interactionId)
    .maybeSingle()

  if (interErr) {
    return NextResponse.json({ error: interErr.message }, { status: 500 })
  }
  if (!interaction) {
    return NextResponse.json(
      { error: 'Linked interaction not found' },
      { status: 404 },
    )
  }

  const venueId = auth.venueId
  const weddingId =
    (draft.wedding_id as string | null) ??
    (interaction.wedding_id as string | null) ??
    null
  const fromEmail = (interaction.from_email as string | null) ?? draft.to_email as string
  const body =
    (interaction.full_body as string | null) ??
    (interaction.body_preview as string | null) ??
    ''
  const subject = (interaction.subject as string | null) ?? ''

  const correlationId = `regenerate-${draftId}-${Date.now()}`

  // Pick the right brain. context_type was stamped at original draft
  // time and tells us whether this is an inquiry-side reply (couple
  // pre-booking) or a client-side reply (booked couple).
  const contextType = (draft.context_type as string | null) ?? 'inquiry'

  try {
    let newBody = ''
    let newConfidence = 0
    let newPromptVersion = ''

    if (contextType === 'client' && weddingId) {
      const result = await generateClientDraft({
        venueId,
        contactEmail: fromEmail,
        weddingId,
        message: {
          from: fromEmail,
          subject,
          body,
        },
        taskType: 'client_reply',
        correlationId,
        interactionId,
      })
      newBody = result.draft
      newConfidence = result.confidence
      newPromptVersion = CLIENT_BRAIN_PROMPT_VERSION
    } else {
      const result = await generateInquiryDraft({
        venueId,
        contactEmail: fromEmail,
        inquiry: { from: fromEmail, subject, body },
        extractedData: { questions: [] },
        taskType: 'new_inquiry',
        weddingId,
        correlationId,
      })
      newBody = result.draft
      newConfidence = result.confidence
      newPromptVersion = INQUIRY_BRAIN_PROMPT_VERSION
    }

    if (!newBody || newBody.trim().length === 0) {
      return NextResponse.json(
        { error: 'Brain returned an empty draft — regeneration aborted.' },
        { status: 502 },
      )
    }

    const { error: updateErr } = await supabase
      .from('drafts')
      .update({
        draft_body: newBody,
        original_sage_body: newBody,
        confidence_score: newConfidence,
        prompt_version_used: newPromptVersion,
        correlation_id: correlationId,
      })
      .eq('id', draftId)
      .eq('status', 'pending')

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      regenerated: true,
      draftId,
      confidence: newConfidence,
      promptVersion: newPromptVersion,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Regenerate failed'
    console.error('[api/agent/drafts/[id]/regenerate] failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
