// ---------------------------------------------------------------------------
// lifecycle/signal-detector.ts -- AI-driven LifecycleSignal extraction.
// ---------------------------------------------------------------------------
//
// Reads one inbound email and decides whether it carries a lifecycle signal
// (lead_declined / going_with_other / silent_close / tour_cancelled /
// tour_completed / contract_signed / deposit_paid). The signal is then fed
// into the pure state machine in wedding-lifecycle-engine.ts.
//
// This is the "deep fix" half of the 2026-05-08 Naina Davidar regression.
// A keyword-grep for "won't be moving forward" would patch the surfaced
// case but leave a dozen related state-machine gaps -- the AI detector
// covers the long tail (paraphrasing, platform-specific wording,
// non-English greetings, etc.) while staying defensive (returns null
// when nothing fires above 70% confidence so we never over-fire).
//
// Hard rules
// ----------
//   - Outbound rows return null. We never auto-decline our own leads.
//   - Empty body or pure auto-mail (out of office / undeliverable) return
//     null without an LLM call -- saves cost on noise.
//   - Body slice cap: 2000 chars. maxTokens: 200. tier: 'haiku',
//     temperature: 0.1, taskType: 'lifecycle_signal_detect'.
//   - Confidence floor: 70. Below that, return null -- the auto-draft
//     gate is consulted next, and a low-confidence signal that flips a
//     wedding to 'lost' is worse than a missed flip.
// ---------------------------------------------------------------------------

import { callAIJson } from '@/lib/ai/client'
import type { LifecycleSignal, WeddingStatus } from './wedding-lifecycle-engine'

/**
 * Logged to api_costs.prompt_version on every detector call so cost +
 * accuracy regressions can be tracked per revision. Bump + add a row in
 * PROMPTS-CHANGELOG.md when the system prompt or response contract
 * changes meaningfully.
 */
export const BRAIN_LIFECYCLE_SIGNAL_PROMPT_VERSION = 'lifecycle.signal.v1.0'

const BODY_SLICE_LIMIT = 2000
const CONFIDENCE_FLOOR = 70

// Signals the detector is allowed to emit. The full LifecycleSignal type
// includes inquiry_received / tour_requested / tour_scheduled /
// date_changed / wedding_held / wedding_cancelled, but those are produced
// by deterministic non-email paths (Calendly webhooks, classifier
// extractedData heat booleans, post-event coordinator action) -- letting
// the email-body detector emit them would double-fire.
const DETECTABLE_SIGNALS: ReadonlySet<LifecycleSignal> = new Set<LifecycleSignal>([
  'lead_declined',
  'going_with_other',
  'silent_close',
  'tour_cancelled',
  'tour_completed',
  'contract_signed',
  'deposit_paid',
])

export interface DetectedSignal {
  signal: LifecycleSignal | null
  confidence: number
  reason: string
}

const SYSTEM_PROMPT_LINES: string[] = [
  'You read one inbound email to a wedding venue and decide whether it',
  'carries a lifecycle signal. The signal feeds a state machine that',
  'transitions the wedding through inquiry -> tour_scheduled -> ',
  'tour_completed -> proposal_sent -> booked -> completed (with lost /',
  'cancelled as terminal off-ramps).',
  '',
  'Signals you may emit:',
  '',
  '  lead_declined: the couple explicitly says they will not move forward',
  '    with this venue. Examples: "we won\'t be moving forward", "we\'re',
  '    going to pass", "no longer pursuing", "removing your venue from',
  '    consideration", "we have decided not to book with you", "this',
  '    venue is no longer in the running", "thanks but no thanks".',
  '',
  '  going_with_other: the couple says they have chosen a different',
  '    venue. Examples: "we decided on another venue", "we\'re going with',
  '    [name] instead", "we picked a different place", "we found a venue',
  '    that suits us better", "we have signed with another venue".',
  '',
  '  silent_close: a platform-driven close event from a marketplace',
  '    relay. Examples: WeddingPro / WeddingWire "decided to close the',
  '    conversation", "couple closed this conversation", The Knot',
  '    "marked as not interested", "this lead has been archived", "the',
  '    couple has stopped responding to inquiries". The signal arrives',
  '    via the platform rather than the couple themselves.',
  '',
  '  tour_cancelled: the couple cancels a previously scheduled tour.',
  '    Examples: "we need to cancel our tour", "can\'t make it tomorrow",',
  '    Calendly "Event Canceled" notifications. Distinguish from a',
  '    reschedule (which is not a cancellation).',
  '',
  '  tour_completed: the couple references a tour that has already',
  '    happened. Examples: "thanks for showing us around", "after our',
  '    visit yesterday", "we loved seeing the property", "great tour',
  '    today". The email is a post-tour follow-up, not the tour booking',
  '    itself.',
  '',
  '  contract_signed: confirmation that a contract has been signed.',
  '    Examples: HoneyBook "Contract signed", DocuSign "Completed",',
  '    "we have signed the agreement", "contract is signed and on its',
  '    way", platform-relayed signing-event emails.',
  '',
  '  deposit_paid: confirmation that a deposit / retainer / first',
  '    payment has cleared. Examples: HoneyBook "Payment received",',
  '    Stripe / venue-bank notifications about a deposit, "the deposit',
  '    has been paid", "we have wired the retainer".',
  '',
  'Return null when the email is:',
  '  - a regular question, schedule check, or pricing follow-up (these',
  '    are NOT signals, they are normal traffic the venue should reply to),',
  '  - an out-of-office reply, undeliverable bounce, or system mail,',
  '  - any kind of cold sales / marketing outreach,',
  '  - ambiguous or hedged language ("we may pass", "leaning toward',
  '    another option") -- the floor is explicit decline, not maybe.',
  '',
  'Confidence floor: 70. If you are not at least 70% sure, return',
  '  signal=null. A wrong signal flips a wedding to "lost" and silences',
  '  drafts; a missed signal merely costs one round of follow-up review.',
  '  We prefer the missed-signal failure mode.',
  '',
  'Return a single JSON object with exactly this shape:',
  '  {',
  '    "signal": "<one of: lead_declined|going_with_other|silent_close|tour_cancelled|tour_completed|contract_signed|deposit_paid|null>",',
  '    "confidence": <integer 0-100>,',
  '    "reason": "<one short sentence, no PII, max 140 chars>"',
  '  }',
  '',
  'No markdown, no code blocks, no extra fields.',
]

const SYSTEM_PROMPT = SYSTEM_PROMPT_LINES.join('\n')

interface DetectorResponse {
  signal?: unknown
  confidence?: unknown
  reason?: unknown
}

const WHITESPACE_RE = /\s+/g

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return ''
  const trimmed = s.replace(WHITESPACE_RE, ' ').trim()
  return trimmed.length > max ? trimmed.slice(0, max) + '...' : trimmed
}

function buildUserPrompt(
  email: { from: string; subject: string | null; body: string; direction: 'inbound' | 'outbound' },
  context: { currentStatus: WeddingStatus | null; threadInboundCount: number },
): string {
  const lines: string[] = []
  lines.push('EMAIL TO ANALYZE')
  lines.push('')
  lines.push('Direction: ' + email.direction)
  lines.push('From: ' + truncate(email.from, 200))
  lines.push('Subject: ' + truncate(email.subject, 200))
  lines.push('')
  lines.push('Wedding context:')
  lines.push('  Current wedding status: ' + (context.currentStatus ?? 'none'))
  lines.push('  Inbound messages on thread: ' + context.threadInboundCount)
  lines.push('')
  lines.push('Body (first 2000 chars):')
  lines.push(truncate(email.body, BODY_SLICE_LIMIT))
  lines.push('')
  lines.push('Return JSON only.')
  return lines.join('\n')
}

function isDetectableSignal(value: unknown): value is LifecycleSignal {
  return typeof value === 'string' && DETECTABLE_SIGNALS.has(value as LifecycleSignal)
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 100) return 100
  return Math.round(n)
}

// Cheap pre-filter: bodies that are obviously auto-mail or empty don't
// deserve a Haiku call. The router brain already filters most of these
// (out-of-office, undeliverable) but a defensive belt here means the
// detector never bills tokens on a noise message that slipped past.
const AUTO_MAIL_HINTS = [
  'out of office',
  'auto-reply',
  'autoreply',
  'this is an automated',
  'undeliverable',
  'mailer-daemon',
  'do not reply',
  'no-reply',
]

function looksLikeNoise(email: { subject: string | null; body: string }): boolean {
  const sub = (email.subject ?? '').toLowerCase()
  const body = (email.body ?? '').toLowerCase()
  if (!body || body.length < 12) return true
  for (const hint of AUTO_MAIL_HINTS) {
    if (sub.includes(hint) || body.includes(hint)) return true
  }
  return false
}

/**
 * Run the lifecycle signal detector against one inbound email.
 *
 * Defensive contract:
 *   - Outbound emails return signal=null without an LLM call.
 *   - Auto-mail / empty bodies return signal=null without an LLM call.
 *   - Any AI failure (timeout, malformed JSON, unknown signal) collapses
 *     to { signal: null, confidence: 0, reason: '...' }. Never throws.
 *   - Confidence below the floor (70) collapses to signal=null but
 *     preserves the raw confidence number in the return value so a
 *     coordinator-side review surface can show "AI was 55% sure this
 *     was a decline" without acting on it.
 */
export async function detectLifecycleSignal(
  venueId: string,
  email: { from: string; subject: string | null; body: string; direction: 'inbound' | 'outbound' },
  context: { currentStatus: WeddingStatus | null; threadInboundCount: number },
  options?: { correlationId?: string },
): Promise<DetectedSignal> {
  // We never want Sage's own outbound messages to be re-scored as
  // signals. The pipeline path that calls this only fires on inbound,
  // but the explicit guard makes the function safe to call elsewhere
  // (e.g. backfill scripts that iterate every interaction).
  if (email.direction !== 'inbound') {
    return { signal: null, confidence: 0, reason: 'outbound row, no signal' }
  }

  if (looksLikeNoise(email)) {
    return { signal: null, confidence: 0, reason: 'auto-mail or empty body' }
  }

  try {
    const userPrompt = buildUserPrompt(email, context)

    const response = await callAIJson<DetectorResponse>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 200,
      temperature: 0.1,
      tier: 'haiku',
      taskType: 'lifecycle_signal_detect',
      contentTier: 2,
      promptVersion: BRAIN_LIFECYCLE_SIGNAL_PROMPT_VERSION,
      venueId,
      correlationId: options?.correlationId,
    })

    const rawSignal = response?.signal
    const conf = clampConfidence(response?.confidence)
    const reason =
      typeof response?.reason === 'string' && response.reason.trim().length > 0
        ? response.reason.trim().slice(0, 200)
        : 'no reason provided'

    // Explicit null return from the model. Some Haiku variants emit the
    // string "null" instead of the JSON null literal -- handle both.
    if (rawSignal === null || rawSignal === 'null' || rawSignal === undefined) {
      return { signal: null, confidence: conf, reason }
    }

    if (!isDetectableSignal(rawSignal)) {
      return { signal: null, confidence: 0, reason: 'unknown signal output' }
    }

    if (conf < CONFIDENCE_FLOOR) {
      return { signal: null, confidence: conf, reason: 'below confidence floor' }
    }

    return { signal: rawSignal, confidence: conf, reason }
  } catch (err) {
    return {
      signal: null,
      confidence: 0,
      reason:
        'detector error: ' +
        (err instanceof Error ? err.message.slice(0, 120) : 'unknown'),
    }
  }
}
