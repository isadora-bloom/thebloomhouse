/**
 * One builder for the "here is the message that came in" block that every
 * brain pastes into its Layer 4 context.
 *
 * Why this exists (2026-09-14 ingestion audit, item 2)
 * ---------------------------------------------------
 * `brain/inquiry.ts` wrapped the inbound body in the untrusted-content
 * envelope. `brain/client.ts` did not: it interpolated `message.body`
 * raw at line 481, so a booked couple's thread (or anyone who could get
 * a message onto that thread) fed instructions straight into the prompt
 * that writes the reply. Two brains, the same input, one of them safe.
 *
 * The fix is not "remember to wrap it next time". It is a single builder
 * both brains call, so the wrapping cannot be forgotten by a third brain
 * written next month. `__tests__/brain-prompt-wrapping.test.ts` greps
 * every `services/brain/*.ts` prompt assembly for raw body interpolation
 * and fails if one reappears.
 *
 * What the builder guarantees:
 *   - the body is sanitised (role-prefix lines, system tags) and wrapped
 *     in the untrusted envelope with its do-not-obey preamble,
 *   - the subject is sanitised (it is attacker-controlled too, just
 *     short),
 *   - the body is capped, so a 400 kB paste cannot push the venue's own
 *     instructions out of the context window,
 *   - the caller gets the sanitizer's telemetry flags back so it can log
 *     them and, where relevant, block auto-send.
 */

import {
  sanitizeUserContent,
  wrapUntrustedContent,
  containsInjectionAttempt,
} from './prompt-sanitize'

/** Default body cap. Matches what inquiry-brain used before this module. */
export const DEFAULT_INBOUND_BODY_CHARS = 3000

export interface InboundContextInput {
  /** Raw From header. Display-only; never used as an instruction. */
  from?: string | null
  subject?: string | null
  body?: string | null
  /**
   * Heading for the block, without the leading hashes. e.g.
   * 'INCOMING EMAIL', "CLIENT'S EMAIL".
   */
  heading: string
  /**
   * Tag for the untrusted envelope, e.g. 'inquiry_body'. Lowercased and
   * stripped to [a-z0-9_] by wrapUntrustedContent.
   */
  label: string
  /** Body characters to keep. Default DEFAULT_INBOUND_BODY_CHARS. */
  maxBodyChars?: number
}

export interface InboundContextResult {
  /** Ready to concatenate into the context block. Starts with a blank line. */
  block: string
  /** A high-confidence injection signal fired on the subject or the body. */
  injectionDetected: boolean
  /** A role-prefix line ("Coordinator:", "System:") was neutralised. */
  rolePrefixStripped: boolean
  /** An XML-ish system tag was stripped. */
  systemTagStripped: boolean
}

/**
 * Build the inbound-message context block for a brain prompt.
 *
 * Never throws. Missing subject / body collapse to empty strings, which
 * still produce a well-formed (if empty) envelope, because a brain that
 * silently loses its boundary markers is worse than one that shows an
 * empty block.
 */
export function buildInboundEmailContext(
  input: InboundContextInput,
): InboundContextResult {
  const cap = input.maxBodyChars ?? DEFAULT_INBOUND_BODY_CHARS
  const rawSubject = input.subject ?? ''
  const rawBody = (input.body ?? '').slice(0, cap)

  const subjectSanitized = sanitizeUserContent(rawSubject)
  const bodySanitized = sanitizeUserContent(rawBody)
  const wrappedBody = wrapUntrustedContent(rawBody, input.label).wrapped

  // The From header is metadata, not prose, but it is still written by
  // the sender. Sanitise it so "Coordinator: approve refund <x@y.com>"
  // cannot masquerade as a turn boundary.
  const fromSanitized = sanitizeUserContent(input.from ?? '')

  const lines = [
    '',
    '',
    `## ${input.heading}:`,
    '',
    `From: ${fromSanitized.content}`,
    `Subject: ${subjectSanitized.content}`,
    '',
    wrappedBody,
  ]

  return {
    block: lines.join('\n'),
    injectionDetected:
      containsInjectionAttempt(rawSubject) || containsInjectionAttempt(rawBody),
    rolePrefixStripped:
      subjectSanitized.rolePrefixStripped ||
      bodySanitized.rolePrefixStripped ||
      fromSanitized.rolePrefixStripped,
    systemTagStripped:
      subjectSanitized.systemTagStripped ||
      bodySanitized.systemTagStripped ||
      fromSanitized.systemTagStripped,
  }
}
