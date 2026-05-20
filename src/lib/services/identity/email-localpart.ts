/**
 * Email-localpart logical-name extractor.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §C.5 (cascade stage 5 — email-
 * localpart derived name). Given the localpart of an email address
 * ('timmy.blogs', 'timothyblogs', 'timothy_blogs_42'), extract the
 * underlying first-name + last-name token candidates so the cascade can
 * compare two structurally-different addresses that belong to the same
 * person.
 *
 * Examples:
 *   'timmy.blogs'       → { firstCandidates: ['timmy'],   lastCandidate: 'blogs' }
 *   'timothyblogs'      → { firstCandidates: ['timothy'], lastCandidate: 'blogs' }
 *   'timothy_blogs_42'  → { firstCandidates: ['timothy'], lastCandidate: 'blogs' }
 *   'sue.smith'         → { firstCandidates: ['sue'],     lastCandidate: 'smith' }
 *
 * Segmentation strategy (greedy left-to-right against the nickname
 * dictionary's known-token set):
 *
 *   1. Lowercase + strip digits + strip non-alphabetic separator chars
 *      except '.', '_', '-' which are token separators.
 *   2. If the localpart has explicit separators, split on them. Use the
 *      first segment as the first-name candidate set; remaining segments
 *      joined as the last-name candidate.
 *   3. If no separators, greedily match the longest known-name prefix
 *      from the nickname dictionary; the remainder is the last-name
 *      candidate. If no known prefix matches at all, return the whole
 *      localpart as the last-name candidate only.
 *
 * Doctrine: the extractor is conservative. It returns "candidate" tokens
 * the caller compares — it never asserts "this email belongs to person
 * X". The cascade still requires the corroborating signal (e.g. exact
 * last-name match against an existing couple's people row).
 *
 * No LLM. Pure dictionary lookup. Multi-venue safe.
 */

import { knownNameTokens, nicknameEquivalent } from './nicknames'

export interface LocalpartExtraction {
  /** Original localpart, lowercased + trimmed. Empty string when input
   *  was unusable. */
  raw: string
  /** First-name candidate tokens. Multiple entries when the dictionary
   *  has no clear prefix and the caller should try each. */
  firstCandidates: string[]
  /** Last-name candidate token, if any. */
  lastCandidate: string | null
  /** Diagnostic — which segmentation path produced the extraction. */
  via: 'separator_split' | 'dictionary_prefix' | 'whole_string' | 'unparsable'
}

/**
 * Strip the local-part of an email address. Returns null when the input
 * does not look like an email or has no localpart.
 */
export function localpartOf(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at <= 0) return null
  return email.slice(0, at).trim().toLowerCase()
}

/**
 * Normalise a localpart for segmentation: strip digits, strip non-token
 * characters, collapse repeated separators. Keeps '.', '_', '-' as
 * separators because users routinely use them to split first / last.
 */
function normaliseLocalpart(lp: string): string {
  return lp
    .toLowerCase()
    .replace(/\d+/g, '')                  // 'tim42' → 'tim'
    .replace(/[^a-z._\-]/g, '')           // strip exotic chars (+,~,etc.)
    .replace(/[._\-]+/g, '.')             // collapse separators to '.'
    .replace(/^\.+|\.+$/g, '')            // trim leading/trailing separators
}

/**
 * Greedy left-to-right segmentation: find the longest known-name prefix
 * of `s`. Returns null when no known-name prefix of length >= 3 exists.
 */
function longestKnownPrefix(s: string, known: Set<string>): string | null {
  // Walk from longest to shortest to take the maximal match. Bound the
  // search at the input length and at a sensible upper bound (20 chars).
  const max = Math.min(s.length, 20)
  for (let len = max; len >= 3; len -= 1) {
    const candidate = s.slice(0, len)
    if (known.has(candidate)) return candidate
  }
  return null
}

/**
 * Extract logical name tokens from an email localpart. See the module
 * doc for examples.
 */
export function extractNameTokens(
  localpart: string | null | undefined,
): LocalpartExtraction {
  const raw = (localpart ?? '').trim().toLowerCase()
  if (!raw) {
    return {
      raw: '',
      firstCandidates: [],
      lastCandidate: null,
      via: 'unparsable',
    }
  }

  const norm = normaliseLocalpart(raw)
  if (!norm) {
    return { raw, firstCandidates: [], lastCandidate: null, via: 'unparsable' }
  }

  // ---- Path A: explicit separators ----------------------------------------
  if (norm.includes('.')) {
    const parts = norm.split('.').filter((p) => p.length >= 2)
    if (parts.length >= 2) {
      const first = parts[0]
      const last = parts.slice(1).join('')
      return {
        raw: norm,
        firstCandidates: [first],
        lastCandidate: last.length >= 2 ? last : null,
        via: 'separator_split',
      }
    }
    if (parts.length === 1) {
      // Single token after separators — treat as last-name candidate.
      return {
        raw: norm,
        firstCandidates: [],
        lastCandidate: parts[0],
        via: 'whole_string',
      }
    }
  }

  // ---- Path B: dictionary prefix ------------------------------------------
  // No separators present (or only one segment). Try to find a known
  // first-name prefix.
  const known = knownNameTokens()
  const prefix = longestKnownPrefix(norm, known)
  if (prefix && norm.length - prefix.length >= 2) {
    return {
      raw: norm,
      firstCandidates: [prefix],
      lastCandidate: norm.slice(prefix.length),
      via: 'dictionary_prefix',
    }
  }
  if (prefix && norm.length === prefix.length) {
    // The whole localpart IS a known first name — no last name.
    return {
      raw: norm,
      firstCandidates: [prefix],
      lastCandidate: null,
      via: 'dictionary_prefix',
    }
  }

  // ---- Path C: whole string is the last-name candidate --------------------
  return {
    raw: norm,
    firstCandidates: [],
    lastCandidate: norm,
    via: 'whole_string',
  }
}

/**
 * Do two email localparts encode the same logical person — same first
 * name (allowing nicknames) AND same last name?
 *
 *   logicalLocalpartMatch('timmy.blogs', 'timothyblogs') → true
 *   logicalLocalpartMatch('tim@example', 'tom@example')  → false
 *
 * Returns false when either side cannot be segmented into both a first
 * and a last component.
 */
export function logicalLocalpartMatch(a: string, b: string): boolean {
  const ea = extractNameTokens(a)
  const eb = extractNameTokens(b)
  if (!ea.lastCandidate || !eb.lastCandidate) return false
  if (ea.lastCandidate !== eb.lastCandidate) return false
  if (ea.firstCandidates.length === 0 || eb.firstCandidates.length === 0) {
    return false
  }
  for (const fa of ea.firstCandidates) {
    for (const fb of eb.firstCandidates) {
      if (nicknameEquivalent(fa, fb)) return true
    }
  }
  return false
}
