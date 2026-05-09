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
 * Is this name token a single-letter abbreviation? "B", "B.", " J. " all
 * count. The Knot's relay leaks last names as a single initial (privacy
 * trim), so a row with last_name="B" should always lose to a row with
 * last_name="Biaksangi" for the same person.
 */
function isInitialOnly(s: string | null | undefined): boolean {
  if (!s) return false
  const trimmed = s.trim().replace(/\.$/, '').trim()
  return trimmed.length === 1
}

/**
 * Score a person row's name completeness. Higher is better. The score
 * favours rows where BOTH first and last are non-initial words, then
 * length within each part. Used to pick the canonical name when a
 * wedding has two rows for the same human (Knot relay = "Jen B" vs
 * calculator submission = "Jennifer Biaksangi").
 *
 * Heuristics:
 *   +100 if last_name is more than a single initial
 *   +1 per character of last_name (caps at 30 to avoid runaway URLs)
 *   +50 if first_name is more than a single initial
 *   +1 per character of first_name (caps at 30)
 *   +5 if email is present (stable identity signal)
 *   +5 if alias_emails has been populated (means alias-merge has touched
 *      this row — generally the canonical survivor)
 *
 * Returns 0 for an empty / no-signal row. Tie-breaks fall back to
 * caller order (stable sort).
 */
function nameCompletenessScore<T extends PersonNameLike>(p: T): number {
  let score = 0
  const first = (p.first_name ?? '').trim()
  const last = (p.last_name ?? '').trim()
  if (last && !isInitialOnly(last)) score += 100
  score += Math.min(last.length, 30)
  if (first && !isInitialOnly(first)) score += 50
  score += Math.min(first.length, 30)
  if (p.email && p.email.trim().length > 0) score += 5
  if (p.alias_emails && p.alias_emails.length > 0) score += 5
  return score
}

/**
 * Build a stable bucket key for grouping people-rows that almost
 * certainly represent the same human. The first pass keys exactly so
 * "Sarah Smith" and "Sarah Lee" end up in different buckets (two
 * different humans named Sarah). The second pass — prefix-merge — then
 * folds nicknames into legal names by walking name-keyed buckets and
 * checking whether one's first name is a prefix of another's, with a
 * last-name conflict guard.
 *
 * Returns null when there's not enough signal to bucket (no first name
 * + no last name + no email).
 */
function bucketKey<T extends PersonNameLike>(p: T): string | null {
  const email = (p.email ?? '').trim().toLowerCase()
  if (email) return `email:${email}`
  const fn = normalize(p.first_name)
  const ln = normalize(p.last_name)
  if (!fn && !ln) return null
  // Single-initial last names (Knot-relay style "Jen B") are not
  // discriminating — bucket purely on first name so they collapse with
  // the same-first-name "Jennifer Biaksangi" row in the prefix-merge
  // pass below. Without this, "Jen B" → "name:jen|b" and "Jennifer
  // Biaksangi" → "name:jennifer|biaksangi", which the prefix-merge
  // refuses to fold because the keys differ on both sides.
  if (ln && !isInitialOnly(ln)) return `name:${fn}|${ln}`
  return `name:${fn}`
}

/**
 * Cluster people rows into "same-human" buckets, then pick the
 * highest-scoring row from each bucket. Returns the canonical rows in
 * the original input order (first appearance of each bucket).
 *
 * This is the function that fixes "Jen B" beating "Jennifer Biaksangi".
 * The two rows bucket together because their normalized first names
 * share a prefix, then nameCompletenessScore picks "Jennifer Biaksangi"
 * because the last name is a full word, not a single initial.
 */
export function pickCanonicalPeople<T extends PersonNameLike>(people: T[]): T[] {
  if (people.length === 0) return []
  // Two-pass bucketing. Pass 1: hash by exact bucketKey (email OR
  // normalized first). Pass 2: walk single-key buckets and merge any
  // whose keys are a name-prefix of another (handles "jen" prefix-of
  // "jennifer"). Email-keyed buckets never merge by prefix — email
  // identity is harder than name similarity.
  const buckets = new Map<string, { firstIdx: number; rows: T[] }>()
  people.forEach((p, idx) => {
    const key = bucketKey(p) ?? `__nokey:${idx}` // singletons keep separate
    const existing = buckets.get(key)
    if (existing) {
      existing.rows.push(p)
    } else {
      buckets.set(key, { firstIdx: idx, rows: [p] })
    }
  })

  // Prefix-merge name-keyed buckets only. Bucket keys come in two
  // shapes after bucketKey() above:
  //   - "name:<first>|<last>"  — full first + non-initial last
  //   - "name:<first>"         — first only (last missing or initial)
  // Walk shorter first names and try to fold them into longer ones
  // when (a) the long first name starts with the short, and (b) the
  // last names don't conflict. firstNameOf() pulls the first part
  // out of either key shape.
  function firstNameOf(key: string): string {
    const stripped = key.slice(5) // remove 'name:'
    const pipe = stripped.indexOf('|')
    return pipe >= 0 ? stripped.slice(0, pipe) : stripped
  }

  const nameKeys = [...buckets.keys()].filter((k) => k.startsWith('name:'))
  // Sort by first-name length ascending so "name:jen" gets folded
  // into "name:jennifer|biaksangi" before any other pairing tries.
  nameKeys.sort((a, b) => firstNameOf(a).length - firstNameOf(b).length)
  for (const shortKey of nameKeys) {
    const shortBucket = buckets.get(shortKey)
    if (!shortBucket) continue
    const shortFirst = firstNameOf(shortKey)
    if (shortFirst.length < 2) continue // single-letter first names too noisy
    for (const longKey of nameKeys) {
      if (longKey === shortKey) continue
      const longBucket = buckets.get(longKey)
      if (!longBucket) continue
      const longFirst = firstNameOf(longKey)
      if (longFirst.length <= shortFirst.length) continue
      if (!longFirst.startsWith(shortFirst)) continue
      // Last-name conflict guard: if BOTH buckets carry a row with a
      // non-initial last name and they don't share a prefix in either
      // direction, refuse the merge — "Jen Smith" and "Jennifer
      // Olkowski" are different humans even if one first is a prefix
      // of the other.
      const shortLasts = shortBucket.rows
        .map((r) => normalize(r.last_name))
        .filter((s) => s && !isInitialOnly(s))
      const longLasts = longBucket.rows
        .map((r) => normalize(r.last_name))
        .filter((s) => s && !isInitialOnly(s))
      if (shortLasts.length > 0 && longLasts.length > 0) {
        const overlap = shortLasts.some((s) =>
          longLasts.some((l) => s === l || l.startsWith(s) || s.startsWith(l))
        )
        if (!overlap) continue
      }
      // Merge short into long. firstIdx tracks first-appearance for
      // stable output order — pick whichever came first in the input.
      longBucket.rows.push(...shortBucket.rows)
      if (shortBucket.firstIdx < longBucket.firstIdx) {
        longBucket.firstIdx = shortBucket.firstIdx
      }
      buckets.delete(shortKey)
      break
    }
  }

  // Pick the highest-scoring row per surviving bucket.
  const winners: Array<{ row: T; firstIdx: number }> = []
  for (const { rows, firstIdx } of buckets.values()) {
    if (rows.length === 0) continue
    let best = rows[0]
    let bestScore = nameCompletenessScore(best)
    for (let i = 1; i < rows.length; i++) {
      const s = nameCompletenessScore(rows[i])
      if (s > bestScore) {
        best = rows[i]
        bestScore = s
      }
    }
    winners.push({ row: best, firstIdx })
  }
  winners.sort((a, b) => a.firstIdx - b.firstIdx)
  return winners.map((w) => w.row)
}

/**
 * De-dupe a list of people by (normalized first + normalized last).
 * Stable order — first occurrence wins. The caller is responsible
 * for upstream filtering (e.g. role==='partner1'/'partner2'); this
 * utility is purely a name-based collapse.
 *
 * As of 2026-05-09 this routes through pickCanonicalPeople so
 * callsites also benefit from the "longest name wins" rule across
 * Knot-relay nicknames vs calculator-submission legal names. The
 * function name is preserved to avoid touching ~20 import sites.
 *
 * Empty-name rows pass through unchanged (no signal to dedupe on).
 */
export function dedupePeopleByName<T extends PersonNameLike>(people: T[]): T[] {
  return pickCanonicalPeople(people)
}

/**
 * "Sarah & John" — first names joined with ampersand, deduped by
 * (first + last). Returns null when no name signal at all.
 *
 * 2026-05-09: under the hood pickCanonicalPeople collapses Knot-relay
 * "Jen" rows into the calculator-submission "Jennifer" row when both
 * point at the same human, so the headline picks the legal first name
 * rather than the relay nickname.
 */
export function buildCoupleFirstNames<T extends PersonNameLike>(people: T[]): string | null {
  const deduped = pickCanonicalPeople(people)
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
 *
 * 2026-05-09: routes through pickCanonicalPeople so the longest /
 * least-abbreviated name wins per logical-person bucket. A row
 * carrying "Jen B" loses to a row carrying "Jennifer Biaksangi" for
 * the same human.
 */
export function buildCoupleFullNames<T extends PersonNameLike>(people: T[]): string | null {
  const deduped = pickCanonicalPeople(people)
  const parts = deduped
    .map((p) => `${(p.first_name ?? '').trim()} ${(p.last_name ?? '').trim()}`.trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) return null
  return parts.join(' & ')
}
