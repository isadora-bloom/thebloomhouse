-- Migration 170: T5-followup-Z — venues.owner_email + ai_email gate.
--
-- Closes a gap in the 15-min onboarding wizard: it never asked for the
-- email address Sage should send from (ai_email) or the owner /
-- primary-coordinator email for digest delivery (owner_email). The
-- form now collects both at the basics step. This migration adds
-- venues.owner_email so the column exists for the form to write into.
--
-- ai_email already lives on venue_ai_config (since migration 001), so
-- no schema change is needed there — the wizard just had no UI for it.
--
-- Idempotent. Safe to re-run.

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS owner_email text;

COMMENT ON COLUMN public.venues.owner_email IS
  'Primary coordinator / owner email used for digest delivery and ' ||
  'venue-wide notifications. Distinct from venue_config.coordinator_email ' ||
  '(which is the operations contact shown to couples).';
