/**
 * Cohort signature helper — single source of truth for the discrete
 * bucket key used by cohort_damping_cache (migration 319).
 *
 * Both the SQL view (wedding_heat in mig 319) and the TS cohort-damping
 * refresh cron (cohort-damping-refresh.ts) emit the SAME signature
 * string for the same wedding. If they drift, the LEFT JOIN in the
 * view silently misses every row and every wedding falls back to
 * multiplier=1.0 — no error, just silent loss of damping.
 *
 * Signature shape: 'src=<source>;gc=<bin50>;season=<spring|summer|fall|winter|unknown>'
 *
 * Buckets:
 *   - source: raw value from weddings.source, or 'unknown' when null
 *   - gc: (guest_count_estimate / 50) * 50 — integer 50-bins (0, 50, 100, ...).
 *     'unknown' when guest_count_estimate is null.
 *   - season: spring (Mar-May), summer (Jun-Aug), fall (Sep-Nov),
 *     winter (Dec-Feb), 'unknown' when wedding_date is null.
 *
 * Keep this in lockstep with the SQL expression inside the engagement_sum
 * CTE of migration 319_cohort_damping_cache.sql. Any change to one
 * MUST be reflected in the other in the SAME migration / commit.
 */

export interface CohortSignatureInputs {
  source: string | null
  guest_count_estimate: number | null
  wedding_date: string | null
}

/**
 * Mirrors the SQL CASE expression that maps months 3-5 / 6-8 / 9-11 /
 * 12,1,2 / null. Exported so the refresh job's enumeration loop and the
 * SQL view stay in lockstep. Null wedding_date → 'unknown'.
 */
export function deriveCohortSeason(
  weddingDate: string | null,
): 'spring' | 'summer' | 'fall' | 'winter' | 'unknown' {
  if (!weddingDate) return 'unknown'
  const m = Number(weddingDate.slice(5, 7))
  if (!Number.isFinite(m) || m < 1 || m > 12) return 'unknown'
  if (m >= 3 && m <= 5) return 'spring'
  if (m >= 6 && m <= 8) return 'summer'
  if (m >= 9 && m <= 11) return 'fall'
  return 'winter'
}

/**
 * Compute the discrete cohort_signature string for a wedding row.
 * Pure function — same inputs always produce the same output. Used by
 * the refresh cron (to enumerate buckets) and by anywhere we need to
 * look up the cache row for a given wedding outside the view.
 */
export function computeCohortSignature(inputs: CohortSignatureInputs): string {
  const src = inputs.source ?? 'unknown'
  const gcBin =
    inputs.guest_count_estimate !== null && Number.isFinite(inputs.guest_count_estimate)
      ? String(Math.floor(inputs.guest_count_estimate / 50) * 50)
      : 'unknown'
  const season = deriveCohortSeason(inputs.wedding_date)
  return `src=${src};gc=${gcBin};season=${season}`
}
