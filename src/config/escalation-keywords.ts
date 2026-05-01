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
 *
 * Sync overload — uses the global ESCALATION_KEYWORDS list only. Kept
 * for client-side / sync paths (e.g. portal/weddings/[id]/page.tsx
 * useMemo filter). For server-side checks that should respect per-venue
 * rules, call `checkEscalationForVenue(text, venueId)` instead — that
 * function merges global defaults with rows from
 * venue_forbidden_topics (migration 125 / B-21).
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

// Per-venue keyword cache. Coordinator edits land via the admin UI
// (DELETE / INSERT), at which point invalidateVenueEscalationCache(venueId)
// must fire so the next check sees the new rules immediately. Without
// invalidation a 5-minute TTL keeps stale rules around — acceptable for
// a coordinator-tweak surface but not great. Keep TTL conservative.
const VENUE_KEYWORD_CACHE = new Map<string, { keywords: string[]; expiresAt: number }>();
const VENUE_KEYWORD_TTL_MS = 5 * 60 * 1000;

export function invalidateVenueEscalationCache(venueId: string): void {
  VENUE_KEYWORD_CACHE.delete(venueId);
}

async function loadVenueExtensions(venueId: string): Promise<string[]> {
  const cached = VENUE_KEYWORD_CACHE.get(venueId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.keywords;
  }
  // Lazy import — escalation-keywords.ts is also imported in
  // contexts (client / config bundles) where pulling Supabase eagerly
  // would balloon the bundle. The dynamic import is only paid for
  // when checkEscalationForVenue is actually called server-side.
  try {
    const { createServiceClient } = await import('@/lib/supabase/service');
    const supabase = createServiceClient();
    const { data } = await supabase
      .from('venue_forbidden_topics')
      .select('keyword')
      .eq('venue_id', venueId)
      .is('deleted_at', null);
    const keywords = ((data ?? []) as Array<{ keyword: string }>)
      .map((r) => (r.keyword ?? '').toLowerCase().trim())
      .filter((k) => k.length > 0);
    VENUE_KEYWORD_CACHE.set(venueId, { keywords, expiresAt: now + VENUE_KEYWORD_TTL_MS });
    return keywords;
  } catch (err) {
    console.warn('[escalation-keywords] venue extensions load failed for', venueId, err);
    return [];
  }
}

/**
 * Venue-aware escalation check. Merges the global ESCALATION_KEYWORDS
 * list with per-venue rows from venue_forbidden_topics (migration 125 /
 * B-21). Cache is in-process, 5-minute TTL; coordinator edits should
 * call invalidateVenueEscalationCache(venueId) to take effect
 * immediately. Per Playbook LIMB-16.4.
 */
export async function checkEscalationForVenue(
  text: string,
  venueId: string,
): Promise<{ shouldEscalate: boolean; matchedKeyword: string | null }> {
  const lower = text.toLowerCase();
  // Check venue-specific first so a venue's tighter rule overrides the
  // global match in the returned matchedKeyword (better audit signal).
  const venueExtensions = await loadVenueExtensions(venueId);
  for (const keyword of venueExtensions) {
    if (lower.includes(keyword)) {
      return { shouldEscalate: true, matchedKeyword: keyword };
    }
  }
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
