/**
 * Bloom House — Structured email-anatomy parser (Wave 3 — deep fix).
 *
 * Anchor docs:
 *   - IDENTITY-CAPTURE-DESIGN.md § 2 site #16-18 (body extractor / brain-
 *     dump LLM extraction / form-relay parsers)
 *   - IDENTITY-EXTRACTION-V2.md (contract change, cost estimates)
 *   - bloom-constitution.md (forensic identity reconstruction)
 *
 * Why this file exists
 * --------------------
 * The legacy body extractor at `src/lib/services/identity/body-extract.ts`
 * walks a flat haystack with a NAME_RE that captures any "Capitalized
 * Capitalized" pair. It cannot tell:
 *
 *   - "Hi Megan" (greeting + addressee — Megan is the COORDINATOR, not
 *     the prospect) from "Hi, my fiancée Sarah and I" (Sarah is a
 *     mentioned human).
 *   - The sender's signature ("Cheers, Mike") from a name dropped in the
 *     body for a different reason ("Mike from Knot is helping us tour
 *     venues").
 *   - A forwarded chain from the relay's framing — both look like one
 *     long body to a flat regex.
 *
 * Wave 3's deep fix replaces the flat extraction with structured
 * email-anatomy parsing FIRST (this file) so the downstream LLM
 * extractor (`identity-from-email.ts`) gets a layout-aware payload:
 * salutation block, body block, signature block, forwarded block. The
 * LLM can then reason "the addressee is the coordinator's first name,
 * the sender's identity is in the signature, mentioned humans live in
 * the body."
 *
 * What this file is NOT
 * ---------------------
 *   - NOT identity classification — that lives in `identity-from-email.ts`
 *     and uses the output of this parser as one of its inputs.
 *   - NOT the chokepoint — `identity/name-capture.ts` still owns the
 *     write contract; this is upstream extraction.
 *   - NOT a replacement for `body-extract.ts`'s email/phone/date hint
 *     extraction. Those still run downstream — this file only parses
 *     the BODY ANATOMY (where the salutation ends, where the signature
 *     starts, what's a forwarded chunk).
 */

import { htmlToText, looksLikeHtml } from '@/lib/utils/html-text'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedEmailAnatomy {
  /** The full salutation line, e.g. "Hi Megan,". Null when no recognised
   *  salutation is present (e.g. plain calculator submission body). */
  salutation: string | null
  /** Just the addressee name from the salutation, e.g. "Megan". This is
   *  the person being WRITTEN TO, NOT the sender. Identity classifiers
   *  must NOT treat this as the sender's identity. */
  salutationName: string | null
  /** The actual content of the email — between the salutation block and
   *  the signature block. Always populated when input is non-empty. */
  body: string
  /** Final signature block, e.g. "Cheers,\nMike\n555-1234". Null when
   *  no signoff token is found at the tail of the body. */
  signature: string | null
  /** Just the signature name, e.g. "Mike". This is the SENDER's stated
   *  name from their sign-off; the strongest single signal of the
   *  sender's first name when the From-header is a relay. */
  signoffName: string | null
  /** When the email contains a forwarded chain (`On Fri ... wrote:` /
   *  `From: foo@bar.com`), recursively parse the forwarded chunk so the
   *  LLM extractor can pull the ORIGINAL sender's identity rather than
   *  the relay's. Null when no forwarded block detected. */
  forwarded: ParsedEmailAnatomy | null
  /** True when the input contained HTML and we stripped it before
   *  parsing. Useful to surface in audit logs — HTML-stripped bodies
   *  occasionally lose nuance the LLM might want to flag. */
  htmlStripped: boolean
}

// ---------------------------------------------------------------------------
// Salutation detection
// ---------------------------------------------------------------------------

/**
 * Salutation tokens that introduce the addressee. The captured group is
 * the addressee — see SALUTATION_RE. Tuned to match real-world emails:
 *   - "Hi Megan,"
 *   - "Hello Isadora—"
 *   - "Hey Sage!"
 *   - "Dear Mr. Jones,"
 *   - "Greetings,"
 *   - "Good morning Megan,"
 */
const SALUTATION_TOKENS = [
  'hi', 'hello', 'hey', 'dear', 'greetings', 'hiya', 'howdy',
  'good morning', 'good afternoon', 'good evening',
]

const SALUTATION_RE = new RegExp(
  // ^ (start of line OR start of body) + salutation token + optional
  // addressee + terminator. Comma / colon / dash / exclamation / period
  // / newline all close the salutation.
  '^(?:' + SALUTATION_TOKENS.join('|') + ')\\b' +
  // Optional addressee name(s) — captured. Up to 4 tokens; allows
  // honorifics (Mr., Mrs., Dr.) plus first name.
  '(?:[ \\t]+([A-Za-z][A-Za-z.\'-]{0,30}(?:[ \\t]+[A-Za-z][A-Za-z.\'-]{0,30}){0,3}))?' +
  // Closing punctuation (optional — "Hi Megan" with no comma still ok).
  '[, !.:—–-]*\\s*$',
  'i',
)

/**
 * Try to identify the salutation as the FIRST non-empty line. Returns
 * the matched line text + addressee name + line index, or null when no
 * salutation is present. The line index is the index INTO the input
 * lines so the caller can slice from line+1 to find the body start.
 */
function detectSalutationLine(lines: string[]): {
  line: string
  addressee: string | null
  lineIndex: number
} | null {
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    const m = trimmed.match(SALUTATION_RE)
    if (m) {
      const addressee = (m[1] ?? '').trim() || null
      return { line: trimmed, addressee, lineIndex: i }
    }
    // Stop after the first non-empty non-matching line — salutations
    // never come AFTER body content.
    return null
  }
  return null
}

// ---------------------------------------------------------------------------
// Signature detection
// ---------------------------------------------------------------------------

/**
 * Sign-off tokens that introduce a signature block. Match the START of
 * the line. Capture group 1 is the signoff phrase itself; the line(s)
 * AFTER it carry the name + contact details.
 */
const SIGNOFF_TOKENS = [
  'cheers', 'best', 'best wishes', 'best regards', 'kind regards',
  'warmly', 'warm regards', 'sincerely', 'thanks', 'thank you',
  'thanks so much', 'many thanks', 'regards', 'respectfully',
  'talk soon', 'looking forward', 'with gratitude', 'gratefully',
  'all the best', 'yours truly', 'yours',
]

// Sort longest-first so "thanks so much" matches before "thanks".
const SIGNOFF_RE = new RegExp(
  '^[ \\t]*(?:' + [...SIGNOFF_TOKENS].sort((a, b) => b.length - a.length).join('|') + ')[, !.:—–-]*\\s*$',
  'i',
)

// Em-dash / hyphen / double-dash on its own line is a common signature
// preamble: "—\nMike" or "--\nMike" or "-Mike" all mean "what follows
// is a signature."
const DASH_SIGNOFF_RE = /^[ \t]*[-—–]{1,3}[ \t]*([A-Za-z].{0,40})?\s*$/

/**
 * Find the signature block. Walks the lines from the BOTTOM up looking
 * for a signoff token; everything from that line through the end is the
 * signature. When a leading dash form is detected (`—Mike`), the name
 * is extracted from the same line.
 *
 * Returns:
 *   - signatureLineIndex: first line of the signature block (inclusive)
 *   - signoffName: the name parsed out of the signature, or null
 */
function detectSignatureBlock(lines: string[]): {
  signatureLineIndex: number
  signoffName: string | null
} | null {
  // Walk from bottom up; only consider the last ~15 non-empty lines so
  // a "best" buried in a long quoted block doesn't get treated as the
  // signoff.
  let nonEmptySeen = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    nonEmptySeen += 1
    if (nonEmptySeen > 15) break

    // Plain dash signoff with inline name (—Tom, --Sarah, -Mike).
    const dashMatch = trimmed.match(DASH_SIGNOFF_RE)
    if (dashMatch) {
      const inline = (dashMatch[1] ?? '').trim() || null
      // If the dash line itself has a name, use it; otherwise scan the
      // next non-empty line below.
      if (inline) {
        return { signatureLineIndex: i, signoffName: extractNameFromSignoffLine(inline) }
      }
      // Fall through to look at the line after.
      const nameLine = nextNonEmpty(lines, i + 1)
      return {
        signatureLineIndex: i,
        signoffName: nameLine ? extractNameFromSignoffLine(nameLine) : null,
      }
    }

    // Word signoff (Cheers, Best, Thanks, etc.).
    if (SIGNOFF_RE.test(trimmed)) {
      const nameLine = nextNonEmpty(lines, i + 1)
      return {
        signatureLineIndex: i,
        signoffName: nameLine ? extractNameFromSignoffLine(nameLine) : null,
      }
    }
  }
  return null
}

function nextNonEmpty(lines: string[], from: number): string | null {
  for (let i = from; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t) return t
  }
  return null
}

/**
 * Extract just the name from a signature line. Strips trailing comma /
 * period, drops phone numbers / emails / URLs that sometimes appear on
 * the same line as the name.
 */
function extractNameFromSignoffLine(line: string): string | null {
  if (!line) return null
  let s = line.trim()
  // Strip trailing punctuation.
  s = s.replace(/[,.!]+$/, '').trim()
  // If the line contains a phone / email / URL, slice up to it.
  const phoneIdx = s.search(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/)
  if (phoneIdx > 0) s = s.slice(0, phoneIdx).trim()
  const emailIdx = s.search(/[\w._%+-]+@[\w.-]+\.[a-zA-Z]{2,}/)
  if (emailIdx > 0) s = s.slice(0, emailIdx).trim()
  const urlIdx = s.search(/https?:\/\//i)
  if (urlIdx > 0) s = s.slice(0, urlIdx).trim()
  // Strip pipe / dash separators that appear in HTML signature blocks
  // ("Mike Smith | CEO | Acme Co.").
  const pipeIdx = s.indexOf('|')
  if (pipeIdx > 0) s = s.slice(0, pipeIdx).trim()
  // Strip trailing comma again after slicing.
  s = s.replace(/[,.!]+$/, '').trim()
  if (!s) return null
  // Sanity-bound: signature names rarely exceed 60 chars.
  if (s.length > 60) return null
  // Reject lines that are mostly digits / non-letter chars.
  const letters = s.match(/[A-Za-z]/g)?.length ?? 0
  if (letters < 2) return null
  return s
}

// ---------------------------------------------------------------------------
// Forwarded-block detection
// ---------------------------------------------------------------------------

/**
 * Forwarded-chain markers. Order matters — most specific first.
 *   - "On Fri, May 9, 2026 at 10:23 AM, Madison Bryant <madison@gmail.com> wrote:"
 *   - "---------- Forwarded message ----------"
 *   - "Begin forwarded message:"
 *   - "From: Madison Bryant <madison@gmail.com>" at line start
 */
const FORWARD_MARKERS: Array<{ re: RegExp; label: string }> = [
  { re: /^[ \t]*On\s+.{5,80}?\s+wrote:\s*$/im, label: 'on_wrote' },
  { re: /^-{5,}\s*Forwarded message\s*-{5,}\s*$/im, label: 'gmail_forward' },
  { re: /^Begin forwarded message:\s*$/im, label: 'apple_forward' },
  { re: /^From:\s+.+@.+\..+\s*$/im, label: 'header_from' },
]

/**
 * Find the FIRST forward marker in the body. Returns the line index of
 * the marker (so the caller can slice the body up to that line and
 * recursively parse the chunk after).
 */
function detectForwardedStart(lines: string[]): number | null {
  for (let i = 0; i < lines.length; i++) {
    for (const { re } of FORWARD_MARKERS) {
      if (re.test(lines[i])) {
        return i
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

/**
 * Parse an email body into structured anatomy:
 *   - salutation block (greeting + addressee name)
 *   - body block (the actual content)
 *   - signature block (signoff + sender name)
 *   - forwarded block (recursive — for forwarded chains)
 *
 * HTML is stripped via the canonical `htmlToText` helper before parsing
 * so signatures buried in `<br>`-separated HTML don't get missed.
 *
 * Pure function — no DB, no LLM, no side effects. Safe to call from any
 * runtime (Edge, Node, test).
 */
export function parseEmailAnatomy(rawBody: string): ParsedEmailAnatomy {
  const empty: ParsedEmailAnatomy = {
    salutation: null,
    salutationName: null,
    body: '',
    signature: null,
    signoffName: null,
    forwarded: null,
    htmlStripped: false,
  }
  if (!rawBody || !rawBody.trim()) return empty

  const htmlStripped = looksLikeHtml(rawBody)
  const text = htmlStripped ? htmlToText(rawBody) : rawBody
  if (!text || !text.trim()) return { ...empty, htmlStripped }

  const lines = text.split('\n')

  // 1. Detect forwarded marker FIRST. Anything from the marker line down
  //    is forwarded content; we recurse on it. The "primary" anatomy is
  //    everything before the marker.
  const fwdIdx = detectForwardedStart(lines)
  let primaryLines: string[] = lines
  let forwarded: ParsedEmailAnatomy | null = null
  if (fwdIdx !== null) {
    primaryLines = lines.slice(0, fwdIdx)
    const forwardedRaw = lines.slice(fwdIdx + 1).join('\n').trim()
    if (forwardedRaw) {
      // Strip the next-level header noise (From:/To:/Subject:/Date:)
      // before recursing so the recursed pass actually finds a real
      // body and salutation.
      const withoutHeaders = stripForwardedHeaders(forwardedRaw)
      forwarded = parseEmailAnatomy(withoutHeaders)
    }
  }

  // 2. Salutation in the primary block.
  const sal = detectSalutationLine(primaryLines)

  // 3. Signature block in the primary block.
  const sig = detectSignatureBlock(primaryLines)

  // 4. Body = lines between salutation (exclusive) and signature
  //    (exclusive). When salutation is missing, body starts at line 0.
  //    When signature is missing, body runs to end.
  const bodyStart = sal ? sal.lineIndex + 1 : 0
  const bodyEnd = sig ? sig.signatureLineIndex : primaryLines.length
  const bodyLines = primaryLines.slice(bodyStart, bodyEnd)
  const body = bodyLines.join('\n').trim()

  const signatureBlock = sig
    ? primaryLines.slice(sig.signatureLineIndex).join('\n').trim() || null
    : null

  return {
    salutation: sal ? sal.line : null,
    salutationName: sal ? sal.addressee : null,
    body,
    signature: signatureBlock,
    signoffName: sig ? sig.signoffName : null,
    forwarded,
    htmlStripped,
  }
}

/**
 * Strip the leading From: / To: / Subject: / Date: / Sent: / Cc: header
 * lines that immediately follow a forwarded marker. Stops at the first
 * non-header line and returns the rest. Handles header lines that wrap.
 */
function stripForwardedHeaders(text: string): string {
  const lines = text.split('\n')
  const HEADER_RE = /^\s*(From|To|Cc|Bcc|Date|Sent|Subject|Reply-To):/i
  let i = 0
  // Skip blank lines + header lines + their continuations (lines that
  // start with whitespace and appear right after a header).
  let inHeader = false
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      // Blank line ends the header block — but only if we've actually
      // seen a header start.
      if (inHeader) {
        i += 1
        break
      }
      i += 1
      continue
    }
    if (HEADER_RE.test(line)) {
      inHeader = true
      i += 1
      continue
    }
    // Non-header line — done.
    break
  }
  return lines.slice(i).join('\n')
}
