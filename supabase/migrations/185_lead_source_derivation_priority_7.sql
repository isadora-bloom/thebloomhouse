-- Migration 185: widen lead_source_derivation_log.priority_used CHECK to allow priority 7.
--
-- T5-Rixey-SS Bug A. The derivation chain in
-- src/lib/services/lead-source-derivation.ts grew a new tier:
--
--   Priority 7 — `weddings.source` legacy-column fallback.
--
-- It runs AFTER UTM (5) and BEFORE the no-signal terminal (6) so explicit
-- signals always win, but a wedding that was created with a non-null
-- `weddings.source` (CRM importer, Calendly/HoneyBook adapter, hand-edit)
-- now resolves to that legacy value when the higher-priority signals
-- miss. Confidence: low.
--
-- The original CHECK clamped priority_used to <= 6, blocking the new
-- tier. Widen to <= 7. Idempotent — DROP CONSTRAINT IF EXISTS first.
--
-- Per Stream SS Bug A. Stream RR uses migration 184; Stream SS reserved
-- 185 + 186.

ALTER TABLE public.lead_source_derivation_log
  DROP CONSTRAINT IF EXISTS lead_source_derivation_log_priority_used_check;

ALTER TABLE public.lead_source_derivation_log
  ADD CONSTRAINT lead_source_derivation_log_priority_used_check
  CHECK (priority_used >= 0 AND priority_used <= 7);

COMMENT ON COLUMN public.lead_source_derivation_log.priority_used IS
  'Which priority slot fired in the derivation chain. 0 = coordinator '
  'override (attribution_priority short-circuit). 1-5 = positive signals '
  '(source_records, tour Q&A, web-form, email-domain, UTM). '
  '7 = weddings.source legacy-column fallback (T5-Rixey-SS Bug A, '
  'migration 185). 6 = no-signal terminal. Higher number = lower '
  'confidence except 0 / 7 which are bands of their own. Distinguishable '
  'in audit by evidence.note when ambiguous.';
