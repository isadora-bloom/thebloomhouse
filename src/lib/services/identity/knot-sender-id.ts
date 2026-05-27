/**
 * Knot sender-ID extractor.
 *
 * Operator-reported bug (2026-05-27): The Knot sends 3+ separate emails
 * per inquiry, each landing in its own Gmail thread but sharing a
 * stable per-prospect identifier inside the From address:
 *
 *   1. "<firstname>.<lastname>.<seq>.<personId>@member.theknot.com"
 *        — initial "X sent you a new message"
 *   2. "<firstname>.<lastname>.<seq>.<personId>.reminder@member.theknot.com"
 *        — "X is waiting to hear back from you!"
 *   3. Sometimes a third follow-up nudge
 *
 * Each address is a different string at the email level, so the legacy
 * resolver (email_exact / email_canonical) mints a fresh person row for
 * the reminder and the pipeline drafts a duplicate Sage reply — the
 * operator sees their inbox flooded with multiple replies to what is
 * one prospect contacting them through one channel.
 *
 * The personId (the trailing numeric token before the optional
 * `.reminder` suffix) is the per-prospect KEY. Two addresses that share
 * it MUST resolve to the same person. This file is the single source of
 * truth for that extraction. Anywhere in the codebase that needs to
 * "are these two Knot relays the same prospect?" should call
 * `extractKnotPersonId` on both sides and compare the strings.
 *
 * Doctrine fit:
 *   - `[[bloom-identity-first-doctrine]]` — the couple is the unit; a
 *     stable per-prospect identifier on a platform relay IS identity
 *     evidence at the same tier as an exact email match.
 *   - `bloom-identity-resolution-doctrine.md` (Step 5, mintPerson) —
 *     deterministic identifiers run before fuzzy scoring. Knot personId
 *     joins the email_exact / phone_exact tier of the cascade.
 *   - `people-merge-aliases.ts` already collapses Knot-relay people rows
 *     into a real-email canonical post-hoc; this helper closes the gap
 *     by giving the cascade the same signal at MATCH-time, so the
 *     duplicate person/draft is never created in the first place.
 *
 * Multi-venue safe — no Rixey-specific clauses. Applies to every venue
 * that receives Knot member-inbox notifications.
 */

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

/**
 * Capture groups:
 *   [1] full localpart-prefix (`<firstname>.<lastname>.<seq>.<personId>`)
 *   [2] trailing numeric personId — the canonical per-prospect identifier
 *   [3] optional `.reminder` suffix (present on reminder/nudge variants)
 *
 * The first/last/seq tokens are captured opaquely (no name semantics) so
 * the pattern survives unusual Knot localparts (hyphenated names,
 * multiple sequence digits, etc.). The strict suffix `@member.theknot.com`
 * means we never accidentally fire on a bareword `@theknot.com` shared
 * relay (`leads@theknot.com`), which would collide across prospects.
 */
const KNOT_RELAY_RE =
  /^([a-z0-9][a-z0-9._-]*\.[a-z0-9._-]+\.\d+\.(\d+))(\.reminder)?@member\.theknot\.com$/i

/** The platform-alias domain we recognise. Other Knot domains
 *  (`leads@theknot.com`, `theknotww.com`, etc.) are NOT covered — those
 *  are shared relays that would collapse different prospects under one
 *  ID, the opposite of what we want. */
export const KNOT_RELAY_DOMAIN = 'member.theknot.com'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the canonical per-prospect personId from a Knot member-inbox
 * relay address. Returns null for everything that isn't a recognised
 * per-prospect Knot relay.
 *
 * Idempotent + pure. Safe to call on garbage strings.
 *
 * Examples:
 *   "tara.simpson.2.772357@member.theknot.com"          → "772357"
 *   "tara.simpson.2.772357.reminder@member.theknot.com" → "772357"
 *   "noreply@theknot.com"                               → null
 *   "leads@theknot.com"                                 → null
 *   "tim@bloggs.com"                                    → null
 *   ""                                                  → null
 *   null / undefined                                    → null
 */
export function extractKnotPersonId(
  fromEmail: string | null | undefined,
): string | null {
  if (!fromEmail) return null
  const trimmed = fromEmail.trim().toLowerCase()
  if (!trimmed) return null
  const m = KNOT_RELAY_RE.exec(trimmed)
  if (!m) return null
  return m[2] ?? null
}

/**
 * Collect every distinct Knot personId visible across a list of emails.
 * Used by the identity-cascade stage to map a candidate person's
 * `email` + `aliasEmails` to the set of personIds it has ever been seen
 * under. Returns an empty set when none of the inputs are Knot relays.
 */
export function knotPersonIdsFromEmails(
  emails: ReadonlyArray<string | null | undefined>,
): Set<string> {
  const ids = new Set<string>()
  for (const e of emails) {
    const id = extractKnotPersonId(e)
    if (id) ids.add(id)
  }
  return ids
}
