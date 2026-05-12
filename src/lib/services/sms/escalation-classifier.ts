/**
 * Bloom House: SMS Escalation Classifier
 *
 * Pattern 9 W5: voice-channel parity for escalation routing.
 *
 * Email today: classifyEscalation() (src/lib/services/email/escalation-classifier.ts)
 * runs on every inbound, sets interactions.escalation_requested, fires
 * admin_notifications, and the pipeline skips draft generation. SMS had
 * none of this. a "can I talk to a real person?" SMS just sat there
 * and Sage kept drafting auto-replies.
 *
 * Two-stage detection mirroring the email-side shape:
 *   1. Regex fast-path on body (no subject for SMS). Same
 *      HUMAN_ESCALATION_PATTERN already proven on the email side.
 *   2. Haiku judge for the natural-language tail.
 *
 * Returns a structured verdict. Caller stamps interactions.
 * sms_escalation_requested_at + sms_escalation_reason and fires the
 * admin_notifications row.
 */

import { callAI } from '@/lib/ai/client'
import { HUMAN_ESCALATION_PATTERN } from '@/lib/services/email/pipeline'
import { createServiceClient } from '@/lib/supabase/service'
import { createNotification } from '@/lib/services/admin-notifications'

export const SMS_ESCALATION_PROMPT_VERSION = 'sms-escalation.prompt.v1'

export interface ClassifySmsEscalationInput {
  venueId: string
  body: string
  aiName?: string
  correlationId?: string
}

export interface ClassifySmsEscalationResult {
  escalation_requested: boolean
  reason: 'magic_words' | 'haiku_detected' | null
  confidence_0_100: number
  prompt_version: string | null
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

function buildSystemPrompt(aiName: string): string {
  return [
    `You are classifying whether an inbound SMS to a wedding venue is asking to escalate from the AI assistant (${aiName}) to a human coordinator.`,
    '',
    'Return JSON: {"escalation_requested": true|false, "confidence_0_100": <integer>, "reason": "<short string>"}.',
    '',
    'Escalation = the sender wants a human, not the AI. Signals:',
    '- explicit ask ("can I talk to a person", "is this a bot", "real human please")',
    '- frustration with prior automated replies',
    '- legal / urgent / refund / contract dispute language',
    '- "stop the bot", "no more AI", "this is annoying"',
    '',
    'NOT escalation:',
    '- normal venue questions ("can we tour Saturday?", "what is your price?")',
    '- friendly chatter',
    '- thanking the assistant',
    '- mentions of "people" in a wedding-logistics sense ("we have 120 people coming")',
    '',
    'Respond with JSON only. No prose.',
  ].join('\n')
}

function buildUserPrompt(body: string): string {
  return `INBOUND SMS:\n${body}`
}

export async function classifySmsEscalation(
  input: ClassifySmsEscalationInput,
): Promise<ClassifySmsEscalationResult> {
  const { venueId, body, aiName, correlationId } = input
  const safeBody = body ?? ''

  // Fast path: regex hit on the body. SMS has no subject so we run only
  // on body. HUMAN_ESCALATION_PATTERN is the same one the email side
  // uses and is venue-agnostic.
  if (safeBody && HUMAN_ESCALATION_PATTERN.test(safeBody)) {
    return {
      escalation_requested: true,
      reason: 'magic_words',
      confidence_0_100: 95,
      prompt_version: null,
    }
  }

  // Slow path: Haiku judgement. Tier 2 content (couple PII in body).
  if (!safeBody.trim()) {
    return {
      escalation_requested: false,
      reason: null,
      confidence_0_100: 0,
      prompt_version: null,
    }
  }

  try {
    const ai = await callAI({
      systemPrompt: buildSystemPrompt(aiName ?? 'the assistant'),
      userPrompt: buildUserPrompt(safeBody),
      maxTokens: 150,
      temperature: 0.1,
      venueId,
      taskType: 'sms_escalation_detect',
      tier: 'haiku',
      contentTier: 2,
      promptVersion: SMS_ESCALATION_PROMPT_VERSION,
      correlationId,
    })

    const stripped = stripFences(ai.text)
    let parsed: { escalation_requested?: unknown; confidence_0_100?: unknown; reason?: unknown } = {}
    try {
      parsed = JSON.parse(stripped)
    } catch {
      return {
        escalation_requested: false,
        reason: null,
        confidence_0_100: 0,
        prompt_version: SMS_ESCALATION_PROMPT_VERSION,
      }
    }

    const flag = parsed.escalation_requested === true
    const conf = typeof parsed.confidence_0_100 === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.confidence_0_100)))
      : 0

    return {
      escalation_requested: flag,
      reason: flag ? 'haiku_detected' : null,
      confidence_0_100: conf,
      prompt_version: SMS_ESCALATION_PROMPT_VERSION,
    }
  } catch (err) {
    console.warn(
      `[sms-escalation] classifier failed (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    )
    return {
      escalation_requested: false,
      reason: null,
      confidence_0_100: 0,
      prompt_version: SMS_ESCALATION_PROMPT_VERSION,
    }
  }
}

/**
 * Convenience wrapper: classify + stamp the interaction row + fire the
 * admin_notifications row when escalation is detected. Best-effort: any
 * failure is logged but never re-thrown so the SMS persist path is never
 * blocked.
 *
 * Called from openphone.ts after the SMS interaction is inserted.
 */
export async function classifyAndPersistSmsEscalation(args: {
  venueId: string
  interactionId: string
  weddingId: string | null
  body: string
  fromPhone: string | null
  correlationId?: string
}): Promise<void> {
  const { venueId, interactionId, weddingId, body, fromPhone, correlationId } = args
  if (!body || !body.trim()) return

  const supabase = createServiceClient()

  // Look up the venue's AI name for the prompt + notification copy.
  let aiName = 'your assistant'
  try {
    const { data } = await supabase
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', venueId)
      .maybeSingle()
    aiName = (data?.ai_name as string | null) ?? 'your assistant'
  } catch {
    // Use the default.
  }

  const verdict = await classifySmsEscalation({
    venueId,
    body,
    aiName,
    correlationId,
  })

  if (!verdict.escalation_requested) return

  // Stamp the row.
  try {
    await supabase
      .from('interactions')
      .update({
        sms_escalation_requested_at: new Date().toISOString(),
        sms_escalation_reason: verdict.reason,
      })
      .eq('id', interactionId)
  } catch (err) {
    console.warn(
      `[sms-escalation] stamp failed (interaction ${interactionId}):`,
      err instanceof Error ? err.message : String(err),
    )
  }

  // Fire admin notification.
  try {
    await createNotification({
      venueId,
      weddingId: weddingId ?? undefined,
      type: 'sms_escalation_requested',
      title: `Couple asked for a human on SMS${fromPhone ? ` (${fromPhone})` : ''}`,
      body: JSON.stringify({
        interactionId,
        fromPhone,
        reason: verdict.reason,
        confidence_0_100: verdict.confidence_0_100,
        excerpt: body.slice(0, 200),
      }),
      priority: 'high',
      correlationId: correlationId ?? null,
    })
  } catch (err) {
    console.warn(
      `[sms-escalation] notification failed (interaction ${interactionId}):`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
