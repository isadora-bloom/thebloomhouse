-- ============================================
-- 040: CONSOLIDATE SEQUENCE MODELS
-- Drop the old parallel system (follow_up_sequence_templates + wedding_sequences)
-- and commit to the active model (follow_up_sequences + sequence_steps).
-- Old tables are archived (renamed), not dropped, for recoverability.
-- ============================================

-- Drop FK: wedding_sequences.template_id -> follow_up_sequence_templates
ALTER TABLE wedding_sequences DROP CONSTRAINT IF EXISTS wedding_sequences_template_id_fkey;

-- Archive the old tables
ALTER TABLE follow_up_sequence_templates RENAME TO _archived_follow_up_sequence_templates;
ALTER TABLE wedding_sequences RENAME TO _archived_wedding_sequences;
