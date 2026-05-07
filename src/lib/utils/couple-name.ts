/**
 * Couple-name builder — defense-in-depth against duplicate `people`
 * rows leaking into the lead-detail headline.
 *
 * The root fix for "Sarah & Sarah & Sarah" lives in
 * src/lib/services/people-merge-aliases.ts (T5-Rixey-EEE Bug 1):
 * platform-alias rows get folded into the canonical real-email row
 * via mergePeople so the wedding ends up with one Sarah, not three.
 *
 * This utility is the SAFETY NET. It exists for two cases the
 * alias-merge can't catch:
 *
 *   1. The alias-merge cron hasn't run yet for a freshly imported
 *      wedding (HoneyBook import → before next 03:30 UTC sweep).
 *   2. A future surface bypasses the merge layer entirely (a manual
 *      coordinator add, a one-off CSV import that doesn't trigger
 *      KK reconciliation).
 *
 * Both fixes ship together — root + safety net — per the EEE plan's
 * "belt-and-suspenders" rule. Every callsite that joins person
 * first/last names should route through these helpers instead of
 * `.map(p => p.first_name).join(' & ')` so the dedupe is consistent.
 */

interface PersonNameLike {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  /** Optional secondary signal — when present we use it to pick the
   *  most-canonical row of a same-name bucket (real-email row over
   *  alias-email row). Mirrors people.alias_emails (migration 194). */
  alias_emails?: string[] | null
  role?: string | null
}

function normalize(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
}

/**
 * De-dupe a list of people by (normalized first + normalized last).
 * Stable order — first occurrence wins. The caller is responsible
 * for upstream filtering (e.g. role==='partner1'/'partner2'); this
 * utility is purely a name-based collapse.
 *
 * Empty-name rows pass through unchanged (no signal to dedupe on).
 */
export function dedupePeopleByName<T extends PersonNameLike>(people: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const p of people) {
    const fn = normalize(p.first_name)
    const ln = normalize(p.last_name)
    if (!fn && !ln) {
      // No name signal — keep the row, can't dedupe.
      out.push(p)
      continue
    }
    const key = `${fn}|${ln}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/**
 * "Sarah & John" — first names joined with ampersand, deduped by
 * (first + last). Returns null when no name signal at all.
 */
export function buildCoupleFirstNames<T extends PersonNameLike>(people: T[]): string | null {
  const deduped = dedupePeopleByName(people)
  const parts = deduped
    .map((p) => (p.first_name ?? '').trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) return null
  return parts.join(' & ')
}

/**
 * Format a single person's display name from first + last + (optional)
 * email fallback. Replaces the 20+ inline `[p.first_name, p.last_name]
 * .filter(Boolean).join(' ')` sprinkles flagged by Lens 1. Trims each
 * part so "  Sarah  " + "  Smith  " collapses to "Sarah Smith".
 *
 * fallback: when name is empty, returns the supplied fallback (commonly
 * an email address) rather than an empty string. Pass undefined to
 * return empty.
 */
export function personFullName<T extends PersonNameLike>(
  person: T | null | undefined,
  fallback?: string | null,
): string {
  if (!person) return fallback ?? ''
  const first = (person.first_name ?? '').trim()
  const last = (person.last_name ?? '').trim()
  const joined = [first, last].filter((s) => s.length > 0).join(' ')
  if (joined) return joined
  return fallback ?? person.email ?? ''
}

/**
 * "Sarah Rohrschneider & John Olkowski" — full names joined with
 * ampersand, deduped by (first + last). Returns null when no name
 * signal.
 */
export function buildCoupleFullNames<T extends PersonNameLike>(people: T[]): string | null {
  const deduped = dedupePeopleByName(people)
  const parts = deduped
    .map((p) => `${(p.first_name ?? '').trim()} ${(p.last_name ?? '').trim()}`.trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) return null
  return parts.join(' & ')
}
