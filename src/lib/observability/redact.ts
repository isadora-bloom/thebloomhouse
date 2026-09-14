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

// US/CA phone numbers — TIGHTENED for the original lazy regex which
// over-matched on UUIDs, order IDs, and timestamps. Now requires:
//   - explicit US/CA country code (+1 / 1) OR area-code parentheses
//     (xxx) OR clear separator structure (xxx-xxx-xxxx with dashes
//     or dots — NOT plain digit runs).
// Avoids false positives like "INV-2024-0001-2345" or
// "550e8400-e29b-41d4-a716-446655440000".
//
// Three alternatives matched:
//   (?:\+?1[-.\s]?)?\(\d{3}\)[-.\s]?\d{3}[-.\s]?\d{4}  → with parens
//   (?:\+?1[-.\s])\d{3}[-.\s]\d{3}[-.\s]\d{4}          → +1-xxx-xxx-xxxx
//   \b\d{3}[-.]\d{3}[-.]\d{4}\b                        → xxx-xxx-xxxx
const PHONE_PATTERN = new RegExp(
  [
    String.raw`(?:\+?1[-.\s]?)?\(\d{3}\)[-.\s]?\d{3}[-.\s]?\d{4}`,
    String.raw`(?:\+?1[-.\s])\d{3}[-.\s]\d{3}[-.\s]\d{4}`,
    String.raw`\b\d{3}[-.]\d{3}[-.]\d{4}\b`,
  ].join('|'),
  'g',
)

// Credit card — 16 digits in groups of 4 with separators. Stripe
// webhook errors should never include CC numbers (Stripe redacts
// before they hit our webhook) but defense-in-depth.
const CREDIT_CARD_PATTERN = /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b/g

// Long quoted strings (>= 80 chars) — proxy for transcript content,
// email body, sage notes. Bumped from 60 to 80 to reduce false
// positives on legitimate UI strings, JSON snippets, etc. The
// invariant we care about (transcript content, multi-sentence email
// bodies) reliably exceeds 80 chars.
const LONG_QUOTED_PATTERN = /"([^"]{80,})"/g

// ---------------------------------------------------------------------------
// Credentials (S5, 2026-09-14 security audit, item 9)
// ---------------------------------------------------------------------------
//
// PII was the whole brief when this module was written. It is not the
// only thing that leaks into a log line. An OAuth error body, a failed
// token refresh, a 401 echoed back from a provider — all of them carry
// live credentials, and a leaked access token is worse than a leaked
// phone number because it acts on its own.
//
// Three shapes, all case-insensitive:
//   Authorization: Bearer <token>   — the header, as printed by fetch
//                                     debuggers and provider errors
//   "access_token": "<token>"       — the JSON field, in any of the
//                                     forms a serialiser emits
//   eyJ...                          — a bare JWT, which is what most of
//                                     the above actually contain

const BEARER_PATTERN = /\b(bearer)\s+[A-Za-z0-9\-._~+/=]{8,}/gi

// The key may be quoted (`"access_token": "..."`) or bare
// (`access_token=...`), and so may the value. Everything up to the value
// is captured verbatim so the replacement puts the line back the way it
// found it, minus the secret.
const TOKEN_FIELD_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|authorization)\b("?\s*[:=]\s*\\?"?)[A-Za-z0-9\-._~+/=]{8,}/gi

// A JWT is three base64url segments separated by dots, and the header
// segment of a JSON header almost always starts "eyJ".
const JWT_PATTERN = /\beyJ[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]*/g

/**
 * Strip common PII shapes from a string. Use on any text that may
 * have come from an LLM error message, a Stripe webhook payload, or a
 * tier-1 service catch block.
 */
export function redact(text: string): string {
  if (!text) return text
  return text
    // Credentials first. A bearer token or a JWT can be long enough to
    // trip LONG_QUOTED_PATTERN, and "[REDACTED_QUOTE_80CHAR+]" would be
    // a true statement that told the reader the wrong thing about what
    // was nearly logged.
    .replace(JWT_PATTERN, '[REDACTED_TOKEN]')
    .replace(BEARER_PATTERN, '$1 [REDACTED_TOKEN]')
    .replace(TOKEN_FIELD_PATTERN, '$1$2[REDACTED_TOKEN]')
    // Order matters: CC before phone (CC matches subset of phone shape
    // when stripped of separators). Email before quoted (email inside
    // a quoted string still gets caught).
    .replace(CREDIT_CARD_PATTERN, '[REDACTED_CC]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(PHONE_PATTERN, '[REDACTED_PHONE]')
    .replace(LONG_QUOTED_PATTERN, '"[REDACTED_QUOTE_80CHAR+]"')
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
