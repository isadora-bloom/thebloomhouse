/**
 * Bloom House: log-line PII redaction.
 *
 * Per Playbook OPS-21.3.3:
 *   "Tier 1 data NEVER appears in logs. Tour transcript content,
 *    payment details, family-context notes are referenced by ID
 *    only in logs."
 *
 * Reality: 97 console.* callsites in src and we can't audit every one
 * for PII leakage. Common pattern is `console.error('thing failed:',
 * err.message)` where err.message can echo provider-side prompt
 * content (Anthropic 4xx errors include the prompt text), Stripe
 * webhook payloads, or Sage transcript snippets.
 *
 * This module provides a one-line wrapper that strips the common PII
 * shapes before logs hit stdout. Used at the highest-risk catch sites:
 *   - src/lib/ai/client.ts error JSON lines (Anthropic + OpenAI)
 *   - tier-1 service catch blocks (post-tour-brief, transcript-extract,
 *     transcript-voice-learning, sage-brain, brain-dump)
 *   - Stripe webhook errors
 *
 * Strategy: redact known shapes (email, phone, credit card, long
 * quoted strings). Over-redact rather than under-redact — a log line
 * that says [REDACTED_PHONE] for what's actually an order ID is
 * cheap; a leaked phone is expensive.
 *
 * NOT a substitute for proper structured logging (T1-G coming) — this
 * is the surgical fix for the existing 97 console.* sites until the
 * structured logger lands.
 */

// Email — case-insensitive RFC-ish match. Matches addresses inside
// Anthropic error messages like 'invalid email "couple@gmail.com"'.
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

// US/CA phone numbers in common formats: +1 555-555-5555 / (555)
// 555-5555 / 5555555555. Will over-match on raw 10-digit IDs — that's
// acceptable; redacted IDs are still queryable from DB.
const PHONE_PATTERN = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g

// Credit card — 16 digits in groups of 4 with separators. Stripe
// webhook errors should never include CC numbers (Stripe redacts
// before they hit our webhook) but defense-in-depth.
const CREDIT_CARD_PATTERN = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g

// Long quoted strings (>= 60 chars) — proxy for transcript content,
// email body, sage notes. The 60-char threshold means short quoted
// status strings ("approved", "in_progress") still log normally.
const LONG_QUOTED_PATTERN = /"([^"]{60,})"/g

/**
 * Strip common PII shapes from a string. Use on any text that may
 * have come from an LLM error message, a Stripe webhook payload, or a
 * tier-1 service catch block.
 */
export function redact(text: string): string {
  if (!text) return text
  return text
    // Order matters: CC before phone (CC matches subset of phone shape
    // when stripped of separators). Email before quoted (email inside
    // a quoted string still gets caught).
    .replace(CREDIT_CARD_PATTERN, '[REDACTED_CC]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(PHONE_PATTERN, '[REDACTED_PHONE]')
    .replace(LONG_QUOTED_PATTERN, '"[REDACTED_QUOTE_60CHAR+]"')
}

/**
 * Convenience wrapper for error-shaped values. Accepts the unknown
 * value that catch blocks usually receive.
 */
export function redactError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return redact(msg)
}

/**
 * Redact a JSON-shaped object's string-typed leaves. Useful when
 * logging a structured event whose values may contain PII.
 */
export function redactObject<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      out[k] = redact(v)
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactObject(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out as T
}
