/**
 * Calendly custom-questions parser.
 *
 * Why this exists (operator-reported 2026-05-27):
 * ----------------------------------------------
 * Calendly tour-booking notifications arrive from `notifications@calendly.com`
 * with a structured Questions block in the HTML body — `<strong>Label</strong>`
 * followed by `<p>Answer</p>`. Rixey's Calendly form asks SIX custom
 * questions, including "Where did you first hear about us?" which is the
 * SINGLE most valuable per-couple source signal we have for Calendly-direct
 * bookings.
 *
 * Before this parser, Bloom ingested Calendly notifications but did NOT
 * extract custom-question answers — every Calendly-direct couple landed as
 * `source=calendly` (or `direct/unknown`) even when they wrote "Google" or
 * "The Knot" in the form. The operator caught a real example: Jennifer
 * Nguyen wrote "The Knot" in the Calendly form but BYPASSED the Knot
 * inquiry flow and booked Calendly directly — and Bloom logged her as
 * direct, losing the Knot attribution entirely.
 *
 * Related but distinct from `scheduling-tool-parsers.ts:parseCalendly`,
 * which DOES extract the same fields via `extractLabelled()` against the
 * HTML-stripped text. That works for live ingestion but:
 *   - It runs html→text BEFORE field extraction, which collapses the
 *     `<strong>Label</strong><p>Answer</p>` structure into two adjacent
 *     text lines and relies on heuristic shape regexes. Works most of the
 *     time but is brittle to Calendly markup changes.
 *   - It surfaces extras via `SchedulingEvent.extras` but the source value
 *     is the LITERAL answer ("Google"), not the canonical source key
 *     (`google`).
 *
 * This module is the orthogonal HTML-first parser that:
 *   1. Parses the Questions block directly from HTML markup
 *   2. Normalizes question labels (lowercase, strip punctuation)
 *   3. Provides typed accessors with FUZZY question-label matching so
 *      "Where did you first hear about us?" and "How did you find us?"
 *      both resolve to the source accessor
 *   4. Canonicalizes the source answer to the `signals.source` vocabulary
 *      ('the_knot', 'google', 'instagram', etc.) used by the unified
 *      classifier — so downstream consumers don't have to re-canonicalize
 *
 * Both parsers are kept side-by-side. The HTML-first one is the more
 * reliable signal for source canonicalization; the plain-text one stays
 * load-bearing for the rest of the scheduling-event flow (event date,
 * invitee email, partner extras, kind classification).
 */

/**
 * Canonical source vocabulary. Mirrors the `signals.source` enum on
 * `IntentVerdict` (see `intel/inbound-intent-classifier.ts`). Kept narrow
 * — when an answer doesn't match any of these we return null and let the
 * caller decide whether to fall back to 'other'.
 */
export type CalendlyCanonicalSource =
  | 'the_knot'
  | 'wedding_wire'
  | 'here_comes_the_guide'
  | 'zola'
  | 'google'
  | 'instagram'
  | 'facebook'
  | 'pinterest'
  | 'tiktok'
  | 'referral'
  | 'website'
  | 'walk_in'
  | 'calendly'
  | 'wedding_pro'
  | 'other'

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

const HTML_ENTITY_MAP: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
}

function decodeEntities(s: string): string {
  let out = s
  for (const [entity, replacement] of Object.entries(HTML_ENTITY_MAP)) {
    out = out.split(entity).join(replacement)
  }
  // Numeric entities &#123;
  out = out.replace(/&#(\d+);/g, (_, dec) => {
    const n = parseInt(dec, 10)
    return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ''
  })
  // Hex entities &#xAB;
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const n = parseInt(hex, 16)
    return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ''
  })
  return out
}

/** Strip inline HTML tags, keep text. Preserves newlines from <br> / </p>. */
function stripInlineHtml(s: string): string {
  return s
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
}

/**
 * Normalize a label so two textually-different but semantically-identical
 * questions ("Where did you first hear about us?" vs "where did you FIRST
 * hear about us ") collapse to the same key.
 *
 *   - Decode HTML entities
 *   - Lowercase
 *   - Strip everything except a-z 0-9 + spaces
 *   - Collapse runs of whitespace
 */
function normalizeLabel(raw: string): string {
  const decoded = decodeEntities(stripInlineHtml(raw))
  return decoded
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanValue(raw: string): string {
  return decodeEntities(stripInlineHtml(raw))
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parse the Questions block out of a Calendly HTML body.
 *
 * Defensive design — Calendly's markup has shifted at least twice in
 * production. We support three shapes:
 *
 *   1. <strong>Label</strong>...<p>Answer</p>     (current 2026-05)
 *   2. <strong>Label</strong><br>Answer<br>       (older variant)
 *   3. Plain text "Label\nAnswer"                  (post html→text fallback)
 *
 * Returns a normalized-key → value map. Empty {} when no recognizable
 * questions block is present. NEVER throws.
 */
export function parseCalendlyQuestions(html: string | null | undefined): Record<string, string> {
  if (!html || typeof html !== 'string') return {}

  try {
    const out: Record<string, string> = {}

    // Shape 1+2: <strong>Label</strong>...(answer)...<until next <strong>)
    // The answer chunk can contain multiple <p> blocks; we collect everything
    // between this <strong> and the next <strong> (or end-of-string), then
    // strip tags and rejoin paragraphs.
    const strongRe = /<strong[^>]*>([\s\S]*?)<\/strong\s*>/gi
    const matches: Array<{ label: string; start: number; end: number }> = []
    let m: RegExpExecArray | null
    while ((m = strongRe.exec(html)) !== null) {
      matches.push({
        label: m[1],
        start: m.index,
        end: m.index + m[0].length,
      })
    }

    if (matches.length > 0) {
      for (let i = 0; i < matches.length; i++) {
        const labelRaw = matches[i].label
        const valueStart = matches[i].end
        const valueEnd = i + 1 < matches.length ? matches[i + 1].start : html.length
        const valueRaw = html.slice(valueStart, valueEnd)

        const key = normalizeLabel(labelRaw)
        if (!key) continue

        // Skip labels that aren't form-question shaped — Calendly puts
        // tons of <strong> tags around UI chrome ("Manage event", "Add to
        // calendar", "Schedule a new event"). Real question labels are
        // SHORT (<=80 chars after normalization) and contain at least one
        // letter group.
        if (key.length > 80) continue
        if (!/^[a-z0-9 ]+$/.test(key)) continue

        // Value extraction: prefer the FIRST <p> block when present (that's
        // the answer slot in shape 1). Fall back to all text when there's
        // no <p>.
        let value: string
        const pMatch = valueRaw.match(/<p[^>]*>([\s\S]*?)<\/p\s*>/i)
        if (pMatch) {
          // Multi-paragraph: join all <p> blocks
          const allP: string[] = []
          const pAll = /<p[^>]*>([\s\S]*?)<\/p\s*>/gi
          let pm: RegExpExecArray | null
          while ((pm = pAll.exec(valueRaw)) !== null) {
            const v = cleanValue(pm[1])
            if (v) allP.push(v)
          }
          value = allP.join(' ')
        } else {
          value = cleanValue(valueRaw)
        }

        // Reject empty values + values that are themselves another label
        // (e.g. Calendly puts <strong>Label</strong> right next to another
        // <strong>Label</strong>; the slice between them is whitespace).
        if (!value) continue
        // Reject answers > 500 chars — almost certainly we slurped multiple
        // sections including footer / disclaimer text.
        if (value.length > 500) continue

        // First wins — if Calendly emits the same label twice (very rare),
        // we trust the first occurrence.
        if (!(key in out)) {
          out[key] = value
        }
      }
    }

    // Shape 3: plain-text fallback. Run when shape 1 found nothing AND
    // the body looks like it might be plain text (or a html→text dump).
    // Patterns:
    //   "Label\nAnswer\n"
    //   "Label\n\nAnswer\n"
    //   "Label: Answer"  (the same pattern scheduling-tool-parsers handles
    //     — we duplicate it here as a defense for when an upstream html→text
    //     stripping changes shape)
    if (Object.keys(out).length === 0) {
      const text = stripInlineHtml(decodeEntities(html))
      // Look for a "Questions:" section header followed by Q&A pairs
      const questionsMatch = text.match(/questions\s*:?\s*\n([\s\S]+?)$/i)
      const scope = questionsMatch ? questionsMatch[1] : text

      // Two-line shape: label line followed by answer line.
      const lines = scope.split(/\r?\n/).map((l) => l.trim())
      for (let i = 0; i < lines.length - 1; i++) {
        const labelLine = lines[i]
        if (!labelLine || labelLine.length > 100) continue
        // Skip pure-whitespace and section headers
        if (/^(invitee|invitee email|event date|location|event type|additional guests|description|questions)$/i.test(labelLine)) continue
        // The label line should not contain typical value chars (digits,
        // @, etc.) unless mixed with letters
        if (/^[\d\s./:-]+$/.test(labelLine)) continue
        // Find the next non-empty line
        let j = i + 1
        while (j < lines.length && !lines[j]) j++
        if (j >= lines.length) continue
        const answerLine = lines[j]
        if (!answerLine || answerLine.length > 500) continue
        // Heuristic: a real label line ends with `?` OR is short and
        // doesn't end with a sentence punctuation.
        const looksLikeLabel =
          labelLine.endsWith('?') ||
          (labelLine.length <= 80 && !/[.!]$/.test(labelLine))
        if (!looksLikeLabel) continue
        const key = normalizeLabel(labelLine)
        if (!key || key.length > 80) continue
        if (!/^[a-z0-9 ]+$/.test(key)) continue
        if (!(key in out)) out[key] = answerLine
      }
    }

    return out
  } catch (err) {
    // Defensive — Calendly markup may shift unexpectedly. Better to
    // return {} than throw and break the pipeline.
    if (typeof console !== 'undefined') {
      console.warn(
        '[calendly-questions-parser] parse failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
    return {}
  }
}

// ---------------------------------------------------------------------------
// Typed accessors with fuzzy label matching
// ---------------------------------------------------------------------------

/**
 * Resolve the first question whose normalized label matches any of the
 * given pattern substrings (all substrings must appear in any order).
 *
 * Why substrings, not exact match: venues word the question differently
 * ("Where did you first hear about us?" / "How did you hear about us?" /
 * "How did you find us?" / "Where did you find us?"). All three should
 * resolve to the source accessor.
 */
function findAnswerByPatterns(
  questions: Record<string, string>,
  patterns: string[][],
): string | null {
  for (const pattern of patterns) {
    for (const [key, value] of Object.entries(questions)) {
      if (pattern.every((token) => key.includes(token))) {
        return value
      }
    }
  }
  return null
}

export function getCalendlyPartnerName(qs: Record<string, string>): string | null {
  return findAnswerByPatterns(qs, [
    ['partner', 'first', 'last', 'name'],
    ['partner', 'first', 'last'],
    ['partner', 'name'],
    ['fiance', 'name'],
    ['partner', 's', 'name'], // "partner's name" normalizes to "partner s name"
  ])
}

export function getCalendlyPartnerEmail(qs: Record<string, string>): string | null {
  const raw = findAnswerByPatterns(qs, [
    ['partner', 'email'],
    ['fiance', 'email'],
    ['partner', 's', 'email'],
  ])
  if (!raw) return null
  if (!raw.includes('@')) return null
  // Extract just the email if there's surrounding text
  const m = raw.match(/[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  return m ? m[0].toLowerCase() : null
}

export function getCalendlyPhone(qs: Record<string, string>): string | null {
  const raw = findAnswerByPatterns(qs, [
    ['phone', 'number'],
    ['phone'],
    ['mobile'],
    ['cell'],
  ])
  if (!raw) return null
  // Keep only digits + leading + sign
  const digits = raw.replace(/[^\d+]/g, '')
  if (digits.length < 7) return null
  return digits.slice(0, 20)
}

export function getCalendlyEventDate(qs: Record<string, string>): string | null {
  const raw = findAnswerByPatterns(qs, [
    ['approximate', 'date'],
    ['wedding', 'date'],
    ['event', 'date'],
    ['date', 'mind'],
    ['preferred', 'date'],
  ])
  if (!raw) return null
  // Try ISO first
  const iso = raw.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/)
  if (iso) return iso[0]
  // Try "August 15th 2027" → ISO. Strip ordinal suffix (st/nd/rd/th).
  const noOrdinal = raw.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1')
  const t = Date.parse(noOrdinal)
  if (!Number.isNaN(t)) {
    const d = new Date(t)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }
  // Last resort — return the literal string, downstream can re-parse
  return raw
}

export function getCalendlyGuestCount(qs: Record<string, string>): number | null {
  const raw = findAnswerByPatterns(qs, [
    ['number', 'guests'],
    ['number', 'invited', 'guests'],
    ['guest', 'count'],
    ['guests'],
  ])
  if (!raw) return null
  // Range: "150-200" → midpoint
  const range = raw.match(/(\d+)\s*[-–—to]+\s*(\d+)/)
  if (range) {
    const lo = parseInt(range[1], 10)
    const hi = parseInt(range[2], 10)
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return Math.round((lo + hi) / 2)
    }
  }
  // Single number
  const single = raw.match(/\d+/)
  if (single) {
    const n = parseInt(single[0], 10)
    if (Number.isFinite(n) && n > 0 && n < 10000) return n
  }
  return null
}

/**
 * Source-answer → canonical source key.
 *
 * Matches against the literal answer (case-insensitive, substring). The
 * vocabulary aligns with `IntentVerdict.signals.source` so the unified
 * classifier and the Calendly parser produce identical canonical keys.
 *
 * Returns null when the answer is empty / unrecognizable. Returns 'other'
 * when the answer is non-empty but doesn't match any known source — the
 * caller can decide whether to store 'other' or treat as null.
 */
export function getCalendlySourceRaw(qs: Record<string, string>): string | null {
  return findAnswerByPatterns(qs, [
    ['where', 'first', 'hear'],
    ['where', 'hear'],
    ['how', 'hear'],
    ['how', 'find'],
    ['where', 'find'],
    ['hear', 'about'],
    ['find', 'us'],
    ['referred', 'by'],
    ['source'],
  ])
}

/**
 * Mapping table — substring tokens → canonical key. Order matters; first
 * match wins. Each entry: [tokens_to_match[], canonical].
 *
 * Tokens must ALL appear (case-insensitive substring) in the answer. We
 * keep the table conservative — unrecognized free-text answers ("a
 * friend", "drove by") return null so the caller doesn't auto-stamp
 * 'other' over a non-null existing source.
 */
const SOURCE_PATTERNS: Array<[string[], CalendlyCanonicalSource]> = [
  // Knot variants
  [['the knot'], 'the_knot'],
  [['knot'], 'the_knot'],
  [['theknot'], 'the_knot'],
  [['wedding pro'], 'wedding_pro'],
  // WeddingWire
  [['wedding wire'], 'wedding_wire'],
  [['weddingwire'], 'wedding_wire'],
  // Here Comes The Guide
  [['here comes the guide'], 'here_comes_the_guide'],
  [['herecomestheguide'], 'here_comes_the_guide'],
  [['hctg'], 'here_comes_the_guide'],
  // Zola
  [['zola'], 'zola'],
  // Pinterest before "instagram" so a "pinterest / instagram" answer still
  // sees both options. Actually first-wins so just pick the most likely.
  [['pinterest'], 'pinterest'],
  [['instagram'], 'instagram'],
  [['insta'], 'instagram'],
  [['ig'], 'instagram'],
  [['facebook'], 'facebook'],
  [['meta'], 'facebook'],
  [['fb'], 'facebook'],
  [['tiktok'], 'tiktok'],
  [['tik tok'], 'tiktok'],
  // Google
  [['google'], 'google'],
  // Referral
  [['friend'], 'referral'],
  [['referral'], 'referral'],
  [['referred'], 'referral'],
  [['word of mouth'], 'referral'],
  [['recommendation'], 'referral'],
  // Website
  [['website'], 'website'],
  [['your site'], 'website'],
  [['google search'], 'google'],
  // Walk-in / drive-by
  [['walk in'], 'walk_in'],
  [['walkin'], 'walk_in'],
  [['drove by'], 'walk_in'],
  [['drive by'], 'walk_in'],
  [['saw the sign'], 'walk_in'],
]

/**
 * Returns the canonical source key for the source answer, or null when
 * no answer was present. Returns 'other' when the answer is non-empty
 * but no pattern matched — the caller chooses how to handle 'other'.
 */
export function getCalendlySource(qs: Record<string, string>): CalendlyCanonicalSource | null {
  const raw = getCalendlySourceRaw(qs)
  if (!raw) return null
  const lower = raw.toLowerCase()
  for (const [tokens, canonical] of SOURCE_PATTERNS) {
    if (tokens.every((t) => lower.includes(t))) return canonical
  }
  return 'other'
}

export function getCalendlyPackageInterest(qs: Record<string, string>): string | null {
  return findAnswerByPatterns(qs, [
    ['which package', 'packages', 'interested'],
    ['which package', 'interested'],
    ['package', 'interested'],
    ['package'],
  ])
}

/** "Yes" → true, "No" → false, anything else → null. Case-insensitive. */
export function getCalendlyBuiltCalculator(qs: Record<string, string>): boolean | null {
  const raw = findAnswerByPatterns(qs, [
    ['built', 'package', 'pricing', 'calculator'],
    ['built', 'pricing', 'calculator'],
    ['used', 'pricing', 'calculator'],
    ['pricing', 'calculator'],
    ['calculator'],
  ])
  if (!raw) return null
  const lower = raw.trim().toLowerCase()
  if (/^y(es)?\b/.test(lower)) return true
  if (/^no?\b/.test(lower)) return false
  return null
}

// ---------------------------------------------------------------------------
// Convenience bundle
// ---------------------------------------------------------------------------

export interface CalendlyQuestionsBundle {
  raw: Record<string, string>
  partnerName: string | null
  partnerEmail: string | null
  phone: string | null
  eventDate: string | null
  guestCount: number | null
  source: CalendlyCanonicalSource | null
  /** The LITERAL answer the couple wrote — preserved for forensic / audit
   *  use. Distinct from `source` (which is canonicalized). */
  sourceLiteral: string | null
  packageInterest: string | null
  builtCalculator: boolean | null
}

/**
 * One-shot extraction. Returns null when the body has no Questions block.
 * NEVER throws.
 */
export function extractCalendlyQuestions(
  html: string | null | undefined,
): CalendlyQuestionsBundle | null {
  const raw = parseCalendlyQuestions(html)
  if (Object.keys(raw).length === 0) return null
  return {
    raw,
    partnerName: getCalendlyPartnerName(raw),
    partnerEmail: getCalendlyPartnerEmail(raw),
    phone: getCalendlyPhone(raw),
    eventDate: getCalendlyEventDate(raw),
    guestCount: getCalendlyGuestCount(raw),
    source: getCalendlySource(raw),
    sourceLiteral: getCalendlySourceRaw(raw),
    packageInterest: getCalendlyPackageInterest(raw),
    builtCalculator: getCalendlyBuiltCalculator(raw),
  }
}
