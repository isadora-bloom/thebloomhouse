-- ---------------------------------------------------------------------------
-- 253_profile_enrichment_auto_context.sql
-- ---------------------------------------------------------------------------
-- Continuous profile-enrichment pipeline + AI auto-context notes layer.
--
-- 2026-05-09 Isadora directive:
--   "this looking for the most complete information and updating per
--   client should be a continuous thing - the profile should always be
--   growing and updating on every contact. there should also be a notes
--   section for the AI to pull relevant information into a general notes
--   bucket so Sage and the coordinator can look at things - like if they
--   mention in an email they had a stressful job interview etc"
--
-- The Bloom Constitution (2026-04-30) frames Bloom as a forensic
-- identity-reconstruction system. Every fragment of signal a couple
-- emits should be folded back into the canonical record. Names are
-- already covered by `name-upgrade.ts` (sister service). This migration
-- adds:
--
--   1. wedding_auto_context — soft-context note feed. Where life-context
--      ("Jen mentioned a stressful job interview"), family dynamics,
--      vendor preferences, dietary mentions, cultural-significance asks,
--      and other non-schema-shaped observations land. Coordinator-
--      overridable (archive + pin) and traceable to source interaction.
--
--   2. weddings.field_source — jsonb tracking which schema columns are
--      AI-extracted vs coordinator-typed. The enrichment service refuses
--      to overwrite a coordinator-typed value; this is the bookkeeping.
--
--   3. people optional columns (employer, hometown) — soft profile fields
--      we glean from email bodies. NULL when unknown; the enrichment
--      service only writes when a candidate is strictly better.
--
-- Coordinator override invariants (Constitution §4 — never erase the
-- forensic record):
--   * archive sets is_active=false, never DELETE
--   * pin = boolean flag; pinned notes always render at the top
--   * source_interaction_id is FK to interactions; ON DELETE SET NULL so
--     erasure paths don't orphan
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — wedding_auto_context table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.wedding_auto_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  body text NOT NULL,
  category text,
  source text NOT NULL,
  source_interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL,
  confidence integer,
  is_active boolean NOT NULL DEFAULT true,
  pinned boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  archived_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  added_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wedding_auto_context IS
  'owner:agent+portal. Soft-context note feed per wedding. Captures '
  'observations the AI pulled from emails / brain-dumps / transcripts '
  'that DO NOT map cleanly to a schema column (life context, family '
  'dynamics, vendor preferences, mood, anxiety mentions, dietary asks, '
  'cultural significance). Sister service to name-upgrade + structured '
  'profile-enrichment — see src/lib/services/identity/profile-enrichment.ts. '
  'Coordinator-overridable (archive flips is_active=false; pin floats to '
  'top). Forensic record per Constitution §4 — archive never DELETEs.';

COMMENT ON COLUMN public.wedding_auto_context.category IS
  'Free-form bucket label. Suggested values: life_context | family | '
  'vendors | budget | health | dietary | timeline | cultural | preferences | '
  'logistics | misc. NOT a CHECK constraint — categories evolve as the '
  'extractor sees more shapes; treating this as enum would force a '
  'migration every time a new category emerges.';

COMMENT ON COLUMN public.wedding_auto_context.source IS
  'Where this note originated. Values: ai_email_extraction | '
  'ai_calculator_extraction | ai_brain_dump | ai_tour_transcript | '
  'coordinator_added. Drives the source chip in the lead-profile UI.';

COMMENT ON COLUMN public.wedding_auto_context.confidence IS
  '0-100 confidence score from the AI extractor. NULL for '
  'coordinator_added notes (humans don''t score themselves). Increments '
  'when the dedup contract sees the same body 90%+ Jaro-Winkler match '
  'within 90 days — repeated mentions reinforce.';

COMMENT ON COLUMN public.wedding_auto_context.is_active IS
  'Soft-archive flag. archived_at + archived_by stamp who pulled it. '
  'Default true. NEVER hard-delete — Constitution invariant. Coordinator '
  'unarchives by flipping back to true.';

COMMENT ON COLUMN public.wedding_auto_context.pinned IS
  'Coordinator-flagged must-know. Pinned notes always render at the top '
  'of the auto-context feed and are passed to Sage/Inquiry brains first.';

COMMENT ON COLUMN public.wedding_auto_context.source_interaction_id IS
  'Interaction this note was extracted from. NULL for brain-dump-sourced '
  'or coordinator_added notes. ON DELETE SET NULL so erasure paths don''t '
  'orphan but the note survives (coordinator may still want the memory).';

CREATE INDEX IF NOT EXISTS idx_wedding_auto_context_wedding_active
  ON public.wedding_auto_context (wedding_id, created_at DESC)
  WHERE is_active = true;

COMMENT ON INDEX public.idx_wedding_auto_context_wedding_active IS
  'Hot-path partial index for the lead-profile feed and the brain '
  'context loaders. Filters on is_active=true so archived notes don''t '
  'inflate scans.';

CREATE INDEX IF NOT EXISTS idx_wedding_auto_context_venue
  ON public.wedding_auto_context (venue_id, created_at DESC)
  WHERE is_active = true;

COMMENT ON INDEX public.idx_wedding_auto_context_venue IS
  'Venue-scoped recent-context queries (rollup of "what was learned this '
  'week across all couples"). RLS safety belt.';

CREATE INDEX IF NOT EXISTS idx_wedding_auto_context_pinned
  ON public.wedding_auto_context (wedding_id)
  WHERE is_active = true AND pinned = true;

COMMENT ON INDEX public.idx_wedding_auto_context_pinned IS
  'Pinned-only fast lookup. Brain context loaders may prefer to fetch '
  'pinned-first then top up with recent unpinned.';

-- updated_at trigger for the coordinator-edit case (pin/archive flips).
CREATE OR REPLACE FUNCTION public.touch_wedding_auto_context_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wedding_auto_context_touch ON public.wedding_auto_context;
CREATE TRIGGER trg_wedding_auto_context_touch
  BEFORE UPDATE ON public.wedding_auto_context
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_wedding_auto_context_updated_at();

-- ============================================================================
-- STEP 2 — RLS policies
-- ============================================================================
-- Mirrors the policy shape of wedding_internal_notes (migration 097) and
-- the brain_dump_entries pattern. Authenticated users may read + write
-- their own venue's rows. Service role bypasses RLS for the cron / pipeline
-- writers.

ALTER TABLE public.wedding_auto_context ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wedding_auto_context_auth_select" ON public.wedding_auto_context;
CREATE POLICY "wedding_auto_context_auth_select"
  ON public.wedding_auto_context
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "wedding_auto_context_auth_insert" ON public.wedding_auto_context;
CREATE POLICY "wedding_auto_context_auth_insert"
  ON public.wedding_auto_context
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "wedding_auto_context_auth_update" ON public.wedding_auto_context;
CREATE POLICY "wedding_auto_context_auth_update"
  ON public.wedding_auto_context
  FOR UPDATE
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  )
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

-- ============================================================================
-- STEP 3 — weddings.field_source jsonb
-- ============================================================================
-- Tracks per-column provenance so the enrichment service can refuse to
-- overwrite a coordinator-typed value with an AI-extracted one. Shape:
--   { "guest_count_estimate": "extracted_email",
--     "dietary_summary":      "coordinator_typed",
--     "wedding_date":         "calendar_invite" }
-- Default '{}'::jsonb. Writers (enrichment service, coordinator save)
-- patch a single key; never replace the whole object.

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS field_source jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.weddings.field_source IS
  'Per-column provenance map for AI-extracted vs coordinator-typed '
  'values. Keys = column names on the weddings row that the enrichment '
  'service touches (guest_count_estimate, dietary_summary, '
  'family_context, hometown, employer-on-people, etc.). Values are '
  'short labels: "coordinator_typed" | "extracted_email" | '
  '"extracted_calculator" | "extracted_transcript" | "brain_dump" | '
  '"calendar_invite" | "form_relay". The continuous-enrichment pipeline '
  'refuses to overwrite a key whose existing value is "coordinator_typed". '
  'Migration 253.';

-- ============================================================================
-- STEP 4 — weddings soft-profile columns the enrichment service may write
-- ============================================================================
-- These are wedding-level "what we know about this couple" fields that
-- multiple surfaces want (lead profile, Sage context, inquiry-brain
-- context). Wedding-level rather than people-level because the same
-- dietary / cultural / family note typically applies to the couple as a
-- unit, not just one partner.

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS dietary_summary text;

COMMENT ON COLUMN public.weddings.dietary_summary IS
  'Coordinator-readable summary of dietary mentions across all signals '
  '("3 vegetarians, 1 gluten-free, allergic-nut concern for groom''s '
  'mother"). Written by the enrichment service when the AI sees clear '
  'dietary mentions; coordinator may override. The field_source map '
  'tracks who wrote it. Migration 253.';

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS family_context text;

COMMENT ON COLUMN public.weddings.family_context IS
  'Coordinator-readable summary of family dynamics ("groom''s parents '
  'divorced, prefer separated seating", "bride''s grandmother in poor '
  'health and may not attend"). Written by the enrichment service or '
  'the coordinator. Migration 253.';

-- ============================================================================
-- STEP 5 — people optional soft-profile columns
-- ============================================================================
-- Per-person fields the AI extracts when available. NULL when unknown;
-- the enrichment service only writes when the candidate is strictly
-- better (existing was NULL or shorter).

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS employer text;

COMMENT ON COLUMN public.people.employer IS
  'Where this person works, when mentioned in correspondence ("Jen works '
  'at Capital One"). Written by the enrichment service from email body '
  'extraction. Coordinator may override. Migration 253.';

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS hometown text;

COMMENT ON COLUMN public.people.hometown IS
  'Where this person is from / lives, when mentioned in correspondence '
  '("we''re both from Portland", "we live in Asheville now"). Written by '
  'the enrichment service. Migration 253.';

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS profile_field_source jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.people.profile_field_source IS
  'Per-column provenance map for AI-extracted vs coordinator-typed '
  'values on the people row (employer, hometown, phone). Same shape as '
  'weddings.field_source. Migration 253.';

-- ============================================================================
-- STEP 6 — telemetry: profile_enrichment_runs
-- ============================================================================
-- Lightweight ledger of every enrichment run so the lead-profile UI can
-- show "last enriched 12 minutes ago" and the cost-ceiling audit can
-- correlate enrichment cost to per-wedding outcomes. Fire-and-forget;
-- never blocks the enrichment service.

CREATE TABLE IF NOT EXISTS public.profile_enrichment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  trigger text NOT NULL,
  fields_updated_count integer NOT NULL DEFAULT 0,
  notes_added_count integer NOT NULL DEFAULT 0,
  scanned_count integer NOT NULL DEFAULT 0,
  cost_cents integer,
  prompt_version text,
  correlation_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.profile_enrichment_runs IS
  'owner:agent. Per-call telemetry for the continuous profile-enrichment '
  'pipeline (src/lib/services/identity/profile-enrichment.ts). One row '
  'per enrichProfileFromTouchpoints invocation. Used by the lead-profile '
  '"last enriched" timestamp and the venue-rollup view. Migration 253.';

COMMENT ON COLUMN public.profile_enrichment_runs.trigger IS
  'What kicked this run. Values: pipeline_email | brain_dump_confirm | '
  'tour_transcript | admin_backfill | manual_run.';

CREATE INDEX IF NOT EXISTS idx_profile_enrichment_runs_wedding
  ON public.profile_enrichment_runs (wedding_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_profile_enrichment_runs_venue
  ON public.profile_enrichment_runs (venue_id, created_at DESC);

ALTER TABLE public.profile_enrichment_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profile_enrichment_runs_auth_select" ON public.profile_enrichment_runs;
CREATE POLICY "profile_enrichment_runs_auth_select"
  ON public.profile_enrichment_runs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
