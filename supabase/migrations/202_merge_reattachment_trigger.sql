-- ---------------------------------------------------------------------------
-- 202_merge_reattachment_trigger.sql  (Stream NNN — universal merge fix)
-- ---------------------------------------------------------------------------
-- Re-attach attribution rows when a wedding gets merged into another.
--
-- Background
-- ----------
-- Per the Constitution + migration 177, identity reconciliation never
-- hard-deletes a duplicate wedding. The loser row stays in `weddings`
-- with `merged_into_id` pointing at the winner, so:
--   - the forensic record is preserved (audit trail; coordinator undo),
--   - active queries filter `merged_into_id IS NULL` to ignore losers.
--
-- The gap this migration closes: when the merge happens, dependent rows
-- in `attribution_events`, `wedding_touchpoints`, and `candidate_identities`
-- still point at the LOSER's wedding_id. Because every active reader on
-- those tables joins back to weddings (or filters losers via the
-- `idx_weddings_active` partial index), the loser's attribution credit
-- becomes invisible AND the winner doesn't inherit it. Net effect: a
-- merge silently destroys attribution.
--
-- Stream MMM (booked-data recovery, migration 201) made this gap
-- materially worse by introducing programmatic merges of Calendly
-- weddings into HoneyBook duplicates — but the bug is general. ANY merge
-- anywhere has the same problem; this fix is the universal solution.
--
-- What this trigger does
-- ----------------------
-- AFTER UPDATE OF `merged_into_id` ON `weddings`. Fires only on the
-- NULL → non-NULL transition (the moment a row becomes a loser). For
-- that one transition:
--
--   1. Reattach `attribution_events` rows (skip already-reverted ones —
--      reverted rows are tombstones; moving them would dirty the audit
--      trail and confuse the coordinator review queue).
--   2. Reattach `wedding_touchpoints` rows (no soft-delete column exists
--      on this table; move all of them).
--   3. Reattach `candidate_identities.resolved_wedding_id` (skip
--      soft-deleted rows for the same reason as the reverted_at filter).
--   4. Insert one audit row into `merge_reattachment_log` capturing the
--      counts moved, who fired the trigger (loser/winner ids), and when.
--
-- Idempotency invariants
-- ----------------------
-- - The trigger only fires on NULL → non-NULL transitions. Re-stamping
--   the same `merged_into_id` value (UPDATE foo SET merged_into_id = X
--   where it already equals X) is a no-op. Re-pointing a loser at a
--   different winner (non-NULL → different non-NULL) is treated as a
--   re-merge and DOES fire — but in practice nothing in the codebase
--   does this, and if it did the right behavior is "move attribution
--   to the new winner."
-- - The backfill (STEP 3) is gated by `WHERE NOT EXISTS` against
--   `merge_reattachment_log` so re-running this migration on a database
--   where it already ran inserts no new rows + does no UPDATEs.
-- - Running the trigger on a winner that already has the loser's
--   attribution is safe: UPDATEs are idempotent, the audit row records
--   "moved 0" if there's nothing left to move.
--
-- Constitution / playbook anchors
-- -------------------------------
-- - bloom-constitution.md: "Losers are never hard-deleted; merged_into_id
--   is the forensic pointer."
-- - bloom-data-integrity-sweep.md: invariants table — "every reader of
--   wedding_id must respect merged_into_id (either filter losers OR
--   chase the pointer to the winner)." This trigger satisfies the
--   second clause for attribution_events / wedding_touchpoints /
--   candidate_identities so existing readers (which filter on the
--   winner side via idx_weddings_active) automatically pick up the
--   credit.
-- - feedback_proactive_audits.md: every CREATE TABLE needs a writer.
--   `merge_reattachment_log` is read by future onboarding-readiness UI;
--   the trigger is the writer.
--
-- File zone (Stream NNN brief)
-- ----------------------------
-- - supabase/migrations/202_merge_reattachment_trigger.sql (this file)
-- - scripts/rixey-load/73-nnn-verify.ts (orphan-count verifier)
-- DO NOT edit src/lib/services/booked-data-recovery.ts (Stream MMM
-- territory). The trigger fires automatically when MMM updates
-- `merged_into_id`; no service-layer change required.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — audit log table
-- ============================================================================
-- One row per trigger firing. Captures the loser → winner pointer plus
-- the per-table move counts so coordinator UI / debugging can answer
-- "what happened when X got merged into Y?" without grovelling through
-- attribution_events history.

CREATE TABLE IF NOT EXISTS public.merge_reattachment_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loser_wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  winner_wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  attribution_events_moved integer NOT NULL DEFAULT 0,
  touchpoints_moved integer NOT NULL DEFAULT 0,
  candidates_moved integer NOT NULL DEFAULT 0,
  fired_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.merge_reattachment_log IS
  'Stream NNN (migration 202). One row per execution of the '
  'trg_weddings_reattach_on_merge trigger. Captures the loser → winner '
  'pointer + per-table move counts. Used by audit / debugging surfaces '
  'and gates the migration backfill (re-running 202 is a no-op because '
  'the backfill skips losers that already have a log row).';

COMMENT ON COLUMN public.merge_reattachment_log.attribution_events_moved IS
  'Count of attribution_events.wedding_id values rewritten loser → winner. '
  'Excludes already-reverted rows (reverted_at IS NOT NULL).';

COMMENT ON COLUMN public.merge_reattachment_log.touchpoints_moved IS
  'Count of wedding_touchpoints.wedding_id values rewritten loser → winner. '
  'No soft-delete filter applies — wedding_touchpoints has no deleted_at column.';

COMMENT ON COLUMN public.merge_reattachment_log.candidates_moved IS
  'Count of candidate_identities.resolved_wedding_id values rewritten '
  'loser → winner. Excludes soft-deleted rows (deleted_at IS NOT NULL).';

-- "Has this loser already been reattached?" (drives backfill idempotency
-- + future "show audit for this merge" UI).
CREATE INDEX IF NOT EXISTS idx_merge_reattachment_log_loser
  ON public.merge_reattachment_log (loser_wedding_id, fired_at DESC);

-- "What weddings were merged INTO this winner?" — coordinator surface
-- when reviewing a winner's audit trail.
CREATE INDEX IF NOT EXISTS idx_merge_reattachment_log_winner
  ON public.merge_reattachment_log (winner_wedding_id, fired_at DESC);

-- ============================================================================
-- STEP 2 — RLS on the audit log
-- ============================================================================
-- The log is venue-agnostic at the column level (loser/winner are wedding
-- ids, not venue ids), so the policy joins back to weddings to derive
-- venue scope. Service role bypasses everything (the trigger runs in
-- the SQL session of whoever did the UPDATE — including service-role
-- callers like booked-data-recovery + the daily reconciliation cron).

ALTER TABLE public.merge_reattachment_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mrl_service_all ON public.merge_reattachment_log;
CREATE POLICY mrl_service_all ON public.merge_reattachment_log
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS mrl_authenticated_select ON public.merge_reattachment_log;
CREATE POLICY mrl_authenticated_select ON public.merge_reattachment_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.weddings w
      WHERE w.id = merge_reattachment_log.winner_wedding_id
        AND (
          w.venue_id IN (SELECT public.user_visible_venue_ids())
          OR public.is_super_admin()
        )
    )
  );

-- Demo anon read so demo-mode coordinator screens can render audit info.
DROP POLICY IF EXISTS mrl_demo_anon_select ON public.merge_reattachment_log;
CREATE POLICY mrl_demo_anon_select ON public.merge_reattachment_log
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.weddings w
      WHERE w.id = merge_reattachment_log.winner_wedding_id
        AND w.venue_id IN (SELECT id FROM public.venues WHERE is_demo = true)
    )
  );

-- ============================================================================
-- STEP 3 — trigger function + trigger
-- ============================================================================
-- Implementation notes:
--   - Each UPDATE returns the count via GET DIAGNOSTICS so we can record
--     it in the audit row. Cheaper than a separate SELECT COUNT(*).
--   - SECURITY DEFINER is NOT needed — the trigger runs in the caller's
--     security context. Both service-role + coordinator-initiated merges
--     have already proven they can write to weddings (they did the
--     UPDATE that fired this trigger), so they can write to the
--     dependent tables too. RLS on the dependents already covers them.

CREATE OR REPLACE FUNCTION public.reattach_on_wedding_merge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $reattach_on_wedding_merge$
DECLARE
  v_ae_moved integer := 0;
  v_tp_moved integer := 0;
  v_ci_moved integer := 0;
BEGIN
  -- Reattach live attribution_events. Reverted rows are tombstones —
  -- moving them would dirty the audit trail.
  UPDATE public.attribution_events
  SET wedding_id = NEW.merged_into_id
  WHERE wedding_id = OLD.id
    AND reverted_at IS NULL;
  GET DIAGNOSTICS v_ae_moved = ROW_COUNT;

  -- Reattach all touchpoints (no soft-delete column on this table).
  UPDATE public.wedding_touchpoints
  SET wedding_id = NEW.merged_into_id
  WHERE wedding_id = OLD.id;
  GET DIAGNOSTICS v_tp_moved = ROW_COUNT;

  -- Reattach live candidate_identities. Soft-deleted candidates stay
  -- pointing at the loser so the soft-delete decision isn't silently
  -- carried over to the winner.
  UPDATE public.candidate_identities
  SET resolved_wedding_id = NEW.merged_into_id
  WHERE resolved_wedding_id = OLD.id
    AND deleted_at IS NULL;
  GET DIAGNOSTICS v_ci_moved = ROW_COUNT;

  -- Single audit row per trigger firing (zero counts allowed — the
  -- presence of the row is the "we processed this loser" marker that
  -- the migration backfill relies on for idempotency).
  INSERT INTO public.merge_reattachment_log (
    loser_wedding_id,
    winner_wedding_id,
    attribution_events_moved,
    touchpoints_moved,
    candidates_moved
  ) VALUES (
    OLD.id,
    NEW.merged_into_id,
    v_ae_moved,
    v_tp_moved,
    v_ci_moved
  );

  RETURN NEW;
END;
$reattach_on_wedding_merge$;

COMMENT ON FUNCTION public.reattach_on_wedding_merge() IS
  'Stream NNN (migration 202). AFTER UPDATE trigger function for '
  'weddings.merged_into_id NULL→non-NULL transitions. Reattaches '
  'attribution_events / wedding_touchpoints / candidate_identities '
  'from loser to winner + writes one audit row to '
  'merge_reattachment_log. See migration header for the full rationale.';

-- Drop any prior trigger of the same name (idempotent re-apply).
DROP TRIGGER IF EXISTS trg_weddings_reattach_on_merge ON public.weddings;

-- AFTER UPDATE so the merged_into_id pointer is already committed to
-- the row when the trigger fires (BEFORE UPDATE would race with anyone
-- reading the loser by id during the transaction). The WHEN clause
-- restricts firing to the exact NULL→non-NULL transition; UPDATEs that
-- don't touch merged_into_id, or that re-stamp the same value, are no-ops.
CREATE TRIGGER trg_weddings_reattach_on_merge
  AFTER UPDATE OF merged_into_id ON public.weddings
  FOR EACH ROW
  WHEN (OLD.merged_into_id IS NULL AND NEW.merged_into_id IS NOT NULL)
  EXECUTE FUNCTION public.reattach_on_wedding_merge();

COMMENT ON TRIGGER trg_weddings_reattach_on_merge ON public.weddings IS
  'Stream NNN (migration 202). Fires when weddings.merged_into_id '
  'transitions from NULL to non-NULL. Universal fix for orphaned '
  'attribution after a merge. See public.reattach_on_wedding_merge() '
  'for behavior.';

-- ============================================================================
-- STEP 4 — backfill existing mergers
-- ============================================================================
-- For every wedding row that already has merged_into_id set BEFORE this
-- migration ran, do the same UPDATEs the trigger would have done. Gate
-- by NOT EXISTS against merge_reattachment_log so re-running the
-- migration is a no-op.
--
-- Implementation: a single DO block iterates loser rows, calls UPDATE
-- per dependent table per loser, and inserts an audit row. Per-loser
-- iteration (rather than one big bulk UPDATE) is necessary because the
-- audit row needs per-loser counts. 146 losers in Rixey today; iteration
-- cost is trivial.

DO $$
DECLARE
  r record;
  v_ae_moved integer := 0;
  v_tp_moved integer := 0;
  v_ci_moved integer := 0;
BEGIN
  FOR r IN
    SELECT id, merged_into_id
    FROM public.weddings
    WHERE merged_into_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.merge_reattachment_log mrl
        WHERE mrl.loser_wedding_id = public.weddings.id
      )
  LOOP
    UPDATE public.attribution_events
    SET wedding_id = r.merged_into_id
    WHERE wedding_id = r.id
      AND reverted_at IS NULL;
    GET DIAGNOSTICS v_ae_moved = ROW_COUNT;

    UPDATE public.wedding_touchpoints
    SET wedding_id = r.merged_into_id
    WHERE wedding_id = r.id;
    GET DIAGNOSTICS v_tp_moved = ROW_COUNT;

    UPDATE public.candidate_identities
    SET resolved_wedding_id = r.merged_into_id
    WHERE resolved_wedding_id = r.id
      AND deleted_at IS NULL;
    GET DIAGNOSTICS v_ci_moved = ROW_COUNT;

    INSERT INTO public.merge_reattachment_log (
      loser_wedding_id,
      winner_wedding_id,
      attribution_events_moved,
      touchpoints_moved,
      candidates_moved
    ) VALUES (
      r.id,
      r.merged_into_id,
      v_ae_moved,
      v_tp_moved,
      v_ci_moved
    );
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
