-- Combined apply: migrations 250 + 251 + 252
-- Paste into https://supabase.com/dashboard/project/jsxxgwprxuqgcauzlxcb/sql/new
-- Idempotent. Safe to re-run.

-- ============================================
-- MIGRATION 250: cultural_moments ai_llm proposed_by
-- ============================================
-- Migration 250: extend cultural_moments.proposed_by CHECK constraint
-- to allow the new 'ai_llm' value.
--
-- TRENDS-DIAGNOSIS Fix 3 / Finding A (2026-05-09).
--
-- Pre-migration constraint (from migration 139):
--   proposed_by IN ('system', 'ai', 'coordinator')
--
-- Post-migration constraint:
--   proposed_by IN ('system', 'ai', 'ai_llm', 'coordinator')
--
-- Semantics:
--   - 'system'      — automated insert with no proposer attribution
--                     (e.g. seed data, hardcoded one-off insertions).
--   - 'ai'          — LEGACY z-score / search-trend spike detector
--                     (cultural-moments-auto-propose.ts). Statistical;
--                     names spikes generically.
--   - 'ai_llm'      — NEW judgement-tier proposer
--                     (cultural-moments-llm-propose.ts). Sonnet call
--                     proposes NAMED moments with evidence URLs and
--                     dateable windows.
--   - 'coordinator' — manual proposal via the UI.
--
-- The two AI proposers run on different schedules and dedup
-- independently; coordinators reviewing /intel/cultural-moments can
-- distinguish them via the proposed_by badge.
--
-- Idempotent: drop-then-add lets repeated runs converge.

ALTER TABLE public.cultural_moments
  DROP CONSTRAINT IF EXISTS cultural_moments_proposed_by_check;

ALTER TABLE public.cultural_moments
  ADD CONSTRAINT cultural_moments_proposed_by_check
  CHECK (proposed_by IN ('system', 'ai', 'ai_llm', 'coordinator'));

COMMENT ON COLUMN public.cultural_moments.proposed_by IS
  'Source of the proposal: system | ai | ai_llm | coordinator. '
  'ai = legacy statistical z-score detector (cultural-moments-auto-propose). '
  'ai_llm = judgement-tier Sonnet proposer (cultural-moments-llm-propose, 2026-05-09). '
  'See TRENDS-DIAGNOSIS.md Fix 3 / Finding A for the architectural rationale.';

-- ============================================
-- MIGRATION 251: intelligence_insights narration_source
-- ============================================
-- Migration 251: track narration source on intelligence_insights
--
-- AI-VS-TEMPLATED-AUDIT.md finding #1 (2026-05-09). The intelligence-
-- engine ships 14 detectors that write rows to intelligence_insights
-- with fully templated body/title/action — same surface the LLM-
-- narrated rows from risk-flags / heat-narration / cohort-match /
-- correlation-narration land in. Coordinators see them all under the
-- same "AI-generated insights" label and cannot tell which prose came
-- from a real LLM call vs a string-template fill.
--
-- The remediation switches every intelligence-engine detector to a
-- numbers-guarded LLM narrator (Sonnet, intelligence-engine-narration.v1)
-- and falls back to the existing template when the cost-ceiling gate
-- is closed or the LLM call fails. This column records which path
-- produced the prose:
--
--   'llm'      — narration came from the LLM call AND passed the
--                numbers-guard. Renders under real Sage / AI iconography.
--   'template' — fallback path — gate was closed or LLM failed or
--                numbers-guard rejected. Prose is deterministically
--                composed by the detector.
--   'mixed'    — reserved for future hybrid surfaces (LLM title +
--                template body, etc.). Not currently emitted.
--
-- Future work: a small badge in /intel/dashboard + /intel/insights can
-- read this column to render "AI-narrated" vs "Pattern detection
-- (rule-based fallback)" so the UI no longer blends the two
-- silently. Out of scope for migration 251 — this just opens the
-- column.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DROP/CREATE the CHECK.

ALTER TABLE public.intelligence_insights
  ADD COLUMN IF NOT EXISTS narration_source text;

ALTER TABLE public.intelligence_insights
  DROP CONSTRAINT IF EXISTS intelligence_insights_narration_source_check;
ALTER TABLE public.intelligence_insights
  ADD CONSTRAINT intelligence_insights_narration_source_check
    CHECK (narration_source IS NULL OR narration_source IN (
      'llm', 'template', 'mixed'
    ));

COMMENT ON COLUMN public.intelligence_insights.narration_source IS
  'Provenance of the title/body/action prose. llm = LLM call passed '
  'numbers-guard; template = deterministic detector fallback (cost '
  'ceiling closed, LLM failed, or numbers-guard rejected); mixed = '
  'reserved for future hybrid surfaces. NULL on legacy rows pre-migration. '
  'Set per AI-VS-TEMPLATED-AUDIT.md finding #1 remediation (2026-05-09) '
  'so coordinator UI can distinguish real LLM narration from template '
  'fallback rows.';

-- ============================================
-- MIGRATION 252: anomaly_alerts explanation_source
-- ============================================
-- Migration 252: anomaly_alerts.explanation_source
--
-- AI-VS-TEMPLATED-AUDIT Finding #4 follow-up (2026-05-09).
--
-- The `ai_explanation` column on anomaly_alerts is populated by two
-- different writers, only one of which actually called an LLM:
--
--   1. runAnomalyDetection (anomaly-detection.ts) -> getAIExplanation
--      -> callAIJson('anomaly_explanation') -> Sonnet hypothesis chain.
--      This is real LLM output.
--
--   2. detectAvailabilityAnomalies (anomaly-detection.ts) -> hardcoded
--      template strings ("Saturdays in October are filling fast..." /
--      "Unusually high demand for October dates..."). The function's
--      own docstring admitted "Uses static templates for ai_explanation
--      (no AI call)."
--
-- Both rows surfaced under the same `ai_explanation` column on
-- /intel/anomalies, so coordinators could not distinguish a real LLM
-- hypothesis from a templated string. AI-VS-TEMPLATED-AUDIT Finding #4
-- elevated this to a fix-now bug.
--
-- detectAvailabilityAnomalies is being switched to a real Sonnet
-- narrator on the SAME run as this migration (callAIJson with task
-- 'availability_anomaly_explanation', prompt
-- 'availability-anomaly-explanation.v1'). That narrator falls back to
-- the existing template when gateForBrainCall closes (cost ceiling
-- pause) OR the LLM call fails. So a row's ai_explanation can come
-- from one of three places:
--
--   - 'ai'       : real LLM narrator output (Sonnet, prompt-versioned).
--   - 'template' : deterministic-template fallback when LLM unavailable.
--   - 'rule'     : pure rule-based string with no LLM ever attempted
--                  (legacy rows from before the narrator landed; future
--                  detectors that intentionally skip the LLM).
--
-- Stamped on every new write. Existing rows stay NULL — UI treats NULL
-- as 'unknown' (legacy) so we don't retro-label rows whose actual
-- provenance we no longer know.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DROP/ADD CHECK constraint.

ALTER TABLE public.anomaly_alerts
  ADD COLUMN IF NOT EXISTS explanation_source text;

-- Constraint: nullable enum. NULL is the legacy/unknown sentinel.
ALTER TABLE public.anomaly_alerts
  DROP CONSTRAINT IF EXISTS anomaly_alerts_explanation_source_check;

ALTER TABLE public.anomaly_alerts
  ADD CONSTRAINT anomaly_alerts_explanation_source_check
  CHECK (explanation_source IS NULL
         OR explanation_source IN ('ai', 'template', 'rule'));

COMMENT ON COLUMN public.anomaly_alerts.explanation_source IS
  'Provenance of ai_explanation: ai = real LLM narrator (callAIJson, '
  'prompt-versioned); template = deterministic-template fallback when '
  'LLM unavailable (cost ceiling closed or call failed); rule = pure '
  'rule-based string with no LLM attempted. NULL = legacy row from '
  'before migration 252. Set by every new writer; reads on /intel/anomalies '
  'use this to distinguish real Sonnet hypothesis from fallback template. '
  'See AI-VS-TEMPLATED-AUDIT.md Finding #4.';
