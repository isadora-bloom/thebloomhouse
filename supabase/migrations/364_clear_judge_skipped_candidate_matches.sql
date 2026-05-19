-- ---------------------------------------------------------------------------
-- 364_clear_judge_skipped_candidate_matches.sql
-- ---------------------------------------------------------------------------
-- Clears candidate_matches that the matcher proposed but the LLM judge
-- never actually adjudicated, because the judge budget was exhausted
-- (a historical backfill run with judge_budget=0, or a long run that
-- hit the per-day cap). Their matcher_reason ends with
-- "judge skipped (budget run)".
--
-- These are degraded-run artifacts, not real review items — they
-- flooded the operator's identity-review queue with hundreds of weak
-- name-only guesses that were never judged. A normal judge-on Tracer
-- run re-proposes the same signals and adjudicates them properly; the
-- ones the judge confirms/rejects never become a candidate_match at
-- all. So these rows are safe to drop.
--
-- Idempotent. The touchpoints behind each proposal are untouched —
-- only the un-adjudicated proposal row is removed. Venue-agnostic.
-- ---------------------------------------------------------------------------

DELETE FROM public.candidate_matches
WHERE resolution IS NULL
  AND matcher_reason LIKE '%judge skipped (budget run)%';

NOTIFY pgrst, 'reload schema';
