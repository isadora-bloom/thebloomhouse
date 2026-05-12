/**
 * Picker functions for evidence-projection columns on `weddings`.
 *
 * Companion to migration 317. Three append-only evidence logs:
 *   - weddings.source_evidence       -> projected to weddings.source
 *   - weddings.inquiry_date_evidence -> projected to weddings.inquiry_date
 *   - weddings.guest_count_evidence  -> projected to weddings.guest_count_estimate
 *
 * The picker functions are PURE. Given an evidence array (and, optionally,
 * the locked-projection value from the lock column), they return the
 * canonical picked value. They never touch the database; they never
 * mutate input arrays.
 *
 * Picker rules, applied in order:
 *
 *   1. If the field is locked-by-operator, the lockedValue (most recent
 *      operator_override evidence row's value) wins, regardless of
 *      fresher higher-confidence inferences. This is the Sticky-state
 *      Pattern 1 invariant: operator intent is sovereign.
 *
 *   2. Otherwise, scan the evidence array and pick the entry with the
 *      highest confidence whose value is non-null and shape-valid. Break
 *      ties by recency (latest captured_at wins).
 *
 *   3. If no acceptable evidence exists, return null.
 *
 * Forensic invariant: a 'rejected' or invalid value still stays in the
 * evidence array (Constitution: never delete). The picker simply
 * filters them out at read time.
 *
 * Mirrors the picker pattern from people.name_evidence (mig 255). The
 * name picker is embedded in name-upgrade.ts (`pickBestCandidate`); this
 * file generalises the pattern for the simpler scalar fields (no
 * prefix-merge logic, no per-field upgrade rules; just pick-highest-
 * confidence-then-recency).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Shared evidence row shape (mirrors mig 306 wedding_date_evidence + mig 317)
// ---------------------------------------------------------------------------

export interface EvidenceEntry<TValue = unknown> {
  source: string
  value: TValue
  confidence: number
  captured_at: string
  interaction_id?: string | null
  actor_id?: string | null
}

// ---------------------------------------------------------------------------
// Internal: rank + select
// ---------------------------------------------------------------------------

/** Return ms epoch for sorting; treat unparseable as 0 so they lose to
 *  any well-formed timestamp. */
function capturedAtMs(entry: EvidenceEntry): number {
  const t = entry.captured_at
  if (!t) return 0
  const n = Date.parse(t)
  return Number.isFinite(n) ? n : 0
}

/** Pick the highest-confidence valid entry; break ties by recency.
 *  validate(value) filters entries whose value shape is unusable. */
function pickHighestConfidence<T>(
  evidence: EvidenceEntry<T>[],
  validate: (value: T | null | undefined) => boolean,
): EvidenceEntry<T> | null {
  let best: EvidenceEntry<T> | null = null
  for (const e of evidence) {
    if (!e || typeof e !== 'object') continue
    if (typeof e.confidence !== 'number') continue
    if (!validate(e.value)) continue
    if (!best) {
      best = e
      continue
    }
    if (e.confidence > best.confidence) {
      best = e
      continue
    }
    if (e.confidence === best.confidence && capturedAtMs(e) > capturedAtMs(best)) {
      best = e
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// pickSource
// ---------------------------------------------------------------------------

/**
 * Pick the canonical source for a wedding from its source_evidence log.
 *
 * @param evidence    Append-only log of every source claim ever observed.
 * @param lockedValue When the wedding's source_locked_by_operator=true,
 *                    pass the locked value (typically read from
 *                    weddings.source itself, which the operator-stamp
 *                    path keeps in sync with the locked evidence row).
 *                    Pass null/undefined when not locked.
 *
 * @returns The picked source string, or null when no acceptable evidence.
 */
export function pickSource(
  evidence: EvidenceEntry<string | null>[] | null | undefined,
  lockedValue?: string | null,
): string | null {
  if (lockedValue) return lockedValue
  if (!Array.isArray(evidence) || evidence.length === 0) return null
  const best = pickHighestConfidence<string | null>(
    evidence,
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  )
  return best ? (best.value as string).trim() : null
}

// ---------------------------------------------------------------------------
// pickInquiryDate
// ---------------------------------------------------------------------------

/** Loose ISO-8601 / RFC-3339 detector. Accepts YYYY-MM-DD and full
 *  datetime forms. Rejects empty / NaN / mis-shaped values. */
function isUsableIsoDate(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const t = v.trim()
  if (t.length < 10) return false
  const ms = Date.parse(t)
  return Number.isFinite(ms)
}

/**
 * Pick the canonical inquiry_date for a wedding from its
 * inquiry_date_evidence log.
 *
 * @returns ISO-8601 string when picked; null otherwise.
 */
export function pickInquiryDate(
  evidence: EvidenceEntry<string | null>[] | null | undefined,
  lockedValue?: string | null,
): string | null {
  if (lockedValue && isUsableIsoDate(lockedValue)) return lockedValue
  if (!Array.isArray(evidence) || evidence.length === 0) return null
  const best = pickHighestConfidence<string | null>(evidence, isUsableIsoDate)
  return best ? (best.value as string) : null
}

// ---------------------------------------------------------------------------
// pickGuestCount
// ---------------------------------------------------------------------------

/** Sane band for guest counts. Anything outside is treated as an
 *  unreliable signal (typo, OCR fail, parser bug). Stays in the
 *  evidence log for audit but the picker ignores it. */
const GUEST_COUNT_MIN = 1
const GUEST_COUNT_MAX = 1000

function isUsableGuestCount(v: unknown): v is number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Number.isInteger(v) && v >= GUEST_COUNT_MIN && v <= GUEST_COUNT_MAX
  }
  // Some upstream writers stringify numbers ("125"). Accept those when
  // they parse cleanly.
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v.trim())
    return (
      Number.isFinite(n) &&
      Number.isInteger(n) &&
      n >= GUEST_COUNT_MIN &&
      n <= GUEST_COUNT_MAX
    )
  }
  return false
}

/**
 * Pick the canonical guest_count for a wedding from its
 * guest_count_evidence log.
 *
 * @returns Integer guest count in [1..1000]; null otherwise.
 */
export function pickGuestCount(
  evidence: EvidenceEntry<number | string | null>[] | null | undefined,
  lockedValue?: number | null,
): number | null {
  if (typeof lockedValue === 'number' && isUsableGuestCount(lockedValue)) {
    return lockedValue
  }
  if (!Array.isArray(evidence) || evidence.length === 0) return null
  const best = pickHighestConfidence<number | string | null>(
    evidence,
    isUsableGuestCount,
  )
  if (!best) return null
  const v = best.value
  return typeof v === 'number' ? v : Number((v as string).trim())
}

// ---------------------------------------------------------------------------
// appendEvidence
// ---------------------------------------------------------------------------
//
// The naive `select-current + update-with-array` pattern races: two
// concurrent writers each read the same starting array, each append
// their own entry, each write back; the second write clobbers the first.
//
// Postgres has no native `jsonb_array_append` for a column in one
// statement that does not first read it, but we can express the
// concatenation inside the UPDATE itself using the existing column
// value: `<column> = <column> || $1::jsonb`. That makes the write
// atomic at the row level: the row lock the UPDATE acquires
// serializes concurrent appends, so no read-modify-write race exists.
//
// supabase-js does not let us send a raw SQL expression in `update()`,
// so the simplest portable path today is read-modify-write inside this
// helper. The operator-stamp surface is rare (one click per minute at
// most) so the race is acceptable. The pipeline writers also rarely
// concurrent-write to the SAME wedding row.
//
// Follow-up if contention becomes real: add a migration with
// `CREATE OR REPLACE FUNCTION append_evidence_row(table text, id uuid,
// column text, entry jsonb) RETURNS void` that does
// `EXECUTE 'UPDATE %I SET %I = %I || $1 WHERE id = $2' ...`. Then
// flip this helper to call it via `supabase.rpc`.

type EvidenceTable = 'weddings' | 'people'
type EvidenceColumn =
  | 'source_evidence'
  | 'inquiry_date_evidence'
  | 'guest_count_evidence'
  | 'wedding_date_evidence'
  | 'name_evidence'

/**
 * Append a single evidence entry to an evidence-projection column.
 *
 * Read-modify-write under the hood. Acceptable for low-contention
 * surfaces (operator clicks, sequential pipeline writes per wedding).
 * For hot per-row concurrency, swap to a server-side function (see
 * comment above).
 */
export async function appendEvidence<T = unknown>(
  supabase: SupabaseClient,
  table: EvidenceTable,
  id: string,
  column: EvidenceColumn,
  entry: EvidenceEntry<T>,
): Promise<void> {
  // Read current array.
  const { data: row, error: readErr } = await supabase
    .from(table)
    .select(column)
    .eq('id', id)
    .maybeSingle()
  if (readErr || !row) {
    console.warn(
      '[identity/pick-from-evidence] appendEvidence read failed',
      { table, id, column, err: readErr?.message },
    )
    return
  }
  const current = (row as Record<string, unknown>)[column]
  const arr: EvidenceEntry<T>[] = Array.isArray(current)
    ? (current as EvidenceEntry<T>[])
    : []
  const next = [...arr, entry]

  const { error: updErr } = await supabase
    .from(table)
    .update({ [column]: next })
    .eq('id', id)
  if (updErr) {
    console.warn(
      '[identity/pick-from-evidence] appendEvidence write failed',
      { table, id, column, err: updErr.message },
    )
  }
}
