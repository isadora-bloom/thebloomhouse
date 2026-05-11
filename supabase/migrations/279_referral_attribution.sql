-- ---------------------------------------------------------------------------
-- 279_referral_attribution.sql  (Wave 14)
-- ---------------------------------------------------------------------------
-- Wave 14 — referral attribution + alumni cohort patterns.
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction is the thesis;
--     a referrer-mention in a couple's body is a forensic linkage to a
--     past couple's identity, NOT a CRM-style "source" string)
--   - bloom-wave4-identity-reconstruction.md (Wave 4 is sealed; Wave 14
--     reads couple_identity_profile after reconstruction completes and
--     extracts referrer mentions as a SIBLING pass, never modifying
--     reconstruct.ts)
--   - bloom-phase-b-decisions.md (attribution_events is the audit row per
--     attribution decision; Wave 14 extends it with referrer_wedding_id
--     so past-couple → new-couple referrals get the same audit treatment
--     as platform-signal → couple resolutions)
--   - feedback_deep_fix_vs_bandaid.md (the LLM judges referrer mentions
--     from full body context, not a regex on "told me about")
--
-- The gap Wave 14 closes
-- ----------------------
-- When a couple's body says "Maya recommended you" or "we heard about
-- you from Jenny", that's a referrer mention. The Wave 4 forensic
-- profile captures it in family_dynamics / cultural_signals / refusals
-- as text, but never writes a structural attribution_event linkage.
-- The long-tail value of past couples driving new bookings is invisible
-- to /intel/sources ROI rollups.
--
-- Alumni cohort: past bookings + their couple_intel.persona_label +
-- conversion signature → archetypes. Surfaces "your typical booked-
-- couple profile" for fresh leads to match against. Aggregate-only —
-- per memory/bloom-data-integrity-sweep.md, alumni rollups NEVER name
-- specific couples (forensic identity disclosure is gated; archetype
-- rollups are operator-safe).
--
-- What this migration does
-- ------------------------
--   1. Extends attribution_events with four columns: referrer_wedding_id
--      (FK to weddings), referrer_confidence_0_100, referrer_evidence_quote,
--      referral_resolved_at.
--   2. New table public.alumni_cohorts — per-venue archetype rollups.
--   3. New queue table public.referral_extraction_jobs — same shape as
--      couple_intel_jobs (mig 261). 24h dedupe at enqueue layer; sweep
--      drains the queue.
--   4. Indexes + RLS + comments.
--
-- Idempotent: every CREATE/ALTER uses IF NOT EXISTS / DROP-then-CREATE.
-- Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — attribution_events column extensions
-- ============================================================================
-- These columns are NULL for every existing row (legacy platform-signal
-- attributions). They populate only for Wave 14 referral-derived rows.
-- The existing constraint requires (candidate_identity_id IS NOT NULL)
-- which would block referral rows; Wave 14 relaxes that constraint to
-- allow EITHER a candidate_identity_id OR a referrer_wedding_id (an
-- attribution row carries one source or the other).

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS referrer_wedding_id uuid
    REFERENCES public.weddings(id) ON DELETE SET NULL;

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS referrer_confidence_0_100 integer
    CHECK (referrer_confidence_0_100 IS NULL
      OR (referrer_confidence_0_100 >= 0
          AND referrer_confidence_0_100 <= 100));

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS referrer_evidence_quote text;

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS referral_resolved_at timestamptz;

-- Free-text fallback when the named referrer didn't match an existing
-- wedding/person yet. Future correlation will rewrite referrer_wedding_id
-- when a match emerges.
ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS referrer_name_text text;

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS referrer_relationship_text text;

COMMENT ON COLUMN public.attribution_events.referrer_wedding_id IS
  'Wave 14. When this attribution row was triggered by a referral '
  'mention in the new couple''s body ("Maya recommended you"), this '
  'is the FK to Maya''s wedding. NULL for legacy platform-signal '
  'attributions. Resolver writes NULL + referrer_name_text when the '
  'named referrer does not match an existing wedding yet (deferred '
  'correlation: a future Wave 14 sweep can re-resolve once the named '
  'person enters the system).';

COMMENT ON COLUMN public.attribution_events.referrer_confidence_0_100 IS
  'Wave 14. Confidence of the LLM extraction of the referrer mention '
  '(0-100). Distinct from `confidence` which is the match-tier '
  'confidence. Both are stored separately for audit.';

COMMENT ON COLUMN public.attribution_events.referrer_evidence_quote IS
  'Wave 14. Verbatim quote from the new couple''s body that triggered '
  'the referrer linkage. Per bloom-constitution.md, every populated '
  'forensic claim carries an evidence_quote.';

COMMENT ON COLUMN public.attribution_events.referral_resolved_at IS
  'Wave 14. Set when resolveReferrer matched the named referrer to an '
  'existing wedding. NULL when the referrer name was recorded but no '
  'match found yet (deferred correlation).';

COMMENT ON COLUMN public.attribution_events.referrer_name_text IS
  'Wave 14. The referrer name as the LLM extracted it from the new '
  'couple''s body. Always populated for Wave 14 rows even when '
  'referrer_wedding_id is NULL (deferred-correlation case).';

COMMENT ON COLUMN public.attribution_events.referrer_relationship_text IS
  'Wave 14. The relationship label the LLM extracted (friend / family '
  'member / past couple / vendor / unknown).';

-- The existing FKs on candidate_identity_id are NOT NULL. Drop and
-- re-add as nullable so Wave 14 referral rows (which never carry a
-- candidate_identity_id) can be inserted. The platform-signal path
-- continues to populate candidate_identity_id; this just stops blocking
-- the referral row shape.
ALTER TABLE public.attribution_events
  ALTER COLUMN candidate_identity_id DROP NOT NULL;

-- Add a CHECK ensuring every row carries either a candidate_identity_id
-- (platform-signal path) OR a referrer_wedding_id (Wave 14 resolved
-- match) OR referrer_name_text (Wave 14 deferred correlation). Drop
-- first so the migration is idempotent.
ALTER TABLE public.attribution_events
  DROP CONSTRAINT IF EXISTS attribution_events_source_present;
ALTER TABLE public.attribution_events
  ADD CONSTRAINT attribution_events_source_present
    CHECK (
      candidate_identity_id IS NOT NULL
      OR referrer_wedding_id IS NOT NULL
      OR referrer_name_text IS NOT NULL
    );

-- Index for "what referrals has wedding X driven?" — surfaces alumni
-- referral count on past-couple lead detail.
CREATE INDEX IF NOT EXISTS idx_attribution_events_referrer_wedding
  ON public.attribution_events (referrer_wedding_id, decided_at DESC)
  WHERE referrer_wedding_id IS NOT NULL AND reverted_at IS NULL;

-- Index for the Wave 14 list endpoint + UI.
CREATE INDEX IF NOT EXISTS idx_attribution_events_venue_referral
  ON public.attribution_events (venue_id, decided_at DESC)
  WHERE referrer_name_text IS NOT NULL AND reverted_at IS NULL;

-- Index for the unresolved-correlation sweep ("rows we recorded a name
-- on but never matched").
CREATE INDEX IF NOT EXISTS idx_attribution_events_referral_unresolved
  ON public.attribution_events (venue_id, decided_at DESC)
  WHERE referrer_wedding_id IS NULL
    AND referrer_name_text IS NOT NULL
    AND reverted_at IS NULL;


-- ============================================================================
-- STEP 2 — alumni_cohorts table
-- ============================================================================
-- Aggregated archetype rollups for past bookings. Per-venue. Each row
-- is one LLM-invented archetype label + its conversion signature +
-- voice principles + outcome summary. Generated by one Sonnet call per
-- venue refresh.
--
-- Aggregate-only contract: alumni_cohorts NEVER names a specific
-- couple. The synthesis layer pulls aggregate stats + persona-label
-- distribution and produces archetype labels (the same discipline as
-- Wave 5A persona discovery, but at the cohort layer).

CREATE TABLE IF NOT EXISTS public.alumni_cohorts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- LLM-discovered archetype label (NOT enum). Examples that might
  -- emerge: "Heritage-Forward Planner Cohort",
  -- "Cost-Conscious Pragmatist Cohort", "Multi-Generational Booker".
  archetype_label text NOT NULL,
  archetype_description text NOT NULL,

  -- How many booked couples this archetype represents at this venue.
  booked_couple_count int NOT NULL DEFAULT 0,

  -- Conversion signature: { typical_first_touch_to_booked_days,
  --                          typical_inquiry_channel_distribution,
  --                          typical_decision_dynamics, ... }
  conversion_signature jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Per-archetype persona distribution from couple_intel.persona_label.
  -- Shape: { "Heritage-Forward Planner": 3, "Cultural-Fusion": 1, ... }
  persona_distribution jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Voice principles for handling a fresh lead that matches this
  -- archetype. Array of imperative-shape strings ("lead with the
  -- multigenerational lawn package", "do not push tour timing").
  voice_principles jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Outcome summary: { typical_booking_value_cents,
  --                     typical_guest_count,
  --                     repeat_referral_likelihood, ... }
  outcome_summary jsonb NOT NULL DEFAULT '{}'::jsonb,

  refreshed_at timestamptz NOT NULL DEFAULT now(),
  prompt_version text NOT NULL,
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.alumni_cohorts IS
  'owner:intel. Wave 14 per-venue alumni archetype rollups. One row '
  'per LLM-discovered archetype. Aggregate-only — NEVER names a '
  'specific couple. Read by /intel/alumni and Sage context for fresh-'
  'lead archetype matching. Refresh trigger: weekly drift sweep + '
  'manual via /api/admin/intel/alumni/generate. Cost target $0.10-$0.20 '
  'per refresh per venue (one Sonnet call). Migration 279.';

COMMENT ON COLUMN public.alumni_cohorts.archetype_label IS
  'LLM-discovered archetype (NOT an enum). If labels drift across '
  'refreshes, that''s expected — Wave 5B-style clustering can stabilise '
  'them later. The label is what the model produced at refresh time.';

COMMENT ON COLUMN public.alumni_cohorts.conversion_signature IS
  'JSON object: typical_first_touch_to_booked_days (int), '
  'typical_inquiry_channel_distribution (jsonb), '
  'typical_decision_dynamics (string). Drives fresh-lead matching: '
  '"this couple looks like the Heritage-Forward Planner cohort which '
  'typically books 47 days after first touch through Knot+email".';

COMMENT ON COLUMN public.alumni_cohorts.persona_distribution IS
  'Persona-label histogram of the booked couples in this archetype, '
  'pulled from couple_intel.persona_label. Lets the UI show "this '
  'archetype is dominated by Heritage-Forward Planners (3/4)".';

COMMENT ON COLUMN public.alumni_cohorts.voice_principles IS
  'Imperative-shape strings: how Sage should handle a fresh lead that '
  'matches this archetype. Per bloom-may9-llm-vs-template.md, these '
  'are LLM-derived from booked-couple voice data, not templates.';

CREATE INDEX IF NOT EXISTS idx_alumni_cohorts_venue_refreshed
  ON public.alumni_cohorts (venue_id, refreshed_at DESC);


-- ============================================================================
-- STEP 3 — referral_extraction_jobs queue
-- ============================================================================
-- Same shape as couple_intel_jobs (mig 261). Worker drains via the cron
-- dispatcher /api/cron?job=referral_extraction_sweep (TODO comment in
-- sweep.ts — cron registration deferred per Wave 14 boundary).

CREATE TABLE IF NOT EXISTS public.referral_extraction_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text,
  -- Outcome summary (audit). Shape:
  --   { mentions_extracted: int, resolved: int, deferred: int }
  result_summary jsonb
);

COMMENT ON TABLE public.referral_extraction_jobs IS
  'owner:intel. Wave 14 referral-extraction queue. Enqueue triggers: '
  '(a) Wave 4 reconstruct.ts (TODO_HOOK — wired after merge), '
  '(b) /api/admin/intel/referrals/extract per wedding, '
  '(c) referral_extraction_sweep cron drift refresh (>30d old). 24h '
  'dedupe per wedding at the enqueue layer. Worker drains 10 jobs per '
  'tick. Migration 279.';

CREATE INDEX IF NOT EXISTS idx_referral_extraction_jobs_dequeue
  ON public.referral_extraction_jobs (status, enqueued_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_referral_extraction_jobs_wedding
  ON public.referral_extraction_jobs (wedding_id, enqueued_at DESC);


-- ============================================================================
-- STEP 4 — RLS (mirrors couple_intel + couple_intel_jobs patterns)
-- ============================================================================

ALTER TABLE public.alumni_cohorts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alumni_cohorts_auth_select"
  ON public.alumni_cohorts;
CREATE POLICY "alumni_cohorts_auth_select"
  ON public.alumni_cohorts
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "alumni_cohorts_auth_insert"
  ON public.alumni_cohorts;
CREATE POLICY "alumni_cohorts_auth_insert"
  ON public.alumni_cohorts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "alumni_cohorts_auth_update"
  ON public.alumni_cohorts;
CREATE POLICY "alumni_cohorts_auth_update"
  ON public.alumni_cohorts
  FOR UPDATE
  TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "alumni_cohorts_auth_delete"
  ON public.alumni_cohorts;
CREATE POLICY "alumni_cohorts_auth_delete"
  ON public.alumni_cohorts
  FOR DELETE
  TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "demo_anon_select" ON public.alumni_cohorts;
CREATE POLICY "demo_anon_select" ON public.alumni_cohorts
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));


ALTER TABLE public.referral_extraction_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "referral_extraction_jobs_auth_select"
  ON public.referral_extraction_jobs;
CREATE POLICY "referral_extraction_jobs_auth_select"
  ON public.referral_extraction_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "referral_extraction_jobs_auth_insert"
  ON public.referral_extraction_jobs;
CREATE POLICY "referral_extraction_jobs_auth_insert"
  ON public.referral_extraction_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "referral_extraction_jobs_auth_update"
  ON public.referral_extraction_jobs;
CREATE POLICY "referral_extraction_jobs_auth_update"
  ON public.referral_extraction_jobs
  FOR UPDATE
  TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );


COMMIT;

NOTIFY pgrst, 'reload schema';
