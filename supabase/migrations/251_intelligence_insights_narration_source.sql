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
