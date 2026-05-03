/**
 * Field-detector primitive (T5-Rixey-GG / Stream GG).
 *
 * Reusable column-name fuzzy matching + per-column shape inference.
 * Lives in `crm-import/primitives/` so every adapter (HoneyBook,
 * Dubsado, Aisle Planner, generic CSV, and CRMs we haven't seen yet)
 * shares one detector instead of each re-rolling the same regexes
 * inline.
 *
 * Why this exists
 * ---------------
 * Stream FF built the HoneyBook adapter against ASSUMED column shape
 * — Project Status, Client Email, Total — but the real Q1 2026 Rixey
 * export came back with binary `Booked (yes/no)` instead of multi-state
 * Project Status, a concatenated `Client Info` cell instead of separate
 * Client Email, and a Lead Source of "Unknown" on every row. The
 * lesson: every CRM exports differently, even between accounts on the
 * same provider. Patching HoneyBook for Rixey would just punt the same
 * class of bug to the next venue's onboarding.
 *
 * The detector accepts a list of alias groups per canonical key and
 * returns either the resolved column index or null. Aliases are matched
 * case-insensitively with whitespace collapsed; substring matches are
 * accepted to tolerate vendor-prefix noise like "[HoneyBook] Project
 * Date".
 *
 * detectColumnType() takes the headers + first ~20 sample rows and
 * guesses what each column likely contains (date / currency / email /
 * phone / status_enum / free_text / name / id). Useful when the column
 * NAME is wrong but the column CONTENT is unambiguous (a column called
 * "Field 7" that only contains "$1,234.56" cells is obviously a
 * currency column).
 */

// ---------------------------------------------------------------------------
// findColumn — fuzzy column-name lookup
// ---------------------------------------------------------------------------

function normaliseHeader(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim()
}

function normaliseAlias(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Find the first header in `headers` that matches any alias.
 * `aliases` is an array of alias groups so callers can pass multiple
 * synonyms in priority order (first match wins). Returns the matching
 * header EXACTLY as it appeared in the input (preserving case and
 * spacing) so the caller can reuse it for indexing — or null if none
 * matched.
 *
 * Match rules:
 *   - normalised exact match (case-insensitive, whitespace collapsed,
 *     `_` / `.` / `-` treated as space)
 *   - normalised substring match for aliases >= 4 chars (so "Project
 *     Date" matches "[HB] Project Date" and "Project Date (UTC)" but
 *     "id" doesn't match every column with an i and a d in it)
 */
export function findColumn(headers: string[], aliases: string[][]): string | null {
  const normHeaders = headers.map((h) => ({ raw: h, norm: normaliseHeader(h) }))
  for (const group of aliases) {
    const normAliases = group.map((a) => normaliseAlias(a))
    // Prefer exact normalised match.
    for (const h of normHeaders) {
      if (normAliases.some((a) => h.norm === a)) return h.raw
    }
    // Fall back to substring match for longer aliases.
    for (const h of normHeaders) {
      if (normAliases.some((a) => a.length >= 4 && h.norm.includes(a))) return h.raw
    }
  }
  return null
}

/**
 * Find the column index instead of the column name. Returns -1 if no
 * alias matched. Convenience wrapper for adapters that prefer to read
 * by index.
 */
export function findColumnIndex(headers: string[], aliases: string[][]): number {
  const found = findColumn(headers, aliases)
  if (found === null) return -1
  return headers.indexOf(found)
}

// ---------------------------------------------------------------------------
// detectColumnType — shape inference from sample rows
// ---------------------------------------------------------------------------

export type ColumnType =
  | 'date'
  | 'currency'
  | 'email'
  | 'phone'
  | 'status_enum'
  | 'binary_flag'      // yes/no, true/false, 1/0
  | 'integer'
  | 'name'
  | 'free_text'
  | 'id'
  | 'empty'

export interface ColumnTypeGuess {
  type: ColumnType
  /** 0-100 confidence. < 60 means the caller should distrust the guess. */
  confidence: number
  /** Distinct non-empty values seen in the sample (capped at 10). */
  sampleDistinct: string[]
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[+]?[\d\s().-]{7,}$/
const CURRENCY_RE = /^[$€£¥]?\s*[-]?\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})?\s*(?:USD|EUR|GBP|CAD|AUD)?$|^[$€£¥]?\s*\d+(?:[.,]\d{1,2})?\s*$/i
const INTEGER_RE = /^-?\d+$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2}|\s+UTC)?)?$/
const US_DATE_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/
const BINARY_VALUES = new Set(['yes', 'no', 'true', 'false', '1', '0', 'y', 'n'])
const STATUS_HINTS = new Set([
  'inquiry', 'lead', 'new', 'tour', 'tour scheduled', 'tour completed',
  'proposal', 'proposal sent', 'booked', 'completed', 'lost', 'cancelled',
  'canceled', 'archived', 'active', 'in progress', 'won', 'closed-won',
  'closed-lost', 'hold', 'on hold',
])

function looksLikeDate(s: string): boolean {
  if (ISO_DATE_RE.test(s)) return true
  if (US_DATE_RE.test(s)) return true
  // Last ditch: Date.parse for "May 12, 2024" style.
  const d = Date.parse(s)
  return !Number.isNaN(d) && s.length >= 6
}

function looksLikeName(s: string): boolean {
  // Two-or-three capitalised tokens, no digits, no @, length sensible.
  if (s.length < 3 || s.length > 80) return false
  if (/\d|@/.test(s)) return false
  const tokens = s.split(/\s+/).filter(Boolean)
  if (tokens.length < 1 || tokens.length > 4) return false
  // Allow 1+ tokens — a single capitalised token can still be a first name.
  return tokens.every((t) => /^[A-Z][a-zA-Z'.\-]*$/.test(t) || /^[a-z][a-zA-Z'.\-]*$/.test(t))
}

/**
 * For each header, classify the column based on the values seen in the
 * first ~20 sample rows. The returned record is keyed by the EXACT
 * header string from the input (so callers can match it back to their
 * own column index).
 */
export function detectColumnType(
  headers: string[],
  sampleRows: string[][],
): Record<string, ColumnTypeGuess> {
  const out: Record<string, ColumnTypeGuess> = {}
  for (let col = 0; col < headers.length; col++) {
    const header = headers[col]
    const values: string[] = []
    for (const row of sampleRows) {
      const v = (row[col] ?? '').trim()
      if (v) values.push(v)
    }
    if (values.length === 0) {
      out[header] = { type: 'empty', confidence: 100, sampleDistinct: [] }
      continue
    }
    const distinct = Array.from(new Set(values)).slice(0, 10)
    const total = values.length

    // Counters
    let emails = 0, phones = 0, currencies = 0, dates = 0
    let integers = 0, binary = 0, statuses = 0, names = 0
    for (const v of values) {
      const lower = v.toLowerCase()
      if (EMAIL_RE.test(v)) emails++
      if (PHONE_RE.test(v) && /\d{3,}/.test(v) && !EMAIL_RE.test(v)) phones++
      if (CURRENCY_RE.test(v)) currencies++
      if (looksLikeDate(v)) dates++
      if (INTEGER_RE.test(v)) integers++
      if (BINARY_VALUES.has(lower)) binary++
      if (STATUS_HINTS.has(lower)) statuses++
      if (looksLikeName(v)) names++
    }

    // Heuristic: pick the dominant type (>= 70% of samples) and back-off
    // to free_text when nothing dominates.
    const ratio = (n: number) => Math.round((n / total) * 100)

    const candidates: Array<[ColumnType, number]> = [
      ['email', ratio(emails)],
      ['binary_flag', ratio(binary)],
      ['date', ratio(dates)],
      ['currency', ratio(currencies)],
      ['phone', ratio(phones)],
      ['status_enum', distinct.length <= 8 && statuses >= total * 0.5 ? Math.max(60, ratio(statuses)) : ratio(statuses)],
      ['integer', ratio(integers)],
      ['name', ratio(names)],
    ]
    candidates.sort((a, b) => b[1] - a[1])
    const [topType, topPct] = candidates[0]
    if (topPct >= 70) {
      out[header] = { type: topType, confidence: topPct, sampleDistinct: distinct }
      continue
    }
    // If most values are short distinct strings (<= 8 distinct in 20+
    // rows), label as status_enum even without keyword match.
    if (total >= 5 && distinct.length <= 4 && distinct.every((v) => v.length <= 32)) {
      out[header] = { type: 'status_enum', confidence: 65, sampleDistinct: distinct }
      continue
    }
    out[header] = { type: 'free_text', confidence: 50, sampleDistinct: distinct }
  }
  return out
}
