/**
 * AI disclosure utilities — required on every outbound Sage message.
 *
 * Commit 1 (guardrails): hard-coded, safe-default footer. Does NOT read
 * venue-specific Sage identity yet. Commit 2 will templatise the footer
 * once the per-venue name/role fields ship in venue_config.
 *
 * Why: legal (EU AI Act Art. 50, CA SB 1001) and Anthropic Usage Policy
 * both require clear disclosure that the correspondent is AI. Having ONE
 * helper that every outbound Sage path must call means no venue
 * configuration, no A/B test, and no "temporarily off for testing" flag
 * can bypass it. If you're adding a new outbound Sage path, you must call
 * this helper or a reviewer will catch it.
 */

export const AI_DISCLOSURE_MARKER = '[sage-ai-disclosure-v1]'

export const AI_DISCLOSURE_FOOTER = `
––
Replies on this thread are drafted by Sage, the venue's AI assistant, and reviewed by a human before anything important is confirmed. Reply here any time to reach the team directly.
${AI_DISCLOSURE_MARKER}`.trimEnd()

/**
 * Append the AI disclosure footer to an email body. Idempotent — if the
 * marker is already present (e.g. because the caller ran it twice, or
 * because a quoted prior message already includes it), we don't duplicate.
 */
export function appendAIDisclosure(body: string): string {
  if (body.includes(AI_DISCLOSURE_MARKER)) return body
  const trimmed = body.trimEnd()
  return `${trimmed}\n\n${AI_DISCLOSURE_FOOTER}\n`
}
