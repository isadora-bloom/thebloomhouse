/**
 * Robust vendor-date parser.
 *
 * Vendor CSVs ship dates in wildly different formats. Knot uses
 * `22-Apr-26`, WeddingWire mixes ISO with relative phrases like
 * "yesterday" or "3 days ago", Instagram exports look like ISO with
 * a Z suffix, Excel users sometimes save serial integers, and the
 * occasional "April 22, 2026" longhand creeps in.
 *
 * Previous implementation (brain-dump-imports.ts:75-103) handled
 * three formats and silently returned null on everything else. The
 * 2026-04-28 audit on a real Rixey Knot CSV showed all 1542 rows
 * landed with null visit_date — the importer's dedup key collapsed
 * and most rows were dropped.
 *
 * This module fails LOUD: when no format matches, the diagnostic
 * shape returned tells the caller exactly what input fell through,
 * so per-row error messages can surface in the import summary
 * instead of a silent skip.
 */

export type DatePrecision = 'day' | 'month' | 'year'

export interface ParsedDate {
  /** YYYY-MM-DD canonical. */
  iso: string
  precision: DatePrecision
  /** Tag of which format matched, for diagnostics. */
  format: string
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 2-digit year resolution: vendor exports are always recent, so we
 * resolve `26` to `2026` (current century) up to ~80 years out;
 * `99` resolves to `1999` to handle the rare archive case. The
 * window pivots at +20 years from "now" — anything within that
 * future window is current century, anything beyond is previous.
 */
function resolveTwoDigitYear(yy: number, nowYear: number): number {
  if (yy >= 100) return yy // already 4-digit, caller mistake but tolerate
  const century = Math.floor(nowYear / 100) * 100
  const candidate = century + yy
  // If the candidate is more than 20 years in the future, drop a century.
  if (candidate > nowYear + 20) return candidate - 100
  return candidate
}

/**
 * Try every supported format. Returns the first match or null when
 * the input is genuinely unparseable. The format tag indicates which
 * branch matched — useful for telemetry on which exports we see.
 */
export function parseVendorDate(raw: string | null | undefined, opts: { now?: Date } = {}): ParsedDate | null {
  if (raw === null || raw === undefined) return null
  const trimmed = String(raw).trim()
  if (!trimmed || trimmed === '.' || trimmed === '-') return null

  const now = opts.now ?? new Date()
  const nowYear = now.getUTCFullYear()

  // ---- ISO with optional time component. The most common modern format. ----
  // 2026-04-22, 2026-04-22T15:30:00Z, 2026-04-22 15:30:00
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/)
  if (isoMatch) {
    const [, y, m, d] = isoMatch
    return { iso: `${y}-${m}-${d}`, precision: 'day', format: 'iso' }
  }

  // ---- DD-MMM-YY / DD-MMM-YYYY (Knot) — "22-Apr-26", "22-Apr-2026". ----
  const dashMonthMatch = trimmed.match(/^(\d{1,2})-([A-Za-z]+)-(\d{2}|\d{4})$/)
  if (dashMonthMatch) {
    const [, dStr, monStr, yStr] = dashMonthMatch
    const month = MONTH_NAMES[monStr.toLowerCase()]
    if (month) {
      const day = Number(dStr)
      const year = yStr.length === 2 ? resolveTwoDigitYear(Number(yStr), nowYear) : Number(yStr)
      if (day >= 1 && day <= 31) {
        return { iso: `${year}-${pad(month)}-${pad(day)}`, precision: 'day', format: 'dd-mmm-yy' }
      }
    }
  }

  // ---- "Apr 22, 2026" / "April 22, 2026" / "Apr 22 2026". ----
  const monthDayYearMatch = trimmed.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{2,4})$/)
  if (monthDayYearMatch) {
    const [, monStr, dStr, yStr] = monthDayYearMatch
    const month = MONTH_NAMES[monStr.toLowerCase()]
    if (month) {
      const day = Number(dStr)
      const year = yStr.length === 2 ? resolveTwoDigitYear(Number(yStr), nowYear) : Number(yStr)
      if (day >= 1 && day <= 31) {
        return { iso: `${year}-${pad(month)}-${pad(day)}`, precision: 'day', format: 'mmm-dd-yyyy' }
      }
    }
  }

  // ---- "22 April 2026" / "22 Apr 2026" (UK / EU long form). ----
  const dayMonthYearMatch = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{2,4})$/)
  if (dayMonthYearMatch) {
    const [, dStr, monStr, yStr] = dayMonthYearMatch
    const month = MONTH_NAMES[monStr.toLowerCase()]
    if (month) {
      const day = Number(dStr)
      const year = yStr.length === 2 ? resolveTwoDigitYear(Number(yStr), nowYear) : Number(yStr)
      if (day >= 1 && day <= 31) {
        return { iso: `${year}-${pad(month)}-${pad(day)}`, precision: 'day', format: 'dd-month-yyyy' }
      }
    }
  }

  // ---- M/D/YYYY (US slash). Defaults to US ordering. ----
  // Vendor exports from US-based platforms (Knot, WeddingWire, Google
  // Business) all use M/D/YYYY. EU coordinators editing CSVs by hand
  // might use D/M/YYYY but that's an edge case the caller can flag
  // explicitly via opts when needed.
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (slashMatch) {
    const [, mStr, dStr, yStr] = slashMatch
    const month = Number(mStr)
    const day = Number(dStr)
    const year = yStr.length === 2 ? resolveTwoDigitYear(Number(yStr), nowYear) : Number(yStr)
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { iso: `${year}-${pad(month)}-${pad(day)}`, precision: 'day', format: 'm-d-y-slash' }
    }
  }

  // ---- DD.MM.YYYY (EU dot). ----
  const dotMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/)
  if (dotMatch) {
    const [, dStr, mStr, yStr] = dotMatch
    const day = Number(dStr)
    const month = Number(mStr)
    const year = yStr.length === 2 ? resolveTwoDigitYear(Number(yStr), nowYear) : Number(yStr)
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { iso: `${year}-${pad(month)}-${pad(day)}`, precision: 'day', format: 'd-m-y-dot' }
    }
  }

  // ---- Excel serial (1900-based, post-epoch). ----
  // 4-6 digit integer. Excel epoch is 1899-12-30 — same offset Microsoft
  // uses, includes the famous 1900 leap-year bug; the exact value is
  // close enough for vendor CSV use.
  if (/^\d{4,6}$/.test(trimmed)) {
    const serial = Number(trimmed)
    if (serial > 1000 && serial < 80000) {
      const ms = (serial - 25569) * 86400 * 1000
      const d = new Date(ms)
      if (!Number.isNaN(d.getTime())) {
        return {
          iso: d.toISOString().split('T')[0],
          precision: 'day',
          format: 'excel-serial',
        }
      }
    }
  }

  // ---- Relative — "yesterday", "today", "N days ago", "N weeks ago". ----
  // WeddingWire's dashboard exports sometimes carry these as the
  // "Last visit" column. Resolve relative to opts.now or new Date().
  const lower = trimmed.toLowerCase()
  if (lower === 'today') {
    return { iso: now.toISOString().split('T')[0], precision: 'day', format: 'relative-today' }
  }
  if (lower === 'yesterday') {
    const d = new Date(now.getTime() - 86400_000)
    return { iso: d.toISOString().split('T')[0], precision: 'day', format: 'relative-yesterday' }
  }
  const relativeMatch = lower.match(/^(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/)
  if (relativeMatch) {
    const n = Number(relativeMatch[1])
    const unit = relativeMatch[2]
    const days =
      unit.startsWith('day') ? n :
      unit.startsWith('week') ? n * 7 :
      unit.startsWith('month') ? n * 30 :
      n * 365
    const d = new Date(now.getTime() - days * 86400_000)
    return { iso: d.toISOString().split('T')[0], precision: 'day', format: 'relative-n-ago' }
  }

  // ---- Year-month — "Apr 2026", "April 2026", "2026-04". ----
  const monthYearMatch = trimmed.match(/^([A-Za-z]+)\.?\s+(\d{4})$/) || trimmed.match(/^(\d{4})-(\d{2})$/)
  if (monthYearMatch) {
    const [whole, a, b] = monthYearMatch
    let year: number
    let month: number
    if (/^[A-Za-z]/.test(whole)) {
      const m = MONTH_NAMES[a.toLowerCase()]
      if (!m) return null
      month = m
      year = Number(b)
    } else {
      year = Number(a)
      month = Number(b)
    }
    if (month >= 1 && month <= 12) {
      return { iso: `${year}-${pad(month)}-01`, precision: 'month', format: 'year-month' }
    }
  }

  // ---- Year only — "2026". ----
  const yearOnlyMatch = trimmed.match(/^(\d{4})$/)
  if (yearOnlyMatch) {
    const year = Number(yearOnlyMatch[1])
    if (year >= 1900 && year <= 2100) {
      return { iso: `${year}-01-01`, precision: 'year', format: 'year-only' }
    }
  }

  return null
}

/**
 * Convenience wrapper for the import path: returns iso string or
 * null. Callers that need precision/format should use parseVendorDate
 * directly.
 */
export function parseVendorDateIso(raw: string | null | undefined): string | null {
  return parseVendorDate(raw)?.iso ?? null
}
