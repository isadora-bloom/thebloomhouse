-- ---------------------------------------------------------------------------
-- 297_sequence_triggers_extension.sql  (F12)
-- ---------------------------------------------------------------------------
-- The sequences table currently accepts only post_tour / ghosted /
-- post_booking / pre_event / custom. Operators have asked for trigger
-- types that fire on real lifecycle events the platform already detects:
--
--   tour_cancelled      — tour scheduled then cancelled (re-engagement)
--   lost_reactivation   — wedding marked lost N days ago (cold revival)
--   no_show             — tour scheduled, did not happen, no cancellation
--   contract_overdue    — proposal_sent → no signed contract by deadline
--
-- These map to state-machine signals the platform already emits — the
-- sequence runner just needs to know to fire on them.
-- ---------------------------------------------------------------------------

-- Real table name is follow_up_sequences (mig 025), not sequences.
ALTER TABLE follow_up_sequences DROP CONSTRAINT IF EXISTS follow_up_sequences_trigger_type_check;
ALTER TABLE follow_up_sequences DROP CONSTRAINT IF EXISTS sequences_trigger_type_check;
ALTER TABLE follow_up_sequences
  ADD CONSTRAINT follow_up_sequences_trigger_type_check
  CHECK (trigger_type IN (
    'post_tour',
    'ghosted',
    'post_booking',
    'pre_event',
    'tour_cancelled',
    'lost_reactivation',
    'no_show',
    'contract_overdue',
    'custom'
  ));

NOTIFY pgrst, 'reload schema';
