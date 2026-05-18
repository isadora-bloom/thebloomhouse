-- ---------------------------------------------------------------------------
-- 358_candidate_matches_pair_unique.sql
-- ---------------------------------------------------------------------------
-- Tier 8 / T8.0a — idempotency floor for the Backwards Tracer (2026-05-18).
--
-- candidate_matches shipped (migration 346) with only one index:
-- ix_candidate_matches_open_queue, a partial index for the review queue.
-- There was no uniqueness on the matched pair. insertCandidateMatch()
-- in tracer.ts already swallows error code 23505 (unique violation) —
-- but with no constraint behind it, 23505 could never fire, so every
-- Tracer rerun re-queued the same pairs. That breaks the doctrine's
-- idempotency gate (IDENTITY-FIRST-ARCHITECTURE.md Appendix B, stop #4:
-- "second run duplicates rows").
--
-- This migration:
--   1. De-duplicates any pairs already present from prior reruns,
--      keeping a resolved row over an unresolved one, then the earliest.
--   2. Adds a unique index on the matched pair so reruns no-op.
--
-- The pair key is (venue_id + both record ids + both record types).
-- Record types are included because primary_record_id / secondary_
-- record_id are bare uuids with no FK — a couple id and a fragment id
-- are drawn from independent gen_random_uuid() spaces, so the type
-- disambiguates the record the id points at.
--
-- NOT handled here: swapped-pair canonicalisation ((A,B) vs (B,A)).
-- The Tracer rerun bug is same-ordering re-insertion, which this fully
-- fixes. Canonical emit ordering is enforced at the matcher call sites
-- in T8.1, where the orchestrator owns who is primary vs secondary.
-- ---------------------------------------------------------------------------

-- 1. Collapse pre-existing duplicates. Prefer a resolved row (operator
--    already decided it); then the earliest created; id as final tie-break.
DELETE FROM public.candidate_matches cm
USING (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        venue_id,
        primary_record_id,
        primary_record_type,
        secondary_record_id,
        secondary_record_type
      ORDER BY
        (resolved_at IS NOT NULL) DESC,
        created_at ASC,
        id ASC
    ) AS rn
  FROM public.candidate_matches
) ranked
WHERE cm.id = ranked.id
  AND ranked.rn > 1;

-- 2. Uniqueness on the matched pair. insertCandidateMatch()'s existing
--    23505 swallow now makes Tracer reruns a true no-op on this table.
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidate_matches_pair
  ON public.candidate_matches (
    venue_id,
    primary_record_id,
    primary_record_type,
    secondary_record_id,
    secondary_record_type
  );

NOTIFY pgrst, 'reload schema';
