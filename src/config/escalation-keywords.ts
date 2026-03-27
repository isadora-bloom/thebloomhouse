/**
 * Keywords that trigger immediate escalation to human.
 * These bypass AI processing entirely.
 */

/** Triggers immediate escalation to the venue owner/coordinator. */
export const ESCALATION_KEYWORDS: string[] = [
  // Legal/contracts
  'lawyer',
  'attorney',
  'legal',
  'lawsuit',
  'contract dispute',
  'refund',
  'cancellation policy',

  // Complaints
  'complaint',
  'disappointed',
  'frustrated',
  'unacceptable',
  'terrible',
  'worst',
  'never again',

  // Urgent/emergency
  'urgent',
  'emergency',
  'asap',
  'immediately',
  'call me',
  'phone',

  // Payment issues
  'charge back',
  'chargeback',
  'fraud',
  'unauthorized',
  'billing error',

  // Media/public
  'review',
  'yelp',
  'google review',
  'social media',
  'press',
  'journalist',
];

/** Indicators that an email is spam and should be filtered out. */
export const SPAM_KEYWORDS: string[] = [
  'unsubscribe',
  'click here',
  'limited time',
  'act now',
  'congratulations',
  "you've won",
  'nigerian prince',
  'cryptocurrency',
  'bitcoin',
  'investment opportunity',
];

/** Email addresses / patterns to automatically skip (no processing). */
export const AUTO_IGNORE_PATTERNS: string[] = [];

// ============================================================
// Utility functions
// ============================================================

/**
 * Check if text contains any escalation keywords.
 * Returns the matched keyword if found, or null.
 */
export function checkEscalation(text: string): { shouldEscalate: boolean; matchedKeyword: string | null } {
  const lower = text.toLowerCase();
  for (const keyword of ESCALATION_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { shouldEscalate: true, matchedKeyword: keyword };
    }
  }
  return { shouldEscalate: false, matchedKeyword: null };
}

/**
 * Check if text looks like spam.
 * Returns the matched indicator if found, or null.
 */
export function checkSpam(text: string): { isSpam: boolean; matchedIndicator: string | null } {
  const lower = text.toLowerCase();
  for (const indicator of SPAM_KEYWORDS) {
    if (lower.includes(indicator)) {
      return { isSpam: true, matchedIndicator: indicator };
    }
  }
  return { isSpam: false, matchedIndicator: null };
}
