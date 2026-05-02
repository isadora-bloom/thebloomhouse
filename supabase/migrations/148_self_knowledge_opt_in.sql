-- Migration 148: self-knowledge insights opt-in (ANTI-19.9-5).
--
-- Per Playbook ANTI-19.9 #5: self-knowledge insights (insights ABOUT
-- the venue's own coordinator behavior, AI/coordinator collaboration
-- health, internal process maturity) are sensitive — they border on
-- coordinator surveillance. Default OFF; venue must opt in before they
-- compute or surface.
--
-- T3-I shipped two self-knowledge insights without this gate:
--   - coordinator_override_pattern (draft accept/edit/reject DoW analysis)
--   - strength_area_cohort         (per-guest-count band conversion)
--
-- Of these, ONLY coordinator_override_pattern is true coordinator-
-- behavior insight. strength_area_cohort is venue track-record (no
-- per-coordinator surveillance), so it stays default-on. The opt-in
-- gates the surveillance-flavored ones.
--
-- This migration adds venues.self_knowledge_insights_enabled (boolean
-- default false). The generators read this flag and return null when
-- it's off — no compute, no LLM call, no surface row.
--
-- Idempotent.

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS self_knowledge_insights_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venues.self_knowledge_insights_enabled IS
  'Per Playbook ANTI-19.9 #5: opt-in gate for surveillance-flavored '
  'self-knowledge insights (coordinator_override_pattern). Default '
  'false; venue admin enables in /agent/settings or onboarding. '
  'Generators check this flag and skip when off.';
