// ---------------------------------------------------------------------------
// KB echo guard — detect when an AI draft echoes verbatim sentences from the
// venue's knowledge base, so coordinator-internal phrasing doesn't leak to
// couples.
//
// Closes Tier-B audit #87 ("Outbound check that drafts don't echo verbatim
// KB lines"). Runs as a soft check after generation: if the draft contains
// a long contiguous n-gram from a KB answer, the call site logs the match
// and (where supported) flags the draft for coordinator review. The detector
// itself is deterministic, allocation-light, and safe to run on every draft.
//
// Design choices:
//   - n-gram size = 8 words. Below 8, common venue phrases ("thank you for
//     your interest in our venue", "we'd love to show you around") trip
//     too many false positives. Above 8, even a strong echo can slip
//     through unnoticed.
//   - Comparison is whitespace-tokenized + lowercased + punctuation-
//     stripped. Coordinators and the model both vary spacing/punctuation
//     so token-level comparison is the right granularity.
//   - We return the LONGEST contiguous match, not all matches, since the
//     observability/UI surface only needs a single representative snippet.
//   - Single function; no class state. Safe to call from any pipeline.
// ---------------------------------------------------------------------------

const MIN_NGRAM = 8

export interface KbEchoMatch {
  /** True when the draft echoes ≥ MIN_NGRAM contiguous tokens from any KB entry. */
  matched: boolean
  /** Length (in tokens) of the longest contiguous match. 0 when matched=false. */
  longestMatchWords: number
  /**
   * The matched substring as it appears in the original draft (preserving
   * the draft's casing/punctuation, not the KB's). Useful for UI surfacing
   * — coordinators want to see which sentence in their email came from KB.
   * null when matched=false.
   */
  sampleSnippet: string | null
  /** Index of the KB entry that produced the longest match (callers can use
   * this to attribute the leak to a specific Q/A pair). null when matched=false. */
  kbEntryIndex: number | null
}

interface KbAnswerLike {
  answer: string
}

interface Token {
  /** Lowercased, punctuation-stripped form. Used for comparison. */
  norm: string
  /** Start index in the original string. Used to reconstruct the matched span. */
  start: number
  /** End index (exclusive) in the original string. */
  end: number
}

const TOKEN_RE = /\S+/g
const PUNCT_RE = /[.,!?;:'"()\[\]{}<>‘’“”]/g

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0]
    const norm = raw.toLowerCase().replace(PUNCT_RE, '')
    if (norm.length === 0) continue
    tokens.push({ norm, start: m.index ?? 0, end: (m.index ?? 0) + raw.length })
  }
  return tokens
}

/**
 * Detect verbatim echo of any KB answer's contiguous n-gram (≥ 8 tokens) in
 * the generated draft. Pure function. O(D + K) tokenization + O(D * K) in
 * the worst case for the n-gram scan — for typical D=200 tokens × K=5 KB
 * entries × 200 tokens each, this is ~200K integer comparisons, sub-ms.
 */
export function detectKbEcho(
  draftText: string,
  kbEntries: ReadonlyArray<KbAnswerLike>,
): KbEchoMatch {
  const draftTokens = tokenize(draftText)
  if (draftTokens.length < MIN_NGRAM || kbEntries.length === 0) {
    return { matched: false, longestMatchWords: 0, sampleSnippet: null, kbEntryIndex: null }
  }

  let bestLen = 0
  let bestDraftStart = -1
  let bestDraftEnd = -1
  let bestKbIndex = -1

  for (let kbIdx = 0; kbIdx < kbEntries.length; kbIdx++) {
    const kbTokens = tokenize(kbEntries[kbIdx].answer)
    if (kbTokens.length < MIN_NGRAM) continue

    // Build a Set of KB n-grams for O(1) lookup. Hashing on a delimiter
    // that can't appear in a normalized token (we strip punctuation).
    const kbNgrams = new Set<string>()
    for (let k = 0; k <= kbTokens.length - MIN_NGRAM; k++) {
      const slice = kbTokens.slice(k, k + MIN_NGRAM).map((t) => t.norm).join('')
      kbNgrams.add(slice)
    }

    // Slide an n-gram window across the draft. When we hit a match, try
    // to extend it forward to find the longest contiguous run.
    let d = 0
    while (d <= draftTokens.length - MIN_NGRAM) {
      const ngram = draftTokens.slice(d, d + MIN_NGRAM).map((t) => t.norm).join('')
      if (!kbNgrams.has(ngram)) {
        d++
        continue
      }

      // Extend forward by checking each subsequent token's MIN_NGRAM-window
      // also exists. This is a coarse heuristic — we don't track WHICH KB
      // span we're aligned with, so we'll accept that the run might cross
      // KB-side boundaries. In practice it doesn't matter: any extension
      // that stays inside the kbNgrams Set is still a real echo.
      let runEnd = d + MIN_NGRAM
      while (runEnd < draftTokens.length) {
        const probeStart = runEnd - MIN_NGRAM + 1
        const probe = draftTokens.slice(probeStart, probeStart + MIN_NGRAM).map((t) => t.norm).join('')
        if (!kbNgrams.has(probe)) break
        runEnd++
      }

      const runLen = runEnd - d
      if (runLen > bestLen) {
        bestLen = runLen
        bestDraftStart = d
        bestDraftEnd = runEnd
        bestKbIndex = kbIdx
      }

      // Skip past this run to avoid quadratic blowup on long verbatim
      // echoes. We've already captured its full extent.
      d = runEnd
    }
  }

  if (bestLen === 0) {
    return { matched: false, longestMatchWords: 0, sampleSnippet: null, kbEntryIndex: null }
  }

  const snippetStart = draftTokens[bestDraftStart].start
  const snippetEnd = draftTokens[bestDraftEnd - 1].end
  return {
    matched: true,
    longestMatchWords: bestLen,
    sampleSnippet: draftText.slice(snippetStart, snippetEnd),
    kbEntryIndex: bestKbIndex,
  }
}
