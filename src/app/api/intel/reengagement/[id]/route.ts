import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { sendEmail } from '@/lib/services/gmail'
import { appendAIDisclosure, fetchDisclosureContext } from '@/lib/services/brain/ai-disclosure'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

/**
 * POST /api/intel/reengagement/[id]
 *   body = { action: 'send', channel, sent_text, recipient_email? }
 *        | { action: 'discard' }
 *
 *   Marks the re-engagement action as sent or discarded. For
 *   channel='email' the body is also actually sent via Gmail
 *   (using the venue's connected account). For 'manual_paste'
 *   the coordinator copies the text manually — the API just
 *   records that they did so.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: actionId } = await context.params
  if (!actionId) return NextResponse.json({ error: 'Missing action id' }, { status: 400 })

  const body = await req.json().catch(() => ({})) as {
    action?: unknown
    channel?: unknown
    sent_text?: unknown
    recipient_email?: unknown
  }

  const sb = createServiceClient()

  // Confirm ownership of the action.
  const { data: row } = await sb
    .from('re_engagement_actions')
    .select('id, venue_id, candidate_identity_id, draft_text, sent_at, channel')
    .eq('id', actionId)
    .maybeSingle()
  if (!row || (row as { venue_id: string }).venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Action not found in this venue' }, { status: 404 })
  }
  const action = row as { id: string; venue_id: string; candidate_identity_id: string; draft_text: string; sent_at: string | null; channel: string | null }

  if (action.sent_at || action.channel) {
    return NextResponse.json({ error: 'Action already sent or discarded' }, { status: 409 })
  }

  if (body.action === 'discard') {
    const { error } = await sb
      .from('re_engagement_actions')
      .update({
        channel: 'discarded',
        sent_at: new Date().toISOString(),
        sent_by: auth.userId ?? null,
      })
      .eq('id', actionId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, status: 'discarded' })
  }

  if (body.action !== 'send') {
    return NextResponse.json({ error: "action must be 'send' or 'discard'" }, { status: 400 })
  }

  const channel = body.channel === 'email' || body.channel === 'manual_paste' ? body.channel : null
  const sentText = typeof body.sent_text === 'string' && body.sent_text.trim() ? body.sent_text.trim() : action.draft_text
  if (!channel) {
    return NextResponse.json({ error: "channel must be 'email' or 'manual_paste'" }, { status: 400 })
  }

  if (channel === 'email') {
    // Email channel: actually send through the venue's Gmail. The
    // candidate's email comes from the request body so the
    // coordinator can override / pick a fresh one.
    const recipient = typeof body.recipient_email === 'string' ? body.recipient_email.trim() : null
    if (!recipient) {
      return NextResponse.json({ error: 'recipient_email required for email channel' }, { status: 400 })
    }
    // Subject defaults to a soft, generic line — the coordinator
    // can fold a subject into the body if they want something
    // bespoke. Keeping subject generic prevents a Knot/IG name
    // from sneaking into a venue-direct cold email.
    const subject = 'A note from the team'
    // Stream EEEE: re-engagement emails ARE Sage-drafted outbound, so
    // the disclosure footer applies. Without this, cold re-engagement
    // bypassed the only legal-disclosure surface in the product.
    const disclosureCtx = await fetchDisclosureContext(auth.venueId)
    const bodyWithDisclosure = appendAIDisclosure(sentText, disclosureCtx)
    const messageId = await sendEmail(auth.venueId, recipient, subject, bodyWithDisclosure)
    if (!messageId) {
      return NextResponse.json({ error: 'Gmail send failed' }, { status: 500 })
    }
  }

  const { error } = await sb
    .from('re_engagement_actions')
    .update({
      sent_at: new Date().toISOString(),
      sent_by: auth.userId ?? null,
      channel,
      sent_text: sentText,
    })
    .eq('id', actionId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, status: 'sent', channel })
}
