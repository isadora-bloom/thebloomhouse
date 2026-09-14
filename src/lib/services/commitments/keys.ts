/**
 * Stable keys for captured commitments.
 *
 * Two hashes live here and they answer different questions.
 *
 *   commitmentKey(quote)
 *     "Is this the same thing they told us?" Keys the row in
 *     commitment_reconciliation, so a nightly rerun updates the row it
 *     wrote last night instead of adding a second one.
 *
 *   judgeCacheKey(quote, timelineTitles)
 *     "Has anything changed since we last asked the model?" If neither
 *     the sentence nor the timeline has moved, the answer cannot have
 *     moved either, and the sweep skips the call.
 *
 * FNV-1a 32-bit, the same function the rest of the repo uses for cache
 * keys (lib/ai/cache.ts, insights/confidence.ts buildCacheKey,
 * brain/cancellation-classifier.ts). Copied rather than imported because
 * lib/ai/cache.ts keeps its copy module-private.
 */

/** FNV-1a 32-bit, hex, zero-padded to 8 characters. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Lower case, collapse runs of whitespace, drop surrounding punctuation.
 *
 * Enough that "We're having a groom's cake." and "we're having a groom's
 * cake" are one commitment, and not so much that two genuinely different
 * sentences collide. Deliberately NOT stemming or stripping stop words:
 * the coordinator reads the stored quote verbatim, and an over-eager
 * normaliser would merge "the cake arrives at four" into "the cake".
 */
export function normaliseQuote(quote: string): string {
  return quote
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”‘’(\[]+|[\s"'“”‘’)\].,;:!?]+$/g, '')
    .trim()
}

export function commitmentKey(quote: string): string {
  return fnv1a(normaliseQuote(quote))
}

/**
 * Content hash of the judge's whole input. Titles are sorted so the same
 * timeline in a different read order does not invalidate the cache.
 */
export function judgeCacheKey(quote: string, timelineTitles: string[]): string {
  const titles = [...timelineTitles]
    .map((t) => normaliseQuote(t))
    .filter((t) => t.length > 0)
    .sort()
    .join('|')
  return fnv1a(`${normaliseQuote(quote)}::${titles}`)
}
