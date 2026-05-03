/**
 * Financial-parser primitive (T5-Rixey-GG / Stream GG).
 *
 * Bloom stores all currency as integer CENTS (never decimal). Source
 * CRMs ship currency as one of several conventions:
 *   - "$4,500.00"
 *   - "4,500.00"
 *   - "4500"
 *   - "4500.00"
 *   - "$4,500"
 *   - "$4500.00 USD"
 *   - "(4,500.00)"     parenthesised negatives (HoneyBook accounting)
 *   - ""               empty / null
 *
 * `parseCurrency` handles all of the above and returns an integer
 * number of cents, or `null` for unparseable / empty inputs.
 *
 * `parseFinancials` extracts a structured financial object from a row
 * keyed by canonical names (total / tax / paid / gratuity / refunded).
 * Adapters supply per-CRM alias maps so the same caller code works for
 * HoneyBook (`Total Project Value`) and Dubsado (`Total Invoiced`).
 *
 * Why this exists
 * ---------------
 * Real Q1 2026 Rixey HoneyBook export ships SIX financial columns
 * Stream FF didn't anticipate: Total Project Value, Tax, Total Paid,
 * Gratuity, Refunded Amount, plus the Booked binary. We can't just
 * cram all of them into `weddings.booking_value` — coordinators care
 * about how much was paid vs total vs refunded. Migration 175 adds
 * the matching columns; this primitive does the parsing.
 *
 * Tax-inclusive ambiguity
 * -----------------------
 * HoneyBook's Total Project Value is INCLUSIVE of tax in some accounts
 * and EXCLUSIVE in others (it depends on whether the coordinator set
 * tax up as a line-item add or as a fold-in). We default to treating
 * the column as inclusive-of-tax (matching how Rixey configures it)
 * and surface a warning when `tax > 0` so the coordinator can confirm
 * or override.
 */

const CURRENCY_CHARS_RE = /[$€£¥,\s]/g

/**
 * Parse a currency string into integer cents.
 *
 * - "$4,500.00"       → 450000
 * - "4500"            → 450000
 * - "4,500.00"        → 450000
 * - "$4500.00 USD"    → 450000
 * - "(4,500.00)"      → -450000
 * - ""                → null
 * - "abc"             → null
 *
 * Trailing currency-code suffixes (USD / EUR / GBP / CAD / AUD) are
 * stripped before parsing.
 */
export function parseCurrency(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Math.round(value * 100)
  }
  let s = String(value).trim()
  if (!s) return null

  // Strip trailing currency code (USD / EUR / GBP / CAD / AUD).
  s = s.replace(/\s*(USD|EUR|GBP|CAD|AUD|usd|eur|gbp|cad|aud)\s*$/, '').trim()

  // Detect parenthesised negatives.
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1).trim()
  }

  // Strip currency symbols / commas / spaces.
  s = s.replace(CURRENCY_CHARS_RE, '')

  if (!s) return null

  const n = Number(s)
  if (!Number.isFinite(n)) return null

  const cents = Math.round(n * 100)
  return negative ? -cents : cents
}

export interface ParsedFinancials {
  /** weddings.booking_value — total contract value in cents. */
  total_cents: number | null
  /** weddings.tax_amount — tax portion in cents. */
  tax_cents: number | null
  /** weddings.amount_paid — already-paid portion in cents. */
  paid_cents: number | null
  /** weddings.gratuity_amount — coordinator/staff gratuity in cents. */
  gratuity_cents: number | null
  /** weddings.refunded_amount — refunded portion in cents. */
  refunded_cents: number | null
}

export const EMPTY_FINANCIALS: ParsedFinancials = {
  total_cents: null,
  tax_cents: null,
  paid_cents: null,
  gratuity_cents: null,
  refunded_cents: null,
}

export interface FinancialFieldMap {
  total?: string | null
  tax?: string | null
  paid?: string | null
  gratuity?: string | null
  refunded?: string | null
}

/**
 * Parse all five financial fields from a row, given a per-CRM mapping
 * from canonical key → raw cell value (typically the adapter has
 * already resolved column-index → cell via field-detector).
 *
 * Caller passes RAW cell values (string | null) — this primitive does
 * the currency parsing.
 */
export function parseFinancials(values: FinancialFieldMap): ParsedFinancials {
  return {
    total_cents: parseCurrency(values.total ?? null),
    tax_cents: parseCurrency(values.tax ?? null),
    paid_cents: parseCurrency(values.paid ?? null),
    gratuity_cents: parseCurrency(values.gratuity ?? null),
    refunded_cents: parseCurrency(values.refunded ?? null),
  }
}

/**
 * Format a cents value back as "$4,500.00" for display in previews /
 * error messages. Returns null for null input.
 */
export function formatCents(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return null
  if (!Number.isFinite(cents)) return null
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
