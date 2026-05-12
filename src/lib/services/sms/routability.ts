/**
 * SMS routability guard.
 *
 * Mirrors `isUnsendableAddress` from `@/lib/services/identity/body-extract`
 * for the SMS channel. The send-side chokepoint pattern is the same:
 * one predicate, one place to extend, every caller gets the refusal.
 *
 * Catches:
 *   • NULL / empty / non-E.164 strings
 *   • Short-code patterns (5-6 digits, no '+') — e.g. "32665"; these
 *     are one-way marketing channels, not couple endpoints
 *   • Numbers the venue already owns (callers pass the set, sourced
 *     from openphone_connections.phone_numbers)
 *
 * 2026-05-12 / mig 313.
 *
 * NOTE on outbound SMS path: as of 2026-05-12 the codebase has no
 * outbound SMS send function. openphone.ts ingests only; the rest of
 * the Sage stack only drafts. When the outbound path lands (e.g. a
 * future twilio.sendSms or openphone.sendMessage wrapper), wire this
 * guard at that chokepoint the same way gmail.ts wires
 * isUnsendableAddress. Documented here so the gap is explicit and the
 * primitive ready.
 */

const E164_RE = /^\+[1-9]\d{1,14}$/
const SHORTCODE_RE = /^\d{5,6}$/

export interface SmsRoutability {
  sendable: boolean
  reason?: string
}

/**
 * Refuse to send to phone shapes that can't carry a couple-side reply:
 * malformed inputs, marketing short codes, the venue's own outbound
 * line. The check is intentionally permissive (default to sendable
 * when ambiguous) so legitimate sends aren't blocked.
 */
export function isUnsendableSmsAddress(
  phone: string | null | undefined,
  options?: { ownNumbers?: Set<string> },
): SmsRoutability {
  if (!phone) return { sendable: false, reason: 'empty' }
  const trimmed = phone.trim()
  if (!trimmed) return { sendable: false, reason: 'empty' }

  // Short-code shape (5-6 digits, no plus). One-way marketing only;
  // never a couple endpoint.
  if (SHORTCODE_RE.test(trimmed)) {
    return { sendable: false, reason: 'shortcode' }
  }

  // Must be E.164. Permissive callers should normalise upstream.
  if (!E164_RE.test(trimmed)) {
    return { sendable: false, reason: 'not_e164' }
  }

  // Don't text yourself. ownNumbers is venue-scoped — caller pulls
  // openphone_connections.phone_numbers[].phoneNumber for the venue.
  if (options?.ownNumbers && options.ownNumbers.has(trimmed)) {
    return { sendable: false, reason: 'own_number' }
  }

  return { sendable: true }
}
