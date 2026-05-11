-- ============================================================================
-- Migration 281 — Wave 13: tour-prep brief + post-tour Sage + review solicit.
-- ============================================================================
--
-- Anchor docs (~/.claude memory/):
--   - bloom-constitution.md (forensic identity reconstruction; voice-shape
--     output never echoes sensitive evidence_quote verbatim)
--   - bloom-wave4-identity-reconstruction.md (signal-driven enqueue +
--     queue-drain via cron pattern — same shape as
--     identity_reconstruction_jobs and couple_intel_jobs)
--   - feedback_deep_fix_vs_bandaid.md (LLM judges soft transitions;
--     deterministic for clear ones — Wave 13 deterministic rules pick
--     target review channel from couple handles; Sonnet writes the
--     personalised draft)
--
-- WHAT THIS ADDS
-- --------------
-- Wave 13 extends three existing surfaces:
--   * tour_outcome_classifier already classifies tours into
--     completed/cancelled/no_show. Wave 13 adds a PRE-tour brief
--     auto-generated 24h before the tour (so the coordinator walks in
--     prepared) and a POST-tour Sage follow-up draft (personalised to
--     what was discussed in the brief + the tour outcome).
--   * post_event_feedback_check already notifies on event T+3 days.
--     Wave 13 adds a sibling pipeline that drafts a personalised
--     review-solicitation email (subject, body, target channel) for
--     coordinator review. Dedupes per couple per 30 days. Reconciles
--     when a matching review lands.
--
-- Tables added by this migration:
--   1. tour_prep_briefs              — one row per tour, ~24h pre-tour
--   2. tour_prep_jobs                — fan-out queue
--   3. post_tour_followup_jobs       — fan-out queue (tour_completed → draft)
--   4. review_solicit_requests       — one row per solicitation attempt
--   5. review_solicit_jobs           — fan-out queue
--
-- Plus one tiny schema fixup: reviews.wedding_id is referenced by
-- state-machine.ts (Wave 11) and is the join column we need to
-- reconcile a received review to a solicitation request. The reviews
-- table (mig 031) never carried wedding_id — adding it here closes
-- the dangling reference and powers Wave 13 reconciliation.
--
-- Idempotent: every CREATE / ADD uses IF NOT EXISTS or DROP-THEN-CREATE.
-- Permissive RLS matches the 225/226/246/261/278 doctrine — venue scope
-- owned upstream by membership context.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 0 — reviews.wedding_id (Wave 11 referenced; Wave 13 reconciles by it)
-- ----------------------------------------------------------------------------
-- Nullable. Most existing review rows have no wedding linkage and stay
-- that way; backfill is opportunistic via Wave 13 reconciliation when a
-- reviewer name matches an outstanding solicitation request.

ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reviews_wedding_id
  ON public.reviews (wedding_id)
  WHERE wedding_id IS NOT NULL;

COMMENT ON COLUMN public.reviews.wedding_id IS
  'Wave 13 (migration 281). Optional linkage from a public review back '
  'to the couple_id / wedding it celebrates. Filled by reconcileReceived'
  'ReviewWithSolicitation when a review lands matching a pending '
  'review_solicit_requests row. Also satisfies the existing reviewExists'
  '() probe in lib/services/lifecycle/state-machine.ts.';

-- ----------------------------------------------------------------------------
-- STEP 1 — tour_prep_briefs
-- ----------------------------------------------------------------------------
-- One row per tour (UNIQUE on tour_id). Sonnet writes a structured brief
-- ~24h before the tour so the coordinator walks in knowing what to lead
-- with and what to avoid. Sensitive themes are voice-shaping only —
-- sensitivity_flags carry handle_with guidance, NOT verbatim
-- evidence_quote (universal-rules SOFT-CONTEXT NOTES POLICY).

CREATE TABLE IF NOT EXISTS public.tour_prep_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id uuid NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  brief_jsonb jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  sent_to_coordinator_at timestamptz,
  viewed_at timestamptz,
  prompt_version text,
  cost_cents numeric(10,4) NOT NULL DEFAULT 0
);

-- One brief per tour. Re-runs overwrite the same row via upsert on
-- tour_id; the unique constraint is what makes that safe.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tour_prep_briefs_tour
  ON public.tour_prep_briefs (tour_id);

CREATE INDEX IF NOT EXISTS idx_tour_prep_briefs_venue_generated
  ON public.tour_prep_briefs (venue_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tour_prep_briefs_wedding
  ON public.tour_prep_briefs (wedding_id)
  WHERE wedding_id IS NOT NULL;

COMMENT ON TABLE public.tour_prep_briefs IS
  'Wave 13. Sonnet-generated brief delivered ~24h before each tour. '
  'Structured jsonb: { key_facts, sensitivity_flags, persona_summary, '
  'what_to_lead_with, what_to_avoid, recent_signals_summary, '
  'recommended_questions, expected_concerns }. Sensitive themes are '
  'voice-shape only — verbatim evidence_quote NEVER persisted in '
  'sensitivity_flags. Migration 281.';

ALTER TABLE public.tour_prep_briefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_tour_prep_briefs" ON public.tour_prep_briefs;
CREATE POLICY "auth_select_tour_prep_briefs"
  ON public.tour_prep_briefs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_tour_prep_briefs" ON public.tour_prep_briefs;
CREATE POLICY "auth_insert_tour_prep_briefs"
  ON public.tour_prep_briefs
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_tour_prep_briefs" ON public.tour_prep_briefs;
CREATE POLICY "auth_update_tour_prep_briefs"
  ON public.tour_prep_briefs
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- STEP 2 — tour_prep_jobs queue
-- ----------------------------------------------------------------------------
-- Same shape as identity_reconstruction_jobs / couple_intel_jobs /
-- lifecycle_transition_jobs. Enqueue triggers: Wave 11 stage-transition
-- to tour_scheduled, plus the daily sweep that finds tours in the next
-- 24-48h without a brief.

CREATE TABLE IF NOT EXISTS public.tour_prep_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id uuid NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

CREATE INDEX IF NOT EXISTS idx_tour_prep_jobs_dequeue
  ON public.tour_prep_jobs (status, enqueued_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_tour_prep_jobs_tour
  ON public.tour_prep_jobs (tour_id, enqueued_at DESC);

ALTER TABLE public.tour_prep_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_tour_prep_jobs" ON public.tour_prep_jobs;
CREATE POLICY "auth_select_tour_prep_jobs"
  ON public.tour_prep_jobs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_tour_prep_jobs" ON public.tour_prep_jobs;
CREATE POLICY "auth_insert_tour_prep_jobs"
  ON public.tour_prep_jobs
  FOR INSERT TO authenticated WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- STEP 3 — post_tour_followup_jobs queue
-- ----------------------------------------------------------------------------
-- Fan-out target for Wave 11 stage transition to tour_completed. Drains
-- to generatePostTourFollowUp which writes a draft into the existing
-- drafts table for coordinator review (NOT auto-sent).

CREATE TABLE IF NOT EXISTS public.post_tour_followup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id uuid NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  draft_id uuid REFERENCES public.drafts(id) ON DELETE SET NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

CREATE INDEX IF NOT EXISTS idx_post_tour_followup_jobs_dequeue
  ON public.post_tour_followup_jobs (status, enqueued_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_post_tour_followup_jobs_tour
  ON public.post_tour_followup_jobs (tour_id, enqueued_at DESC);

ALTER TABLE public.post_tour_followup_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_post_tour_followup_jobs" ON public.post_tour_followup_jobs;
CREATE POLICY "auth_select_post_tour_followup_jobs"
  ON public.post_tour_followup_jobs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_post_tour_followup_jobs" ON public.post_tour_followup_jobs;
CREATE POLICY "auth_insert_post_tour_followup_jobs"
  ON public.post_tour_followup_jobs
  FOR INSERT TO authenticated WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- STEP 4 — review_solicit_requests
-- ----------------------------------------------------------------------------
-- One row per solicitation attempt. status tracks the lifecycle:
--   queued           — drafted but not yet sent to coordinator review
--                      (Wave 13 never auto-sends; the draft goes to drafts)
--   sent             — coordinator approved + sent the email
--   review_received  — reconcileReceivedReviewWithSolicitation matched a
--                      live review to this attempt; review_id linked
--   declined         — coordinator dismissed (do not send)
--   no_response      — sent but no review arrived after the dedupe window
--
-- target_channel records the platform we routed the couple to (knot /
-- weddingwire / google / other). Deterministic rule: pick first match
-- among couple.handles (Wave 4 profile) → Knot/WW handle wins, else
-- generic Google.

CREATE TABLE IF NOT EXISTS public.review_solicit_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  tour_id uuid REFERENCES public.tours(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'review_received', 'declined', 'no_response')),
  target_channel text NOT NULL,
  review_link_url text,
  subject text,
  body text,
  draft_id uuid REFERENCES public.drafts(id) ON DELETE SET NULL,
  review_id uuid REFERENCES public.reviews(id) ON DELETE SET NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  response_received_at timestamptz,
  prompt_version text,
  cost_cents numeric(10,4) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_review_solicit_requests_venue_status
  ON public.review_solicit_requests (venue_id, status, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_solicit_requests_wedding
  ON public.review_solicit_requests (wedding_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_solicit_requests_tour
  ON public.review_solicit_requests (tour_id)
  WHERE tour_id IS NOT NULL;

COMMENT ON TABLE public.review_solicit_requests IS
  'Wave 13. One row per review-solicitation attempt. Personalised '
  'Sonnet draft routed to coordinator approval via drafts; status flows '
  'queued → sent → (review_received | no_response | declined). '
  'reconcileReceivedReviewWithSolicitation links review_id when a '
  'received review matches an outstanding request. Dedupes per couple '
  'per 30d. Migration 281.';

ALTER TABLE public.review_solicit_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_review_solicit_requests" ON public.review_solicit_requests;
CREATE POLICY "auth_select_review_solicit_requests"
  ON public.review_solicit_requests
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_review_solicit_requests" ON public.review_solicit_requests;
CREATE POLICY "auth_insert_review_solicit_requests"
  ON public.review_solicit_requests
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_review_solicit_requests" ON public.review_solicit_requests;
CREATE POLICY "auth_update_review_solicit_requests"
  ON public.review_solicit_requests
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- STEP 5 — review_solicit_jobs queue
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.review_solicit_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  request_id uuid REFERENCES public.review_solicit_requests(id) ON DELETE SET NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

CREATE INDEX IF NOT EXISTS idx_review_solicit_jobs_dequeue
  ON public.review_solicit_jobs (status, enqueued_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_review_solicit_jobs_wedding
  ON public.review_solicit_jobs (wedding_id, enqueued_at DESC);

ALTER TABLE public.review_solicit_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_review_solicit_jobs" ON public.review_solicit_jobs;
CREATE POLICY "auth_select_review_solicit_jobs"
  ON public.review_solicit_jobs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_review_solicit_jobs" ON public.review_solicit_jobs;
CREATE POLICY "auth_insert_review_solicit_jobs"
  ON public.review_solicit_jobs
  FOR INSERT TO authenticated WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- STEP 6 — NOTIFY pgrst (refresh REST schema cache)
-- ----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

COMMIT;
