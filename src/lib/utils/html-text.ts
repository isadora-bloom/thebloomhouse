/**
 * Canonical HTML → plain text utility.
 *
 * Use cases (per T5-Rixey-RR fix #1):
 * - Gmail's `parseEmailBody` falls back to `text/html` when no
 *   `text/plain` part exists. Without stripping, raw HTML (`<strong>The
 *   Knot</strong>`) lands in `interactions.full_body`, then leaks into
 *   structured extraction (lead_source derivation regex'd `</strong>`
 *   onto 13 Rixey weddings — bug #7 in NN).
 * - Form-relay parsers run `fieldAfter()` regexes against the body to
 *   pull "Personal email:", "Wedding date:", etc. An HTML body breaks
 *   field extraction silently.
 * - Brain-dump CRM imports take a free-text "notes" field that may
 *   contain pasted HTML.
 *
 * Use ONLY for fields that feed STRUCTURED extraction (lead_source,
 * names, dates, free-text fields read by AI). Do NOT use for fields
 * meant to be rendered as HTML elsewhere — the inbox renderer wants
 * the raw HTML preserved for `<br>` / `<p>` styling.
 *
 * Implementation: small regex pipeline (no DOMPurify dep). Block-level
 * tags become newlines so "Hi<br>How are you" becomes "Hi\nHow are you"
 * instead of collapsing. Common entities decoded. Numeric + hex
 * entities decoded too.
 */

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
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
  '&laquo;': '«',
  '&raquo;': '»',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
}

/**
 * Heuristic — is this string likely to contain HTML? Cheap-and-fast
 * prefilter so we skip the strip pipeline on the common (plain-text)
 * case. Matches angle brackets adjacent to a word char (so naive
 * sentence content like "5 < 10" doesn't trigger).
 */
export function looksLikeHtml(s: string | null | undefined): boolean {
  if (!s) return false
  return /<[a-zA-Z!\/]/.test(s) || /&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/i.test(s)
}

/**
 * Strip HTML tags + decode entities. Returns plain text suitable for
 * regex-based field extraction or AI prompt grounding.
 *
 * - Removes `<script>` and `<style>` content entirely (not just tags)
 * - Removes `<!-- comments -->`
 * - Converts `<br>`, `</p>`, `</div>`, `</li>`, `</tr>`, `<h1-6>` to
 *   newlines (preserves visual paragraph breaks)
 * - Strips remaining tags
 * - Decodes named entities (HTML_ENTITY_MAP) + numeric + hex entities
 * - Collapses runs of whitespace within a line; preserves newlines
 *
 * Idempotent — running on already-stripped text is a no-op.
 */
export function htmlToText(input: string | null | undefined): string {
  if (!input) return ''
  if (!looksLikeHtml(input)) return input
  let s = input
  // Block-level / unsafe content removal.
  s = s.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  // Block-level tags → newlines. ATTRIBUTE-TOLERANT: real-world emails
  // (Calendly especially) emit `<br style='...'>` and `</p style='...'>`
  // — without [^>]* tolerance, the catch-all below silently stripped
  // them to empty strings, concatenating adjacent label/value pairs
  // and corrupting downstream field extraction. This is the 2026-04-30
  // Rixey scheduling-tool-parsers fix preserved at the canonical layer.
  s = s.replace(/<\s*br\b[^>]*>/gi, '\n')
  s = s.replace(/<\/\s*(p|div|li|tr|td|h[1-6]|table)\s*[^>]*>/gi, '\n')
  // Remove remaining tags.
  s = s.replace(/<[^>]+>/g, '')
  // Decode entities.
  s = s.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  })
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, n) => {
    const code = parseInt(n, 16)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  })
  s = s.replace(/&[a-z]+;/gi, (m) => HTML_ENTITY_MAP[m.toLowerCase()] ?? m)
  // Collapse intra-line whitespace runs but preserve newlines.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((_, i, arr) => {
      // Collapse 3+ blank lines to a single blank.
      if (arr[i] !== '') return true
      return i === 0 || arr[i - 1] !== ''
    })
    .join('\n')
    .trim()
  return s
}
