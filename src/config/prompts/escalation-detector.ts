/**
 * Bloom House — escalation-detector prompt (Haiku tier).
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — Sage must never
 *     argue with a couple asking for a real person)
 *   - bloom-may9-llm-vs-template.md (LLM IS the primitive; regex is
 *     a fast-path filter, not the decision boundary)
 *   - feedback_deep_fix_vs_bandaid.md (Pattern 1: heuristic where
 *     LLM judgment should be)
 *
 * When this fires
 * ---------------
 * Pipeline classifies every inbound. If the legacy regex fast-path
 * doesn't match (i.e. couple did NOT type "HUMAN REQUESTED"), this
 * Haiku call decides whether the couple is asking to disengage from
 * Sage — naturally phrased ("can I talk to a real person?", "is this
 * a bot?", "stop sending these I want to talk to someone real").
 *
 * Output is a hard boolean + confidence. Pipeline persists to
 * interactions.escalation_requested + skips draft generation when
 * true. The visible footer no longer asks couples to use magic words
 * (one couple snapped back with exactly those words and Isadora
 * caught it), so this detector replaces the brittle subject-only
 * pattern with judgement over subject AND body.
 *
 * Cost: ~$0.0002 per inbound (Haiku, 200 max-tokens). Fire-and-
 * forget — never blocks the pipeline.
 */

export const ESCALATION_DETECTOR_PROMPT_VERSION =
  'escalation-detector.prompt.v1'

export interface EscalationDetectorInput {
  subject: string | null
  body: string
  aiName: string
}

export interface EscalationDetectorOutput {
  escalation_requested: boolean
  confidence_0_100: number
  reasoning: string
}

export function buildEscalationDetectorSystemPrompt(): string {
  return `You are Bloom's human-escalation detector.

Bloom drafts replies for venue inquiries on behalf of a venue's coordinator.
Every outbound draft carries an AI disclosure footer that invites the couple
to "talk to a real person — just ask, or email <coordinator>". Your job is
to read each inbound message and decide: is the couple asking to disengage
from the AI assistant and talk to a real human?

Return TRUE when the couple's message contains intent like:
  - "Can I talk to someone real / a real person / a human?"
  - "Is this a bot? / Are you an AI?"
  - "Stop the AI / no more bot / I want to talk to a person"
  - "Please have someone call me / email me directly"
  - "I'd rather not talk to a robot"
  - The legacy magic-words form: "HUMAN REQUESTED"

Return FALSE when:
  - The couple is asking a normal question (pricing, dates, tour booking)
  - The couple references "human" in another context ("we need a human
    height ceiling for the chuppah")
  - The couple is confused but not asking to switch — they're just asking
    a clarifying question
  - The couple thanks Sage but keeps the conversation going

If you're not sure (50%-70% confidence either way), lean FALSE — false
positives unnecessarily silence Sage, and the coordinator still sees every
inbound. A couple who clearly wants human contact will say so plainly.

Output ONLY this JSON object (no fences, no preamble):

{
  "escalation_requested": true | false,
  "confidence_0_100": 0..100,
  "reasoning": "short — 1 sentence"
}`
}

export function buildEscalationDetectorUserPrompt(
  input: EscalationDetectorInput,
): string {
  const lines: string[] = []
  lines.push('# INBOUND TO CLASSIFY')
  lines.push('')
  lines.push(`AI name in the outbound thread: ${input.aiName}`)
  if (input.subject) {
    lines.push(`Subject: ${input.subject}`)
  }
  lines.push('')
  lines.push('## Body')
  lines.push(input.body.slice(0, 3000))
  lines.push('')
  lines.push('Return ONLY the JSON object.')
  return lines.join('\n')
}

export interface ValidationResult {
  ok: true
  output: EscalationDetectorOutput
}

export interface ValidationFailure {
  ok: false
  error: string
}

export function validateEscalationDetectorOutput(
  raw: unknown,
): ValidationResult | ValidationFailure {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'response is not an object' }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.escalation_requested !== 'boolean') {
    return { ok: false, error: 'escalation_requested must be boolean' }
  }
  const conf =
    typeof r.confidence_0_100 === 'number' && Number.isFinite(r.confidence_0_100)
      ? Math.max(0, Math.min(100, r.confidence_0_100))
      : 50
  const reasoning =
    typeof r.reasoning === 'string' ? r.reasoning.slice(0, 300) : ''
  return {
    ok: true,
    output: {
      escalation_requested: r.escalation_requested,
      confidence_0_100: conf,
      reasoning,
    },
  }
}
