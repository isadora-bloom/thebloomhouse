-- ---------------------------------------------------------------------------
-- 288_attribution_prompt_version.sql
-- ---------------------------------------------------------------------------
-- Wave 22 — bias remediation (Wave 21 audit fix-up).
--
-- Anchor docs:
--   - PROMPT-BIAS-AUDIT.md (Wave 21 read-only sweep — finding #4
--     critical: channel-role-classifier.prompt.v1 pre-imposed direction
--     on the verdict the classifier was meant to discover)
--   - feedback_measure_dont_assume.md (frame the system's job as
--     MEASURE, not VALIDATE — bias in classifier rules contaminates
--     downstream metrics)
--   - feedback_audit_agents_overclaim.md (re-measure under v2; report
--     the actual numbers, not what we hoped for)
--
-- Why this migration exists
-- -------------------------
-- Wave 22 bumped channel-role-classifier.prompt.v1 → v2 (and
-- inquiry-intent-judge.prompt.v1 → v2) because the v1 system prompts
-- contained direction-loaded language ("lean validation when same-
-- platform signal is absent", "burden of proof shifts toward
-- validation", "tip the scale toward broadcast when post-inquiry
-- engagement is zero"). Rows in attribution_events that were classified
-- under v1 carry that bias and need a flag so the operator can
-- re-classify under v2.
--
-- This migration is the SCHEMA half:
--   - Adds attribution_events.prompt_version_classified_under (text,
--     nullable). NULL for rows that haven't been LLM-classified.
--     Populated for any row where the LLM judge fired (forensic-rule-
--     only rows are unaffected because they don't depend on the
--     prompt).
--   - Backfills existing rows where role_evidence.llm_judge.prompt_version
--     is present (Wave 7B persisted it onto the role_evidence jsonb).
--     Mirrors the same column for intent_class via intent_class_signals.
--   - Adds a partial index on rows whose classified-under version is
--     stale (so the operator-trigger sweep can find them cheaply).
--
-- The OPERATOR-TRIGGERED re-classification endpoint
-- (POST /api/admin/attribution/reclassify-v1) ships separately. This
-- migration does NOT auto-execute reclassification. Per Wave 22
-- doctrine: the operator sees the % of biased classifications and
-- chooses when to re-run.
--
-- Idempotent: every ALTER uses IF NOT EXISTS / DO/EXCEPTION. Safe to
-- re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — attribution_events.prompt_version_classified_under
-- ============================================================================
DO $$ BEGIN
  ALTER TABLE public.attribution_events
    ADD COLUMN IF NOT EXISTS prompt_version_classified_under text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

COMMENT ON COLUMN public.attribution_events.prompt_version_classified_under IS
  'The prompt version the LLM judge ran under when classifying role / intent. '
  'NULL when no LLM judge fired (forensic-rule-only classification). Wave 22 '
  '(2026-05-11) added this so the operator-trigger reclassify sweep can find '
  'rows classified under bias-suspect prompt versions. See PROMPT-BIAS-AUDIT.md.';

-- ============================================================================
-- STEP 2 — Backfill from role_evidence.llm_judge.prompt_version
-- ============================================================================
-- Wave 7B writes the LLM judge's prompt_version into the jsonb evidence
-- field on every row where the judge fired. We hoist it onto the new
-- column so subsequent queries don't need to crack the jsonb.
--
-- Wave 16's intent_class also writes a prompt_version (into
-- intent_class_signals.llm_judge.prompt_version when the judge fired).
-- We use COALESCE so a row classified by both Wave 7B and Wave 16 gets
-- the role-judge version preferred (the audit was about Wave 7B
-- primarily; Wave 16 is also addressed but counts separately).
UPDATE public.attribution_events
SET prompt_version_classified_under = COALESCE(
  role_evidence #>> '{llm_judge,prompt_version}',
  intent_class_signals #>> '{llm_judge,prompt_version}'
)
WHERE prompt_version_classified_under IS NULL
  AND (
    role_evidence ? 'llm_judge'
    OR intent_class_signals ? 'llm_judge'
  );

-- ============================================================================
-- STEP 3 — Partial index on bias-suspect rows
-- ============================================================================
-- Rows where prompt_version_classified_under matches either v1 prompt
-- Wave 22 bumps. Partial so the index stays small once Wave 22
-- reclassification completes (no rows match → empty index).
CREATE INDEX IF NOT EXISTS
  attribution_events_v1_classified_idx
ON public.attribution_events (venue_id, decided_at DESC)
WHERE prompt_version_classified_under IN (
  'channel-role-classifier.prompt.v1',
  'inquiry-intent-judge.prompt.v1'
);

COMMENT ON INDEX public.attribution_events_v1_classified_idx IS
  'Wave 22 — rows classified under the bias-suspect v1 channel-role '
  'classifier or v1 inquiry-intent judge. Partial: shrinks to empty '
  'once reclassification under v2 completes. Used by the operator-'
  'trigger reclassify endpoint to find candidate rows cheaply.';

COMMIT;
