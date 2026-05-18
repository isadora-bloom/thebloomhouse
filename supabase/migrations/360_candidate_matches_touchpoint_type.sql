-- ---------------------------------------------------------------------------
-- 360_candidate_matches_touchpoint_type.sql
-- ---------------------------------------------------------------------------
-- Tier 8 / T8.1c. Widen the candidate_matches record-type CHECK to
-- include 'touchpoint'.
--
-- The bug
-- -------
-- Migration 346 created candidate_matches with inline CHECKs:
--   primary_record_type   IN ('couple','fragment','channel_scoped')
--   secondary_record_type IN ('couple','fragment','channel_scoped')
-- But `route-by-tier.ts`'s medium/low branch inserts a candidate_match
-- with secondary_record_type = 'touchpoint' (the orphan touchpoint it
-- just wrote, pointing back at the matched couple). That INSERT fails
-- the CHECK constraint with a 23514 — and `insertCandidateMatch`
-- swallows every non-23505 error as a logged warning. Net effect:
-- every medium/low live match silently fails to queue. The operator
-- review queue never sees them.
--
-- `tracer.ts`'s insertCandidateMatch type signature already lists
-- 'touchpoint' as a valid record type; only the DB CHECK was stale.
--
-- The fix
-- -------
-- Drop + recreate both CHECK constraints with 'touchpoint' added.
-- Inline column checks are named <table>_<column>_check by Postgres;
-- DROP ... IF EXISTS keeps the migration rerun-safe.
-- ---------------------------------------------------------------------------

ALTER TABLE public.candidate_matches
  DROP CONSTRAINT IF EXISTS candidate_matches_primary_record_type_check;
ALTER TABLE public.candidate_matches
  ADD CONSTRAINT candidate_matches_primary_record_type_check
  CHECK (primary_record_type IN (
    'couple', 'fragment', 'channel_scoped', 'touchpoint'
  ));

ALTER TABLE public.candidate_matches
  DROP CONSTRAINT IF EXISTS candidate_matches_secondary_record_type_check;
ALTER TABLE public.candidate_matches
  ADD CONSTRAINT candidate_matches_secondary_record_type_check
  CHECK (secondary_record_type IN (
    'couple', 'fragment', 'channel_scoped', 'touchpoint'
  ));

NOTIFY pgrst, 'reload schema';
