-- ---------------------------------------------------------------------------
-- 347_identity_first_phase_e_corrections.sql
-- ---------------------------------------------------------------------------
-- Phase E corrective migration. Two real bugs found while wiring the
-- candidate-review queue + journey ribbon:
--
--   1. tracer_run_events.run_id is uuid NOT NULL. The Phase C Forwards
--      Linker tried to write structured run_ids like 'live:abc12345:2026-05-14'
--      so the dashboard could aggregate per-day live activity. Those
--      inserts silently failed (linker swallowed the 22P02 invalid-uuid
--      error). Switching the column to text accepts both: existing
--      Phase B Tracer rows keep their uuids, new linker rows get a
--      structured key.
--
--   2. candidate_matches.secondary_record_type CHECK was
--      ('couple','fragment','channel_scoped'). The Tracer + Linker
--      route below-high matches as ORPHAN TOUCHPOINTS (couple_id NULL)
--      and reference them in candidate_matches. The schema rejected
--      a record_type of 'touchpoint', so we mislabeled them as
--      'fragment' — meaning the resolve endpoint couldn't find them
--      by id in the fragments table. Widen the CHECK to include
--      'touchpoint' on both primary + secondary columns so the
--      candidate-review queue can cascade correctly.
--
-- Rerun safety: every change uses DROP CONSTRAINT IF EXISTS + ADD
-- CONSTRAINT, and the column type change is idempotent (NOOP when
-- already text). Migration is safe to run multiple times.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. tracer_run_events.run_id: uuid → text
-- ===========================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tracer_run_events'
      AND column_name = 'run_id'
      AND data_type = 'uuid'
  ) THEN
    ALTER TABLE public.tracer_run_events
      ALTER COLUMN run_id TYPE text USING run_id::text;
  END IF;
END $$;


-- ===========================================================================
-- 2. candidate_matches.{primary,secondary}_record_type: add 'touchpoint'
-- ===========================================================================

ALTER TABLE public.candidate_matches
  DROP CONSTRAINT IF EXISTS candidate_matches_primary_record_type_check;
ALTER TABLE public.candidate_matches
  ADD CONSTRAINT candidate_matches_primary_record_type_check
  CHECK (primary_record_type IN ('couple','fragment','channel_scoped','touchpoint'));

ALTER TABLE public.candidate_matches
  DROP CONSTRAINT IF EXISTS candidate_matches_secondary_record_type_check;
ALTER TABLE public.candidate_matches
  ADD CONSTRAINT candidate_matches_secondary_record_type_check
  CHECK (secondary_record_type IN ('couple','fragment','channel_scoped','touchpoint'));


-- ===========================================================================
-- 3. Backfill: rewrite candidate_matches rows that referenced touchpoints
--    via the 'fragment' label. We detect by checking whether the
--    secondary_record_id resolves in touchpoints (not fragments).
-- ===========================================================================

UPDATE public.candidate_matches cm
SET secondary_record_type = 'touchpoint'
WHERE cm.secondary_record_type = 'fragment'
  AND EXISTS (SELECT 1 FROM public.touchpoints tp WHERE tp.id = cm.secondary_record_id);

UPDATE public.candidate_matches cm
SET primary_record_type = 'touchpoint'
WHERE cm.primary_record_type = 'fragment'
  AND EXISTS (SELECT 1 FROM public.touchpoints tp WHERE tp.id = cm.primary_record_id);
