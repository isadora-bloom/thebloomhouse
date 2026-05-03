-- ---------------------------------------------------------------------------
-- 199_tour_couple_trigger_fix.sql
-- ---------------------------------------------------------------------------
-- Fixes a bug in migration 196's trigger definition.
--
-- 196 created the trigger with:
--
--   CREATE TRIGGER trg_tours_sync_couple_name
--   AFTER INSERT OR UPDATE OR DELETE ON public.people
--   FOR EACH ROW
--   WHEN (
--     (TG_OP = 'DELETE' AND OLD.role IN ('partner1', 'partner2'))
--     OR (TG_OP <> 'DELETE' AND NEW.role IN ('partner1', 'partner2'))
--   )
--   EXECUTE FUNCTION public.tours_sync_couple_name();
--
-- Postgres rejects this with `column "tg_op" does not exist`. TG_OP is a
-- PL/pgSQL pseudo-variable available only INSIDE a trigger function body.
-- Trigger WHEN clauses can reference NEW and OLD, but NEW is NULL on
-- DELETE and OLD is NULL on INSERT — and referencing the wrong one for
-- the operation raises a runtime error, so a single WHEN clause that
-- gates correctly across all three operations is awkward.
--
-- Cleanest fix: drop the WHEN clause entirely and fold the role filter
-- into the function body. The function does an UPDATE on tours, so
-- firing it for non-partner role changes (guest/vendor/family) does
-- one extra SELECT + zero UPDATEs — measurably cheap.
--
-- Idempotent: DROP/CREATE ladders + CREATE OR REPLACE.
-- ---------------------------------------------------------------------------

-- 1. Update the trigger function to filter roles internally.
--    Same body as 196's version, but with an early-return guard that
--    skips non-partner changes.

CREATE OR REPLACE FUNCTION public.tours_sync_couple_name()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $tours_sync_couple_name$
DECLARE
  affected_wedding_id uuid;
  new_name text;
  relevant_role text;
BEGIN
  -- Identify the role we're acting on for this op.
  IF TG_OP = 'DELETE' THEN
    relevant_role := OLD.role;
  ELSE
    relevant_role := NEW.role;
  END IF;

  -- Skip non-partner roles. Guest / wedding party / vendor / family
  -- don't carry couple identity. (Was the WHEN clause in 196; moved
  -- in-body because TG_OP isn't available in trigger WHEN predicates.)
  IF relevant_role IS NULL OR relevant_role NOT IN ('partner1', 'partner2') THEN
    -- Still need to handle UPDATE that changed the role AWAY from a
    -- partner role — that case re-stamps the old wedding's tours too.
    IF TG_OP = 'UPDATE' AND OLD.role IN ('partner1', 'partner2')
       AND OLD.wedding_id IS NOT NULL THEN
      new_name := public.compute_couple_display_name(OLD.wedding_id);
      UPDATE public.tours
         SET couple_display_name = new_name
       WHERE wedding_id = OLD.wedding_id;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Pick the wedding_id from the relevant row.
  IF TG_OP = 'DELETE' THEN
    affected_wedding_id := OLD.wedding_id;
  ELSE
    affected_wedding_id := NEW.wedding_id;
  END IF;

  IF affected_wedding_id IS NOT NULL THEN
    new_name := public.compute_couple_display_name(affected_wedding_id);
    UPDATE public.tours
       SET couple_display_name = new_name
     WHERE wedding_id = affected_wedding_id;
  END IF;

  -- Handle the rare case where a partner row was reassigned to a
  -- different wedding (UPDATE moved wedding_id). Sync the prior
  -- wedding's tours too.
  IF TG_OP = 'UPDATE' AND OLD.wedding_id IS DISTINCT FROM NEW.wedding_id
     AND OLD.wedding_id IS NOT NULL THEN
    new_name := public.compute_couple_display_name(OLD.wedding_id);
    UPDATE public.tours
       SET couple_display_name = new_name
     WHERE wedding_id = OLD.wedding_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$tours_sync_couple_name$;

COMMENT ON FUNCTION public.tours_sync_couple_name() IS
  'Trigger function: re-stamp tours.couple_display_name when partner1/partner2 people rows change. Role filter lives in-body because TG_OP is not available in trigger WHEN predicates. Bug 13 fix (T5-Rixey-GGG, repaired by migration 199).';

-- 2. Drop and re-create the trigger WITHOUT the broken WHEN clause.

DROP TRIGGER IF EXISTS trg_tours_sync_couple_name ON public.people;

CREATE TRIGGER trg_tours_sync_couple_name
AFTER INSERT OR UPDATE OR DELETE
ON public.people
FOR EACH ROW
EXECUTE FUNCTION public.tours_sync_couple_name();

-- 3. Re-run 196's backfill (couple_display_name for any tours where it
--    is still NULL). Idempotent — only touches rows that need it.

UPDATE public.tours t
   SET couple_display_name = public.compute_couple_display_name(t.wedding_id)
 WHERE t.wedding_id IS NOT NULL
   AND (t.couple_display_name IS NULL OR t.couple_display_name = '');

NOTIFY pgrst, 'reload schema';
