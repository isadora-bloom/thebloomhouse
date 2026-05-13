-- 331_interactions_extracted_facts.sql
--
-- 2026-05-12 — Surface for Haiku-extracted structured facts.
--
-- Pairs with the extended classifyInboundIntent (intent classifier) so
-- every inbound (email / SMS / call / voicemail / Zoom transcript /
-- brain-dump) lands with both an intent verdict AND a small structured
-- payload of names + dates + counts + contact info + source/budget
-- signals. One Haiku call per inbound, no separate extractor pass.
--
-- Downstream readers:
--   - Wave 4 Sonnet identity judge (reconstructs canonical
--     couple_identity_profile) — reads extracted_facts.names +
--     mentioned phone/email to widen the signal pool.
--   - Marketing attribution — reads extracted_facts.source_mentioned
--     to corroborate self-reported source against the inferred
--     forensic verdict (Wave 7B).
--   - Sage tone calibration — reads extracted_facts.budget_signal to
--     gate "premium" framing vs "value" framing.
--
-- The column is nullable; legacy rows get NULL and a future drain
-- backfills them lazily. Statement-level idempotent (no BEGIN/COMMIT;
-- exec_sql rejects those — see feedback_migration_no_transaction_wrapper).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'interactions'
      AND column_name = 'extracted_facts'
  ) THEN
    ALTER TABLE public.interactions
      ADD COLUMN extracted_facts jsonb;
  END IF;
END $$;

COMMENT ON COLUMN public.interactions.extracted_facts IS
  'Haiku-extracted structured facts from the inbound body. Stamped by classifyInboundIntent (lib/services/intel/inbound-intent-classifier.ts) in the same call that decides intent_class. Shape: { names: string[], wedding_date: string | null, guest_count: number | null, phone: string | null, email: string | null, source_mentioned: string | null, budget_signal: ''within'' | ''too_expensive'' | null }. Null on rows classified before mig 331 + on rows where the body had nothing to surface.';
