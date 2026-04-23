-- Migration 088: client_match_queue accepts signal↔signal pairs.
--
-- Phase 8 shipped person↔person matching via client_match_queue. F1 opens
-- the queue to signal↔signal and signal↔person pairs so two tangential
-- signals that look like the same person (two Instagram handles both
-- matching "Sarah H") can also land in the queue for coordinator review,
-- using one data model and one resolver UI instead of a second table.
--
-- Design:
-- - person_a_id / person_b_id become nullable (they were already nullable
--   in the original migration 009 definition — no live change there, only
--   documentation intent).
-- - Add signal_a_id / signal_b_id referencing tangential_signals, nullable.
-- - A CHECK ensures each "side" has exactly one identifier (person_x XOR
--   signal_x), and the two sides are not the same side (a != b).
-- - Composite indexes for the new lookup shapes.

-- Nullable already; add FK-backed signal columns.
ALTER TABLE public.client_match_queue
  ADD COLUMN IF NOT EXISTS signal_a_id uuid
    REFERENCES public.tangential_signals(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS signal_b_id uuid
    REFERENCES public.tangential_signals(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.client_match_queue.signal_a_id IS
  'Phase 8 F1. If set, side A of the match is a tangential_signal row rather than a person. Mutually exclusive with person_a_id.';
COMMENT ON COLUMN public.client_match_queue.signal_b_id IS
  'Phase 8 F1. If set, side B of the match is a tangential_signal row rather than a person. Mutually exclusive with person_b_id.';

-- Exactly one identifier per side. Done as two CHECKs so the error message
-- points at the specific side that's wrong.
ALTER TABLE public.client_match_queue
  DROP CONSTRAINT IF EXISTS client_match_queue_side_a_exclusive;
ALTER TABLE public.client_match_queue
  ADD CONSTRAINT client_match_queue_side_a_exclusive CHECK (
    (person_a_id IS NOT NULL AND signal_a_id IS NULL)
    OR (person_a_id IS NULL AND signal_a_id IS NOT NULL)
  );

ALTER TABLE public.client_match_queue
  DROP CONSTRAINT IF EXISTS client_match_queue_side_b_exclusive;
ALTER TABLE public.client_match_queue
  ADD CONSTRAINT client_match_queue_side_b_exclusive CHECK (
    (person_b_id IS NOT NULL AND signal_b_id IS NULL)
    OR (person_b_id IS NULL AND signal_b_id IS NOT NULL)
  );

-- Forbid trivially-identical pairs (same person or same signal on both
-- sides). Does nothing against a cross-type pair with the same uuid, which
-- is impossible anyway since the two tables have disjoint ids.
ALTER TABLE public.client_match_queue
  DROP CONSTRAINT IF EXISTS client_match_queue_distinct_sides;
ALTER TABLE public.client_match_queue
  ADD CONSTRAINT client_match_queue_distinct_sides CHECK (
    (person_a_id IS NULL OR person_b_id IS NULL OR person_a_id <> person_b_id)
    AND (signal_a_id IS NULL OR signal_b_id IS NULL OR signal_a_id <> signal_b_id)
  );

CREATE INDEX IF NOT EXISTS idx_client_match_queue_signal_a
  ON public.client_match_queue (signal_a_id)
  WHERE signal_a_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_match_queue_signal_b
  ON public.client_match_queue (signal_b_id)
  WHERE signal_b_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
