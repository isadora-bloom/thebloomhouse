-- ---------------------------------------------------------------------------
-- Combined apply: identity-capture + auto-context migrations 253-257 (v2)
-- ---------------------------------------------------------------------------
-- Paste into https://supabase.com/dashboard/project/jsxxgwprxuqgcauzlxcb/sql/new
-- All idempotent. Safe to re-run. Skips already-applied migs cleanly.
-- v2 fix: mig 256 dynamic-constraint lookup now matches even when
--        Postgres normalised IN (...) to ANY (ARRAY[...]) in pg_get_constraintdef.

-- ============================================
-- MIGRATION 253
-- ============================================
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

-- ============================================
-- MIGRATION 254
-- ============================================
-- Migration 254: cultural_moments.archive_reason
--
-- TRENDS-DIAGNOSIS Fix 1 (2026-05-09). The /intel/cultural-moments
-- queue surfaced rows whose `end_at` was already in the past — moments
-- from June-October 2025 still showing in the "awaiting your decision"
-- bucket eight months later. Past moments cannot affect FUTURE bookings;
-- they're history. We auto-archive them via a daily sub-job folded into
-- the existing cultural_moments_auto_propose cron tick (no new Vercel
-- cron entry — we're at the 40-cron Pro plan limit).
--
-- This migration adds the audit-trail column so coordinators can see
-- WHY a row was archived. Possible values today:
--   - 'expired'           — end_at < now() at archive time. Safe to
--                           ignore; the moment ran its course.
--   - 'legacy_demo_seed'  — early demo seed rows that were never
--                           cleaned up; surfaced for production venues
--                           by mistake.
--   - NULL                — manually archived via UI or other path.
-- Future archive paths add new values without schema change.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.cultural_moments
  ADD COLUMN IF NOT EXISTS archive_reason text;

COMMENT ON COLUMN public.cultural_moments.archive_reason IS
  'Why a status=''archived'' row was archived. expired = end_at < now() '
  'at archive time (cron auto-archive). legacy_demo_seed = early demo '
  'data archived for non-demo venues. NULL = manually archived. '
  'Coordinator-visible audit trail; never null when the cron archives.';

-- Index for the daily expired-archive job. Filters to status='proposed'
-- because confirmed/dismissed rows must stay visible regardless of
-- end_at (a confirmed historical moment is a permanent attribution-
-- engine input). Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_cultural_moments_proposed_end_at
  ON public.cultural_moments (end_at)
  WHERE status = 'proposed';

-- ============================================
-- MIGRATION 255
-- ============================================
-- ---------------------------------------------------------------------------
-- 255_identity_evidence_phase1.sql
-- ---------------------------------------------------------------------------
-- Identity-capture redesign — Phase 1: schema only, additive, no behavior
-- change. Companion to IDENTITY-CAPTURE-DESIGN.md (committed 2026-05-09).
--
-- Why this exists
-- ---------------
-- Today the pipeline writes `people.first_name` / `people.last_name`
-- whichever way the first signal happened to land — Knot relay From-name,
-- email handle parse, calculator form, contract signer. There is no
-- concept of "evidence." The same column carries Knot proxy IDs (`User
-- 89436314x...`), platform usernames (`Erinhorrigan`, `Mconn`), partial
-- names (`Jen B`), and full legal names (`Jennifer Biaksangi`) with no
-- way to know which is best. Once junk lands, every subsequent fix has
-- to fight the existing column instead of the underlying evidence.
--
-- The redesign treats identity as **forensic evidence** per the Bloom
-- Constitution thesis. Every name claim ever observed is stored; the
-- displayed `first_name`/`last_name` are a *picked* projection. Username-
-- shaped values land in `display_handle` instead of `first_name`. Family
-- and planner mentions go to `wedding_relationships` so they stop
-- becoming `partner2` by accident. Emotional truths and preferences
-- ("my mum is sick", "we don't like flowers") are first-class signals
-- on the same evidence model — see wedding_auto_context.sensitive +
-- expires_at additions below.
--
-- Phase 1 scope: SCHEMA ONLY.
--   - Add columns + tables
--   - No data migration
--   - No code changes
--   - Existing first_name / last_name columns stay populated by current
--     code; the new evidence columns sit alongside, untouched, until
--     Phase 2 wires the capture chokepoint
--
-- Idempotent: every ADD COLUMN / CREATE TABLE / CREATE POLICY uses
-- IF NOT EXISTS or DROP-then-CREATE. Safe to re-run.
--
-- Pre-allocates migration slot 255. Latest is 254.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — people.name_evidence + display_handle + name_confidence
-- ============================================================================
-- name_evidence: append-only log of every name claim observed for this
--   person. Shape:
--   [
--     { "source": "gmail_from_name",   "value": { "first": "Jen", "last": "B" }, "confidence": 30, "captured_at": "2026-04-21T11:44:00Z", "interaction_id": "..." },
--     { "source": "calculator_form",   "value": { "first": "Jennifer", "last": "Biaksangi" }, "confidence": 95, "captured_at": "2026-04-21T14:09:00Z", "interaction_id": "..." },
--     { "source": "contract_signer",   "value": { "first": "Jennifer", "last": "Biaksangi" }, "confidence": 98, "captured_at": "2026-05-02T10:00:00Z", "interaction_id": null }
--   ]
-- The legacy first_name / last_name columns become the *picker output*
-- once Phase 2 ships. Phase 1 just stores the column; nothing reads it
-- yet.
--
-- display_handle: platform-username-shaped values that should NEVER be
-- stored as first_name. Knot proxy IDs, Pinterest usernames, concatenated
-- handles ("Erinhorrigan", "Mconn"). Coordinator UI surfaces this under
-- the name as small print ("Knot: rosaliehoyle") so search-by-handle
-- works.
--
-- name_confidence: 0-100 score of the picker's chosen display.
--   100 = coordinator-typed
--   95+ = contract / calculator form
--   70 = email signature / brain-dump confirmed
--   30-50 = Gmail From-name with real-name shape
--   <20 = email handle parse / weak inference. Below threshold the
--   coordinator UI surfaces "(unverified)".

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS name_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.people.name_evidence IS
  'Append-only log of every name claim observed for this person. '
  'Shape per entry: {source, value:{first,last}, confidence:0-100, '
  'captured_at, interaction_id?}. The picker (lib/services/identity/'
  'name-picker.ts, Phase 2) projects this into the display first_name '
  '/ last_name columns. Coordinator overrides land here as confidence-100 '
  'evidence rows. Migration 255.';

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS display_handle text;

COMMENT ON COLUMN public.people.display_handle IS
  'Platform username / handle shape that should never be stored as '
  'first_name. Knot proxy IDs ("User <hex>"), Pinterest handles '
  '("rosaliehoyle"), concatenated lowercase smushes ("erinhorrigan", '
  '"mconn"). Coordinator UI surfaces this as small print under the '
  'picked display name so search-by-handle finds the lead. Migration 255.';

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS name_confidence smallint;

COMMENT ON COLUMN public.people.name_confidence IS
  'Picker confidence (0-100) for the current first_name + last_name. '
  'NULL when no evidence has been captured. <40 = "(unverified)" badge '
  'in the coordinator UI. Computed by Phase 2 picker; Phase 1 leaves '
  'NULL. Migration 255.';

-- ============================================================================
-- STEP 2 — people.platform_handles
-- ============================================================================
-- Per-platform handle map. Lets the resolver match the same person across
-- platforms when a Pinterest handle and a Knot handle and an Instagram
-- handle all converge. Shape:
--   {
--     "pinterest":   "rosaliehoyle",
--     "knot":        "rosalie_hoyle_92",
--     "weddingwire": "rosaliehoyle1",
--     "instagram":   "rosie.hoyle",
--     "tiktok":      null,
--     "facebook":    null
--   }
-- Coordinator UI shows the full collection on lead profile. Pattern-
-- matched across new arrivals so duplicate IDs trigger merge candidates
-- automatically (Phase 4).

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS platform_handles jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.people.platform_handles IS
  'Per-platform handle map (pinterest, knot, weddingwire, instagram, '
  'tiktok, facebook, twitter, etc). Coordinator UI surfaces all known '
  'handles on lead profile. Resolver uses cross-platform handle match '
  'as a same-person signal in Phase 4. Migration 255.';

-- ============================================================================
-- STEP 3 — people.partner_role_kind
-- ============================================================================
-- Distinguishes real partner2 ("Sarah Olkowski-Smith with own email") from
-- phantom partner2 (LLM extracted "Brett" from a sign-off when partner1
-- is "Brett Smith") so Sage prompts know how to address the couple.
-- Q3 decision (Isadora 2026-05-09): drop partner2 + flag partner_count=1
-- on weddings rather than keep an is_phantom row.
-- This column documents the per-person role with more granularity than
-- the existing people.role enum (which has 'partner1', 'partner2',
-- 'guest', 'wedding_party', 'vendor', 'family', 'parent').

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS partner_role_kind text;

COMMENT ON COLUMN public.people.partner_role_kind IS
  'Sub-classification when role IN (partner1, partner2). Values: '
  'real | phantom (LLM-extracted from sender sign-off, no own email/'
  'phone, never replies to drafts). Phantom rows are deprecated by '
  'Phase 4 — replaced with weddings.partner_count=1 — but the column '
  'lets us tag historical rows during the transition. Migration 255.';

-- ============================================================================
-- STEP 4 — weddings.partner_count
-- ============================================================================
-- Q3 decision: when phantom partner2 detected ("Brett & Brett",
-- "Hannah Lord & Hannah Lord"), drop partner2 and stamp
-- partner_count=1 so Sage prompts know to address one person.
-- NULL by default = unknown (legacy row, predates this migration).

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS partner_count smallint;

COMMENT ON COLUMN public.weddings.partner_count IS
  'Number of decision-making partners (1 or 2). NULL = unknown / legacy. '
  'Stamped 1 when the phantom-partner detector finds a partner2 that '
  'duplicates partner1''s first name with no last name and no own contact '
  'info. Stamped 2 when both partners have independent identity signal. '
  'Drives Sage prompt: "writing to Brett" vs "writing to Brett and '
  'Sarah". Migration 255 (Q3 decision 2026-05-09).';

-- ============================================================================
-- STEP 5 — wedding_relationships table
-- ============================================================================
-- Family / planner / mother-in-law / sibling / "the bride's mom" mentions
-- that today get captured as people.role='partner2' by accident. This
-- table is their proper home: structured non-partner humans associated
-- with a wedding.
--
-- Distinction from people:
--   - people = humans we have direct identity for (own email/phone, can
--     auth into couple portal, replies become interactions)
--   - wedding_relationships = humans MENTIONED in correspondence but
--     not directly contactable. Names, roles, and notes only.
--
-- Q4 decision (Isadora 2026-05-09): Phase 1 ships storage. Coordinator-
-- visible read panel ships in Phase 5 UI polish. Sage prompt feed (the
-- "C" option from Q4) is a Phase 5 polish itself — the agent draft can
-- accidentally address a family member if Sage knows their name without
-- a confirmed-by-coordinator gate.

CREATE TABLE IF NOT EXISTS public.wedding_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  relationship_role text NOT NULL,  -- 'mother' | 'father' | 'mother_in_law' | 'father_in_law' | 'sibling' | 'planner' | 'maid_of_honor' | 'best_man' | 'family_friend' | 'vendor_contact' | 'other'
  detail text,                       -- "of the bride", "groom's stepfather", etc.
  email text,                        -- when known; usually NULL
  phone text,                        -- when known
  source text NOT NULL,              -- 'ai_email_extraction' | 'coordinator_added' | 'csv_import' | 'tour_transcript'
  source_interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL,
  confidence smallint,               -- 0-100; NULL for coordinator_added
  is_active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  added_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wedding_relationships IS
  'owner:agent+portal. Non-partner humans associated with a wedding — '
  'family, planner, MOH, vendor contacts, "the bride''s mom". Today these '
  'land as people.role=partner2 by mistake (LLM extracts from email body, '
  '"Hi from Carrie (mother of the bride)" becomes partner2). This table '
  'is their proper home: structured roles, AI confidence, coordinator '
  'override. Q4 decision (Isadora 2026-05-09): Phase 1 storage; Phase 5 '
  'coordinator read panel; Phase 5 polish for Sage prompt feed. '
  'Migration 255.';

COMMENT ON COLUMN public.wedding_relationships.relationship_role IS
  'Structured role label. Values: mother | father | mother_in_law | '
  'father_in_law | sibling | planner | maid_of_honor | best_man | '
  'family_friend | vendor_contact | other. Free-text detail in the '
  '"detail" column for nuance ("groom''s stepmother", "bride''s aunt '
  'who is paying").';

CREATE INDEX IF NOT EXISTS idx_wedding_relationships_wedding_active
  ON public.wedding_relationships (wedding_id, created_at DESC)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_wedding_relationships_venue_active
  ON public.wedding_relationships (venue_id, created_at DESC)
  WHERE is_active = true;

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_wedding_relationships_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wedding_relationships_touch ON public.wedding_relationships;
CREATE TRIGGER trg_wedding_relationships_touch
  BEFORE UPDATE ON public.wedding_relationships
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_wedding_relationships_updated_at();

-- RLS — same shape as wedding_auto_context (mig 253).
ALTER TABLE public.wedding_relationships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wedding_relationships_auth_select" ON public.wedding_relationships;
CREATE POLICY "wedding_relationships_auth_select"
  ON public.wedding_relationships
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "wedding_relationships_auth_insert" ON public.wedding_relationships;
CREATE POLICY "wedding_relationships_auth_insert"
  ON public.wedding_relationships
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "wedding_relationships_auth_update" ON public.wedding_relationships;
CREATE POLICY "wedding_relationships_auth_update"
  ON public.wedding_relationships
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
-- STEP 6 — wedding_auto_context.sensitive + expires_at
-- ============================================================================
-- Emotional truths ("my mum is sick", "stressful job interview", "we lost
-- my grandmother last week") need handling rules different from facts:
--   - sensitive=true: never quoted verbatim by Sage in couple-facing
--     drafts. The brain prompt sees them but the prompt rules forbid
--     direct quotation. Coordinator UI shows a "do not echo" badge.
--   - expires_at: TTL for time-bound truths. "Mom is sick" is true for
--     12 months unless reinforced or pinned. After expiry the row stays
--     in the database (Constitution invariant — never delete) but drops
--     out of the active-context feed.
--
-- 2026-05-09 Isadora directive: capture emotional truths alongside facts.
-- The category was already free-text in mig 253; this adds the two
-- handling-rule columns the brain prompt needs.

ALTER TABLE public.wedding_auto_context
  ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.wedding_auto_context.sensitive IS
  'When true, the brain prompt sees this note in context but is '
  'forbidden from quoting it verbatim. Coordinator UI shows a "do not '
  'echo" badge. Categories that auto-flag sensitive=true: health, grief, '
  'financial_stress, family_conflict, mental_health. Coordinator may '
  'override either way. Migration 255.';

ALTER TABLE public.wedding_auto_context
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMENT ON COLUMN public.wedding_auto_context.expires_at IS
  'TTL for time-bound emotional truths. "Mom is sick" defaults to 12 '
  'months from captured_at unless reinforced or pinned. NULL = no TTL '
  '(default for facts, preferences, family roles). After expiry the row '
  'stays in the DB (Constitution: never delete) but drops out of the '
  'active-context feed surfaced to Sage and the coordinator. Re-detection '
  'of the same body within the dedup window resets expires_at to a new '
  '12-month window. Migration 255.';

-- ============================================================================
-- STEP 7 — partial index on active non-expired auto-context
-- ============================================================================
-- Hot-path index for the brain context loaders + lead-profile feed: only
-- active (is_active=true) non-expired (expires_at IS NULL OR > now())
-- notes participate. Postgres can't use now() in a partial-index predicate
-- (it's not immutable), so the partial filter is just is_active; the
-- expires_at filter happens in the WHERE clause at read time.

CREATE INDEX IF NOT EXISTS idx_wedding_auto_context_sensitive
  ON public.wedding_auto_context (wedding_id)
  WHERE is_active = true AND sensitive = true;

COMMENT ON INDEX public.idx_wedding_auto_context_sensitive IS
  'Sensitive-only fast lookup for the "do not echo" badge feed. Brain '
  'context loaders may want to see sensitive notes in their own pass for '
  'tone-only handling. Migration 255.';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================
-- MIGRATION 256
-- ============================================
-- ---------------------------------------------------------------------------
-- 256_emotional_themes_insight_type.sql
-- ---------------------------------------------------------------------------
-- Wave 1C (2026-05-09). The 15th intelligence detector
-- (`detectEmotionalThemes` in src/lib/services/intel/intelligence-engine.ts)
-- writes rows under insight_type='emotional_theme' / category='emotional'
-- so the venue's strategy surface can read what couples are mentioning
-- beyond logistics. This migration widens the two CHECK constraints to
-- accept the new identifiers.
--
-- Also adds `venue_config.notify_on_sensitive_auto_context` (boolean,
-- default false) — opt-in flag for the real-time admin_notification
-- that fires when a sensitive-tagged auto-context note lands. Off by
-- default per the directive; coordinator turns on per-venue.
--
-- Same DROP+ADD pattern as 144 / 145 / 157 (constraint name discovered
-- via pg_constraint).
--
-- Idempotent. Safe to re-run.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — widen intelligence_insights.insight_type CHECK
-- ============================================================================

-- Postgres normalises `IN (...)` to `ANY (ARRAY[...])` inside
-- pg_get_constraintdef, so a LIKE '%IN%' lookup misses. Drop by
-- known name + fall back to a definition-text search for legacy
-- installs that may have a different constraint name.
DO $$
DECLARE
  con_name text;
BEGIN
  ALTER TABLE public.intelligence_insights
    DROP CONSTRAINT IF EXISTS intelligence_insights_insight_type_check;

  SELECT conname
    INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'public.intelligence_insights'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%insight_type%'
   LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.intelligence_insights DROP CONSTRAINT %I', con_name);
  END IF;

  ALTER TABLE public.intelligence_insights
    ADD CONSTRAINT intelligence_insights_insight_type_check
      CHECK (insight_type IN (
        -- Original 8 (migration 041)
        'correlation', 'anomaly', 'prediction', 'recommendation',
        'benchmark', 'trend', 'risk', 'opportunity',
        -- Phase 4 (migration 080)
        'two_email_dropoff', 'no_response_30d', 'tour_no_show',
        'heat_dropping', 'sustained_silence',
        -- Anomaly category (migration 111)
        'data_anomaly',
        -- Operations (T2 era)
        'operations',
        -- T3 first wave (migration 144)
        'heat_narration',
        'negotiation_state',
        'cohort_match',
        'risk_flag',
        'pricing_elasticity',
        'source_mix_counterfactual',
        'decay_re_engagement',
        -- T3-I (migration 145)
        'coordinator_override_pattern',
        'strength_area_cohort',
        -- T5-θ.1 (migration 157)
        'correlation_narration',
        -- Wave 1C (this migration) — venue-aggregate emotional theme
        -- pulse from the 15th intelligence detector. Reads
        -- wedding_auto_context across all couples and surfaces
        -- wedding-industry-relevant theme uptakes (cultural ceremony
        -- asks doubling, vendor-preference clusters, etc.). Sensitive
        -- categories (health/grief/financial_stress/family_conflict/
        -- mental_health) report counts only — never names couples.
        'emotional_theme'
      ));
END $$;

-- ============================================================================
-- STEP 2 — widen intelligence_insights.category CHECK
-- ============================================================================
-- The detector writes category='emotional' so the dashboard / filters
-- can distinguish theme-pulse rows from operational / market / pricing
-- rows.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'intelligence_insights_category_check'
       AND conrelid = 'public.intelligence_insights'::regclass
  ) THEN
    ALTER TABLE public.intelligence_insights
      DROP CONSTRAINT intelligence_insights_category_check;
  END IF;
END $$;

ALTER TABLE public.intelligence_insights
  ADD CONSTRAINT intelligence_insights_category_check CHECK (category IN (
    'lead_conversion', 'response_time', 'team_performance',
    'pricing', 'seasonal', 'source_attribution', 'couple_behavior',
    'capacity', 'competitive', 'weather', 'market',
    -- Phase 2 (migration 112)
    'operations',
    -- Wave 1C (this migration) — soft-context theme rollups across
    -- couples. Distinct from 'couple_behavior' which is per-couple
    -- behavior modeling; 'emotional' is venue-aggregate.
    'emotional'
  ));

-- ============================================================================
-- STEP 3 — venue_config.notify_on_sensitive_auto_context
-- ============================================================================
-- Opt-in flag. When true, the soft-context writer fires a low-priority
-- admin_notification each time a sensitive=true note lands. Off by
-- default — coordinators may not want a real-time ping every time the
-- AI flags a grief mention. The notification body NEVER contains the
-- note body; only "a sensitive note landed for couple X" with a link
-- to the lead profile.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS notify_on_sensitive_auto_context boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venue_config.notify_on_sensitive_auto_context IS
  'Wave 1C (2026-05-09). When true, fires a low-priority admin_notification '
  'each time a sensitive-tagged auto-context note lands. The notification '
  'never echoes the body, only signals that a sensitive note arrived for '
  'a specific couple. Default false — coordinator opts in per venue.';

NOTIFY pgrst, 'reload schema';

-- ============================================
-- MIGRATION 257
-- ============================================
-- ---------------------------------------------------------------------------
-- 257_weddings_previous_wedding_id.sql
-- ---------------------------------------------------------------------------
-- Identity-capture redesign — Wave 2C: same-person multi-wedding rule.
--
-- Why this exists
-- ---------------
-- The IDENTITY-TRUTH-AUDIT (2026-05-09, Q-C) flagged the Naina-case bug:
-- one human, same email, two RM-codes — RM-0200 (Inquiry) and RM-0204
-- (lost). The resolver missed the link because the WeddingPro close-out
-- on the first wedding arrived on a different from_email shape than the
-- original Knot inquiry, and step 1-3 of the match chain therefore
-- missed. The system minted a fresh wedding for what is, legitimately,
-- a re-engagement after loss.
--
-- The Wave 2C resolver patch closes that gap by attaching to the
-- existing wedding when the matched person has a non-terminal wedding
-- on file. When the person's only wedding is terminal (lost / cancelled
-- / completed), a new arrival CAN mint a fresh wedding (legitimate
-- re-engagement), but the new wedding is linked back to the previous
-- via this column so the coordinator surface can show the history
-- ("RM-0204 is a re-engagement of RM-0200 lost 6 months ago").
--
-- Constitution alignment
-- ----------------------
-- bloom-constitution.md / Point-Zero doctrine: every feature is a view
-- over a single forensic record. Re-engagement after loss is one of the
-- most operationally meaningful states in a venue's funnel — it answers
-- "did our nurture campaign work" — and today that linkage is invisible.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- DROP-then-CREATE on no triggers (none here). Safe to re-run.
--
-- Pre-allocates migration slot 257. Latest is 256.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — weddings.previous_wedding_id
-- ============================================================================
-- Self-FK on weddings.id with ON DELETE SET NULL so a hard-delete on the
-- previous wedding (rare; Constitution prefers tombstones) does not
-- cascade into the re-engagement record. NULL = no previous wedding (the
-- common case). Set by the resolver in Wave 2C when a fresh inquiry
-- mints a new wedding for a person whose only existing wedding is
-- terminal (lost / cancelled / completed).

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS previous_wedding_id uuid
    REFERENCES public.weddings(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.weddings.previous_wedding_id IS
  'Self-FK linking a re-engagement-after-loss wedding back to the previous '
  'wedding for the same person. NULL when no prior wedding exists. Set by '
  'the identity resolver (lib/services/identity/resolver.ts) when a fresh '
  'inquiry from a person whose existing wedding is terminal '
  '(lost / cancelled / completed) mints a new wedding instead of attaching '
  'to the dead one. Lets the coordinator surface render history '
  '("RM-0204 is a re-engagement of RM-0200, lost 2025-11-04"). '
  'Migration 257 (Wave 2C 2026-05-09).';

-- Index — used by the coordinator-side history view ("show me every
-- re-engagement of this lost wedding") and by intel rollups ("how many
-- re-engagements did our Q3 nurture campaign produce"). Partial index
-- because the vast majority of weddings have NULL here.
CREATE INDEX IF NOT EXISTS idx_weddings_previous_wedding
  ON public.weddings (previous_wedding_id)
  WHERE previous_wedding_id IS NOT NULL;

COMMENT ON INDEX public.idx_weddings_previous_wedding IS
  'Partial index supporting "show me re-engagements of this lost wedding" '
  'queries on the coordinator surface. Migration 257.';

COMMIT;

NOTIFY pgrst, 'reload schema';

