-- Migration 156: draft_feedback metadata column (T5-α.1).
--
-- Background: writers in src/lib/services/learning.ts +
-- src/lib/services/email-pipeline.ts +
-- src/app/api/agent/auto-send-cancel/route.ts have been inserting
-- four columns that DO NOT exist in the draft_feedback schema:
--   - feedback_type   (real column is "action")
--   - original_subject
--   - edited_subject
--   - email_category
-- Postgres rejects the insert wholesale on unknown columns, so EVERY
-- approve / edit / reject feedback row written via these code paths
-- has been silently failing for the entire lifetime of the table
-- (added in migration 002). The voice-DNA "recent edit patterns"
-- counter on /api/intel/voice-dna and the learning-loop good-examples
-- / rejection-reasons / edit-patterns retrieval have all been
-- returning zero rows.
--
-- Fix:
--   1. Stage 1 (this migration): add metadata jsonb so we have a
--      home for original_subject / edited_subject / email_category —
--      they're useful audit data even if not currently part of the
--      learning-context retrieval.
--   2. Stage 2 (separate commit, code-side): rename writer keys from
--      feedback_type -> action and stash the dropped fields in
--      metadata. Update reader (voice-dna) to filter on action.
--
-- No backfill: pre-fix rows DO NOT EXIST. Every approve / edit /
-- reject coordinator action wrote 0 rows.
--
-- Idempotent.

ALTER TABLE public.draft_feedback
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.draft_feedback.metadata IS
  'Audit blob for the legacy fields the writers were trying to '
  'persist before T5-α.1: original_subject, edited_subject, '
  'email_category. Not consumed by learning-context retrieval; '
  'kept for forensics + future per-category stats. See migration 156.';
