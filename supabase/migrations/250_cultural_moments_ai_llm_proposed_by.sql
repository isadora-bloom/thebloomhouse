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
