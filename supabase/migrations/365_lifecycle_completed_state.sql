-- Migration 365: add 'completed' to couples.lifecycle_state
--
-- Tier 8 §C.3 doctrine extension. The 2026-05-20 operator audit caught
-- that 'booked' is rendered as a terminal state but does not transition
-- after the wedding date passes. Operators read "Booked" on a couple
-- whose wedding was two weeks ago and assume the surface is stale.
--
-- Adding 'completed' as a new positive-terminal state distinct from
-- 'booked' lets a daily cron flip post-wedding couples and keeps the
-- semantic of "booked = pre-wedding signed contract" intact.
--
-- Doctrine notes:
--   * 'completed' is terminal-positive. Decay sweep does not touch it.
--   * 'completed' DOES count as engaged for funnel ratios + cohort
--     metrics (same as booked).
--   * Operators see "Completed" as the pill on the couples list.
--
-- No data is touched here; the lifecycle-completed sweep
-- (cron + service) lands in the same PR but as a TypeScript-side
-- migration that flips booked -> completed when wedding_date < now().

-- Drop + re-create the CHECK with the new value included. The old
-- CHECK is anonymous (no name was given in mig 346), so we look it up.
DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.couples'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%lifecycle_state%';

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.couples DROP CONSTRAINT %I',
      v_constraint_name
    );
  END IF;
END $$;

ALTER TABLE public.couples
  ADD CONSTRAINT couples_lifecycle_state_check
  CHECK (lifecycle_state IN (
    'channel_scoped',
    'resolved',
    'booked',
    'ghost',
    'agent',
    'completed'
  ));

COMMENT ON COLUMN public.couples.lifecycle_state IS
  'Tier 8 §C.3 lifecycle. channel_scoped (un-acknowledged signal), resolved (live engaged), booked (signed contract pre-wedding), completed (wedding date has passed), ghost (decayed), agent (administrative).';
