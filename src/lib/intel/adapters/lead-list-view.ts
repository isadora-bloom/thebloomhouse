/**
 * Last-activity overlay — the one merge both `/agent/leads` and
 * `/agent/pipeline` use to answer "when did this couple last do
 * anything".
 *
 * Why an adapter and not page code: both pages used to derive this
 * themselves, from `interactions.timestamp` (itself a fix for an older
 * bug — `weddings.updated_at` is bumped by every batch import, so sorting
 * by it showed every lead as active today). `/api/intel/canonical/
 * daily-list` now answers it once from the spine (`couples` +
 * `touchpoints`, resolved back to a legacy wedding id through
 * `couples.source_wedding_id`) and hands back a `{ [weddingId]: isoString
 * }` map. This file is the ONE place that overlays that map onto a
 * wedding-keyed row, so if the two pages ever again show different "last
 * activity" values for the same couple it is because they were handed
 * different maps, not because they merged differently.
 *
 * Pure. Unit-tested in ./__tests__/lead-list-view.test.ts.
 */

export interface WeddingKeyedRow {
  id: string
}

/**
 * Overlays the spine's last-activity map (from `useCanonicalDaily` /
 * `/api/intel/canonical/daily-list`) onto any wedding-keyed row list,
 * adding `last_activity_at`. A row with no entry in the map gets `null`
 * — "no recorded touchpoint on the spine yet", never a guessed date.
 */
export function withLastActivity<T extends WeddingKeyedRow>(
  rows: T[],
  lastActivityByWedding: Record<string, string>,
): (T & { last_activity_at: string | null })[] {
  return rows.map((row) => ({
    ...row,
    last_activity_at: lastActivityByWedding[row.id] ?? null,
  }))
}
