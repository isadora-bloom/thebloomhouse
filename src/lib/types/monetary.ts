/**
 * Branded monetary types — T5-Rixey-RR fix #5.
 *
 * Background: Stream NN bug #8 was that the data-import + generic-csv +
 * portal manual-create writers stored DOLLARS into cents columns,
 * producing the $51,432,396 phantom-revenue artifact. The fix was
 * mechanical (multiply by 100) but the underlying problem is that
 * `number` carries no unit information — every monetary site has to
 * remember which scale it's in.
 *
 * These branded types make the unit explicit at the type level so the
 * compiler catches mix-ups:
 *
 *   const cents = asCents(500_000)              // $5,000.00
 *   const dollars = asDollars(50)               // $50.00
 *   cents + dollars                              // ❌ type error
 *   const total = cents + dollarsToCents(dollars) // ✅
 *
 * Migration scope (per RR spec):
 *   - Database types for weddings.{booking_value, tax_amount,
 *     amount_paid, gratuity_amount, refunded_amount},
 *     marketing_spend.amount, lost_deals.lost_revenue → Cents
 *   - WRITERS in HoneyBook, web-form, Calendly, marketing_spend
 *     importers + the 10 highest-traffic monetary code paths refactor
 *     to call asCents() / dollarsToCents().
 *   - READERS at display sites use formatCents() / centsToDollars().
 *
 * Branded numbers stay assignable to plain `number` for arithmetic
 * (TypeScript erases the brand at runtime), so existing math compiles.
 * The brand is a compile-time check; runtime behavior is identical to
 * a plain number.
 */

declare const cents: unique symbol
declare const dollars: unique symbol

export type Cents = number & { readonly [cents]: never }
export type Dollars = number & { readonly [dollars]: never }

/** Cast a number to Cents. Rejects non-finite + negative values
 *  (negative monetary totals are out-of-domain — refunds are
 *  separate columns). Use for trusted callers that know the value is
 *  already in cents. */
export function asCents(n: number): Cents {
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid cents: ${n}`)
  return n as Cents
}

/** Cast a number to Dollars. Rejects non-finite + negative values. */
export function asDollars(n: number): Dollars {
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid dollars: ${n}`)
  return n as Dollars
}

/** Convert dollars to cents. Rounds to the nearest cent. */
export function dollarsToCents(d: Dollars): Cents {
  return Math.round(d * 100) as Cents
}

/** Convert cents to dollars (returns a precise float, no rounding). */
export function centsToDollars(c: Cents): Dollars {
  return (c / 100) as Dollars
}

/** Format cents as a "$X.XX" display string. Returns the dash em
 *  for null / undefined so it can be dropped straight into UI without
 *  a wrapping ternary. */
export function formatCents(c: Cents | number | null | undefined): string {
  if (c == null) return '—'
  if (!Number.isFinite(c)) return '—'
  return `$${(c / 100).toFixed(2)}`
}

/** Variant of formatCents that uses a thousands-separator + omits the
 *  trailing .00 when the value is a round dollar. Useful for big
 *  numbers in dashboards ("$45,000" rather than "$45000.00"). */
export function formatCentsCompact(c: Cents | number | null | undefined): string {
  if (c == null || !Number.isFinite(c as number)) return '—'
  const n = (c as number) / 100
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  })
  return fmt.format(n)
}

/** Sum a list of Cents (or maybe-null Cents) safely. Skips nulls. */
export function sumCents(values: Array<Cents | number | null | undefined>): Cents {
  let total = 0
  for (const v of values) {
    if (v == null) continue
    if (!Number.isFinite(v as number)) continue
    total += v as number
  }
  return total as Cents
}

/** Type guard — narrow `unknown` to a finite non-negative number that
 *  could be a Cents. Useful for trusting a database row column whose
 *  schema-side CHECK has been verified. */
export function isCents(v: unknown): v is Cents {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}
