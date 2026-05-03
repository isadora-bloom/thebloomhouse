/**
 * Branded canonical source-value type — T5-Rixey-BBB.
 *
 * Background
 * ----------
 * The platform has at minimum three notions of "first-touch source"
 * for a wedding (see audits/2026-05-T4-postlaunch/identity-cluster-
 * attribution-design.md §1):
 *
 *   - weddings.source         (legacy column; written by Stream SS Bug D
 *                              backfill + backtrace + coordinator override
 *                              + nullified by mig 187 for scheduling tools)
 *   - weddings.lead_source    (derived by 7-tier chain; cluster-derived
 *                              once USE_CLUSTER_FIRST_TOUCH cuts over)
 *   - attribution_events.source_platform WHERE is_first_touch=true
 *                             (Phase B candidate-cluster computation)
 *
 * The risk is mixing them at a call site — passing a legacy
 * weddings.source value into a context expecting the cluster-derived
 * value, or vice versa. Stream RR's `Cents` type is the precedent: a
 * branded number that erases at runtime but catches mix-ups at the
 * compiler level.
 *
 * Use this type wherever a function takes a "first-touch source" as
 * input or returns one. Cast through `asFirstTouchSource()` at the
 * canonicalisation boundary (typically right after `formatSourceLabel`
 * / `normalizeSource`); read sites that just render the value as a
 * string don't need it.
 */

declare const firstTouchSource: unique symbol

/** Canonical first-touch source key. Created by the cluster-compute
 *  service after canonicalisation; consumed by display + analytics. */
export type FirstTouchSource = string & { readonly [firstTouchSource]: never }

/** Cast a plain string to a FirstTouchSource. Caller is asserting that
 *  the value has gone through canonicalisation (formatSourceLabel /
 *  normalizeSource) and represents a real channel — not a raw legacy
 *  weddings.source value, not a touchpoint bucket. */
export function asFirstTouchSource(s: string): FirstTouchSource {
  return s as FirstTouchSource
}

/** Cast a maybe-null value safely. Returns null when the input is
 *  null/undefined/empty, otherwise brands the string. Useful at the
 *  edge of the cluster-compute service where the result is naturally
 *  optional. */
export function asMaybeFirstTouchSource(
  s: string | null | undefined,
): FirstTouchSource | null {
  if (s == null) return null
  const trimmed = s.trim()
  if (!trimmed) return null
  return trimmed as FirstTouchSource
}
