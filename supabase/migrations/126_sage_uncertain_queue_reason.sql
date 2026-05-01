-- Migration 126: sage_uncertain_queue.reason (T1-J / B-20)
--
-- Pre-migration sage_uncertain_queue carried only confidence-based
-- escalations (sage_brain returns confidence < 80, route inserts a
-- queue row). With B-20 / T1-J the route now ALSO routes to this
-- queue when the inbound message hits a forbidden-topic keyword
-- (per-venue rules from venue_forbidden_topics, migration 125, plus
-- the global ESCALATION_KEYWORDS list). Coordinators need to be able
-- to triage these differently — a forbidden-topic skip is a "do not
-- guess, route to a human" gate, not a "Sage tried but wasn't sure"
-- review.
--
-- This migration adds a `reason` column. Default 'low_confidence'
-- preserves the legacy semantics for every existing row. The new
-- 'forbidden_topic' value is set by the portal/sage route when
-- pre-classification matches.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS.

ALTER TABLE sage_uncertain_queue
  ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT 'low_confidence';

ALTER TABLE sage_uncertain_queue
  DROP CONSTRAINT IF EXISTS sage_uncertain_queue_reason_check;
ALTER TABLE sage_uncertain_queue
  ADD CONSTRAINT sage_uncertain_queue_reason_check
    CHECK (reason IN ('low_confidence', 'forbidden_topic'));

CREATE INDEX IF NOT EXISTS idx_sage_uncertain_queue_reason
  ON sage_uncertain_queue (venue_id, reason)
  WHERE resolved_at IS NULL;

COMMENT ON COLUMN sage_uncertain_queue.reason IS
  'Why this question landed in the queue. ''low_confidence'' = '
  'sage_brain returned confidence < 80. ''forbidden_topic'' = '
  'pre-classification matched a venue_forbidden_topics keyword or '
  'a global ESCALATION_KEYWORDS entry, so the message bypassed '
  'sage-brain entirely. Per Playbook LIMB-16.4 / B-20.';
