-- ---------------------------------------------------------------------------
-- phase-e-acceptance.sql
-- ---------------------------------------------------------------------------
-- Phase E gate for the Identity-First Architecture migration.
-- Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 + §5. The operator-visible
-- surfaces (couples list, journey ribbon, candidate-match review queue,
-- merge endpoint) are now in. Phase E ships the loop that turns
-- matcher proposals into confirmed identity, with audit trail.
--
-- Four checks the gate enforces:
--
--   1. candidate_matches references resolve. Every primary_record_id /
--      secondary_record_id must point at a real row in couples,
--      fragments, or touchpoints (after migration 347 widened the
--      record_type CHECK). Pre-347 the row could mislabel a touchpoint
--      as 'fragment'; the migration backfilled both columns so this
--      check should now find zero orphans.
--
--   2. Confirmed matches cascade. For every candidate_matches row
--      with resolution='confirmed', the referenced fragment must have
--      promoted_to_couple_id set OR the referenced touchpoint must
--      have a non-null couple_id. Anything else means the resolve
--      endpoint forgot to cascade.
--
--   3. Audit trail completeness. Each confirmed candidate must have
--      a couple_merge_events row with reason LIKE 'operator_confirm:%'.
--
--   4. Migration 347 applied. tracer_run_events.run_id must be text
--      (not uuid) so the Forwards Linker's structured daily run_id
--      key can land.
--
-- How to run
-- ----------
--   \i scripts/phase-e-acceptance.sql
--
-- All blocks RAISE NOTICE with PASS / FAIL. Exit code stays 0 so all
-- four read in one shot. Sibling acceptance:
--   scripts/phase-b-acceptance.sql, scripts/phase-c-acceptance.sql.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP off
\timing on


-- ===========================================================================
-- CHECK 1: candidate_matches all reference resolvable records
-- ===========================================================================

DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM public.candidate_matches cm
  WHERE
    (cm.primary_record_type = 'couple' AND NOT EXISTS (SELECT 1 FROM public.couples WHERE id = cm.primary_record_id))
    OR (cm.primary_record_type = 'fragment' AND NOT EXISTS (SELECT 1 FROM public.fragments WHERE id = cm.primary_record_id))
    OR (cm.primary_record_type = 'touchpoint' AND NOT EXISTS (SELECT 1 FROM public.touchpoints WHERE id = cm.primary_record_id))
    OR (cm.secondary_record_type = 'couple' AND NOT EXISTS (SELECT 1 FROM public.couples WHERE id = cm.secondary_record_id))
    OR (cm.secondary_record_type = 'fragment' AND NOT EXISTS (SELECT 1 FROM public.fragments WHERE id = cm.secondary_record_id))
    OR (cm.secondary_record_type = 'touchpoint' AND NOT EXISTS (SELECT 1 FROM public.touchpoints WHERE id = cm.secondary_record_id));

  IF orphan_count = 0 THEN
    RAISE NOTICE 'CHECK 1 (candidate refs resolve): PASS — every reference resolves';
  ELSE
    RAISE WARNING 'CHECK 1 (candidate refs resolve): FAIL — % orphan references in candidate_matches', orphan_count;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 2: confirmed matches cascaded
-- ===========================================================================

DO $$
DECLARE
  total_confirmed integer;
  uncascaded integer;
BEGIN
  SELECT COUNT(*) INTO total_confirmed
  FROM public.candidate_matches
  WHERE resolution = 'confirmed';

  IF total_confirmed = 0 THEN
    RAISE NOTICE 'CHECK 2 (cascade on confirm): SKIP — no confirmed matches yet';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO uncascaded
  FROM public.candidate_matches cm
  WHERE cm.resolution = 'confirmed'
    AND (
      (cm.primary_record_type = 'fragment'
        AND EXISTS (SELECT 1 FROM public.fragments f
                    WHERE f.id = cm.primary_record_id
                      AND f.promoted_to_couple_id IS NULL))
      OR (cm.secondary_record_type = 'fragment'
        AND EXISTS (SELECT 1 FROM public.fragments f
                    WHERE f.id = cm.secondary_record_id
                      AND f.promoted_to_couple_id IS NULL))
      OR (cm.primary_record_type = 'touchpoint'
        AND EXISTS (SELECT 1 FROM public.touchpoints t
                    WHERE t.id = cm.primary_record_id
                      AND t.couple_id IS NULL))
      OR (cm.secondary_record_type = 'touchpoint'
        AND EXISTS (SELECT 1 FROM public.touchpoints t
                    WHERE t.id = cm.secondary_record_id
                      AND t.couple_id IS NULL))
    );

  IF uncascaded = 0 THEN
    RAISE NOTICE 'CHECK 2 (cascade on confirm): PASS — %/% confirmed matches all cascaded',
      total_confirmed, total_confirmed;
  ELSE
    RAISE WARNING 'CHECK 2 (cascade on confirm): FAIL — % of % confirmed matches did not cascade their fragment/touchpoint',
      uncascaded, total_confirmed;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 3: audit trail on confirms
-- ===========================================================================

DO $$
DECLARE
  total_confirmed integer;
  audit_rows integer;
BEGIN
  SELECT COUNT(*) INTO total_confirmed
  FROM public.candidate_matches
  WHERE resolution = 'confirmed';

  IF total_confirmed = 0 THEN
    RAISE NOTICE 'CHECK 3 (audit trail): SKIP — no confirmed matches yet';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO audit_rows
  FROM public.couple_merge_events
  WHERE reason LIKE 'operator_confirm:%';

  IF audit_rows >= total_confirmed THEN
    RAISE NOTICE 'CHECK 3 (audit trail): PASS — % operator_confirm audit rows for % confirmed matches',
      audit_rows, total_confirmed;
  ELSE
    RAISE WARNING 'CHECK 3 (audit trail): FAIL — only % audit rows for % confirmed matches',
      audit_rows, total_confirmed;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 4: migration 347 applied (tracer_run_events.run_id is text)
-- ===========================================================================

DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'tracer_run_events'
    AND column_name = 'run_id';

  IF col_type = 'text' THEN
    RAISE NOTICE 'CHECK 4 (migration 347): PASS — tracer_run_events.run_id is text';
  ELSIF col_type = 'uuid' THEN
    RAISE WARNING 'CHECK 4 (migration 347): FAIL — tracer_run_events.run_id is still uuid; apply migration 347 to enable Phase C linker telemetry';
  ELSE
    RAISE WARNING 'CHECK 4 (migration 347): FAIL — tracer_run_events.run_id type=%, expected text', col_type;
  END IF;
END $$;


\echo Phase E acceptance complete. Review NOTICE / WARNING lines above.
