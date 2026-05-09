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
