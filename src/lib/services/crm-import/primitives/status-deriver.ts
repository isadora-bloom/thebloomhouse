/**
 * Status-deriver primitive (T5-Rixey-GG / Stream GG).
 *
 * Single function that maps a CRM row's status signals into Bloom's
 * weddings.status enum, regardless of whether the source CRM exports a
 * multi-state Project Status (Dubsado / Aisle Planner) or a binary
 * Booked yes/no flag (HoneyBook).
 *
 * Why this exists
 * ---------------
 * Stream FF assumed every HoneyBook export had a `Project Status`
 * column. Real Q1 2026 Rixey export instead had a binary
 * `Booked (yes/no)` column. Inferring inquiry vs booked vs lost vs
 * completed required combining (booked_flag, project_date,
 * project_creation_date) — there's no single column. Keeping that
 * combine logic in a primitive means the next CRM with a similar
 * shape (think: legacy Salesforce orgs whose closed-won is a
 * checkbox on Opportunities) doesn't re-implement the same grid.
 *
 * The deriver takes a normalised input bag and returns a status:
 *
 *   1. Multi-state path — if `explicit_status` is provided, look it up
 *      in `aliases` (caller supplies the per-CRM alias map). Falls
 *      through to the binary path when alias lookup misses.
 *
 *   2. Binary path — when only booked_flag + dates are available:
 *        booked=true  + date_past   → 'completed'
 *        booked=true  + date_future → 'booked'
 *        booked=true  + no date     → 'booked'
 *        booked=false + date_past   → 'lost'        (couple booked elsewhere)
 *        booked=false + date_future → 'inquiry'     (still being courted)
 *        booked=false + no date     → 'inquiry'
 *        lost_flag=true             → 'lost'        (overrides booked)
 *
 *      The caller's `defaults` lets the coordinator override the
 *      booked=false + date_past case (some venues prefer to mark those
 *      'cancelled' instead of 'lost'). This is what the pre-commit
 *      validation pass surfaces as a question.
 *
 *   3. Fallback — if nothing matched, return `null` and let the caller
 *      decide whether to default to 'inquiry' or to surface a warning.
 */

import type { NormalisedLeadRow } from '../index'

export type WeddingStatus = NonNullable<NormalisedLeadRow['status']>

export interface StatusInput {
  /** Free-text status from the CRM (e.g. "In Progress", "Booked"). */
  explicit_status?: string | null

  /** Binary booked flag — true / false / null. HoneyBook ships this. */
  booked_flag?: boolean | null

  /** ISO date the wedding is scheduled for, if known. */
  project_date?: string | null

  /** Some CRMs (Dubsado) ship a separate lost flag. Wins over booked. */
  lost_flag?: boolean | null

  /** Some CRMs (Aisle Planner) ship a "cancelled" / "archived" flag. */
  cancelled_flag?: boolean | null

  /** Last-activity timestamp; reserved for future use. */
  last_activity?: string | null
}

export interface StatusDefaults {
  /** What to map booked=false + date_past to. Default: 'lost'. */
  unbooked_past: WeddingStatus
  /** What to map booked=false + date_future to. Default: 'inquiry'. */
  unbooked_future: WeddingStatus
  /** Default when nothing matches. */
  fallback: WeddingStatus
}

export const DEFAULT_STATUS_DEFAULTS: StatusDefaults = {
  unbooked_past: 'lost',
  unbooked_future: 'inquiry',
  fallback: 'inquiry',
}

/**
 * Default alias map for multi-state CRMs. Adapters can extend with
 * provider-specific terms (e.g. Aisle Planner's "On Hold").
 */
export const DEFAULT_STATUS_ALIASES: Record<string, WeddingStatus> = {
  'inquiry': 'inquiry',
  'new': 'inquiry',
  'lead': 'inquiry',
  'in progress': 'inquiry',
  'tour scheduled': 'tour_scheduled',
  'tour_scheduled': 'tour_scheduled',
  'tour completed': 'tour_completed',
  'tour_completed': 'tour_completed',
  'proposal': 'proposal_sent',
  'proposal sent': 'proposal_sent',
  'proposal_sent': 'proposal_sent',
  'booked': 'booked',
  'contracted': 'booked',
  'signed contract': 'booked',
  'signed_contract': 'booked',
  'active': 'booked',
  'won': 'booked',
  'closed-won': 'booked',
  'closed_won': 'booked',
  'paid': 'booked',
  'completed': 'completed',
  'done': 'completed',
  'cancelled': 'cancelled',
  'canceled': 'cancelled',
  'lost': 'lost',
  'closed lost': 'lost',
  'closed-lost': 'lost',
  'closed_lost': 'lost',
  'archived': 'lost',
}

function isPastDate(iso: string | null | undefined, now: Date = new Date()): boolean {
  if (!iso) return false
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return false
  // Compare on day boundary to be lenient — a wedding scheduled today is
  // not "past" until tomorrow.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return d.getTime() < today.getTime()
}

/**
 * Derive a Bloom weddings.status from whatever signals the CRM gave us.
 *
 * Caller supplies `aliases` so a per-CRM mapping (e.g. Aisle Planner's
 * "On Hold" → 'inquiry' with a hold note) can override the default.
 *
 * Returns `null` only when explicit_status was provided AND alias lookup
 * missed AND no other signals were available — caller should treat that
 * as "unknown CRM status, surface a warning".
 */
export function deriveStatus(
  input: StatusInput,
  aliases: Record<string, WeddingStatus> = DEFAULT_STATUS_ALIASES,
  defaults: StatusDefaults = DEFAULT_STATUS_DEFAULTS,
): WeddingStatus | null {
  // (1) lost / cancelled flags win — coordinator already decided.
  if (input.lost_flag === true) return 'lost'
  if (input.cancelled_flag === true) return 'cancelled'

  // (2) Multi-state path — explicit status from the CRM.
  if (input.explicit_status) {
    const key = input.explicit_status.trim().toLowerCase()
    if (key && aliases[key]) return aliases[key]!
    // Don't fall through here — explicit-status-provided-but-not-matched
    // is an "unknown CRM status" signal the caller should warn about.
    // BUT we still try the binary path below if booked_flag exists, since
    // a CRM might ship both ("In Progress" + booked=true).
    if (input.booked_flag === undefined || input.booked_flag === null) {
      return null
    }
  }

  // (3) Binary path — booked yes/no + date.
  if (input.booked_flag === true) {
    if (input.project_date && isPastDate(input.project_date)) return 'completed'
    return 'booked'
  }
  if (input.booked_flag === false) {
    if (input.project_date && isPastDate(input.project_date)) return defaults.unbooked_past
    return defaults.unbooked_future
  }

  // (4) Nothing matched.
  return defaults.fallback
}

/**
 * Convenience helper: when an adapter wants to surface the
 * unknown-explicit-status case as a user-facing warning string.
 */
export function describeStatusGap(input: StatusInput): string | null {
  if (!input.explicit_status) return null
  const key = input.explicit_status.trim().toLowerCase()
  if (!key) return null
  if (DEFAULT_STATUS_ALIASES[key]) return null
  return `unknown CRM status '${input.explicit_status}' — defaulting via booked-flag rules`
}
