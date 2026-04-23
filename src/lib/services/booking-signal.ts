/**
 * Booking-signal detection.
 *
 * Scans an inbound email body for language indicating the couple has
 * committed to booking: contract signed, deposit / retainer paid, or
 * explicit "we're official" phrasing. Fires the coordinator-confirm
 * notification path in email-pipeline (never auto-marks the date booked).
 *
 * Why its own service:
 *   - Testable in isolation — the regex set evolves as phrases bubble up
 *     from real inbox traffic, and regressing one pattern shouldn't risk
 *     the rest of extraction.ts.
 *   - Swappable — a later LLM-scored variant can live here behind the
 *     same signature without touching email-pipeline.
 *   - Discoverable — anyone searching for booking-confirmation logic
 *     lands here directly.
 *
 * Calendly / HoneyBook tour confirmations never reach this function —
 * venue_email_filters action='ignore' short-circuits them before the
 * classifier (migration 069 + trigger in 072).
 */

const SIGNING_PATTERNS: RegExp[] = [
  // Contract language
  /signed the contract/i,
  /contract is signed/i,
  /sent the signed/i,
  /signed and returned/i,
  /we'?ve signed/i,
  /just signed/i,
  /attached.*signed/i,
  /signed.*attached/i,
  // Deposit / retainer language
  /deposit (?:has been |was |is )?(?:paid|received|sent|processed|wired)/i,
  /retainer (?:has been |was |is )?(?:paid|received|sent|processed)/i,
  /paid the (?:deposit|retainer)/i,
  // Commitment language — kept tight to avoid spurious matches on
  // enthusiastic inquiry-stage emails ("we're so excited about your venue").
  /we(?:'re| are) (?:officially )?booked/i,
  /booking (?:is )?confirmed/i,
  /we(?:'re| are) official(?:ly)?(?:\b|,|\.|$)/i,
]

export interface BookingSignalResult {
  matched: boolean
  phrase: string | null
}

/**
 * Scan an email body for booking-commitment language. Returns the matched
 * phrase (for audit + future learning) plus the boolean.
 */
export function detectBookingSignal(emailBody: string): BookingSignalResult {
  if (!emailBody) return { matched: false, phrase: null }
  for (const pattern of SIGNING_PATTERNS) {
    const match = emailBody.match(pattern)
    if (match) return { matched: true, phrase: match[0] }
  }
  return { matched: false, phrase: null }
}

/**
 * Back-compat boolean-only convenience wrapper. New callers should prefer
 * detectBookingSignal for access to the matched phrase.
 */
export function detectContractSigning(emailBody: string): boolean {
  return detectBookingSignal(emailBody).matched
}
