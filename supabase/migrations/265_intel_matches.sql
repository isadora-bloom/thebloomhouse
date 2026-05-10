-- ---------------------------------------------------------------------------
-- 265_intel_matches.sql
-- ---------------------------------------------------------------------------
-- Wave 5C — external-signal matching layer.
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction is the thesis;
--     Wave 5C matches each external signal — cultural moments, vendor
--     mentions in couple bodies, regional benchmarks, competitor mentions,
--     cross-platform Knot/WeddingWire activity per Tenant 2 handles —
--     against the venue's couple cohort and surfaces actionable matches).
--   - bloom-wave4-5-6-master-plan.md (5C spec: per-couple AND per-cohort
--     matching, evidence chains, scored by cohort fit, daily ~$1/venue).
--   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Sensitive
--     evidence quotes never reach the cohort-level surface).
--   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
--     must be backed by a real callAI; Wave 5C is forensic-rule first
--     with LLM scoring for ambiguous-fit cases).
--
-- Why this migration exists
-- -------------------------
-- Wave 4 produced WHO each couple is. Wave 5A produced WHAT to do per
-- couple. Wave 5B aggregated the cohort. Wave 5C closes the loop on
-- external signals: every cultural moment, vendor mention, regional
-- benchmark, competitor mention, and cross-platform handle activity gets
-- matched per-couple AND per-cohort. Output: actionable matches with
-- evidence chains, scored by cohort fit using Wave 5B's persona
-- distribution.
--
-- Storage shape:
--   * intel_matches — one row per (signal × scope) match. wedding_id
--     NULL when the match is venue/cohort-level rather than couple-level.
--   * intel_match_jobs — queue table mirroring identity_reconstruction_jobs
--     + venue_intel_jobs (Wave 4 + 5B pattern).
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — intel_matches (one row per signal × scope match)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intel_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- NULL when match is cohort-level (venue-wide signal); set when
  -- match attaches to a specific couple.
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE CASCADE,
  -- Signal type drives which extractor produced the match. Free-text +
  -- CHECK so new types can land without a migration after vetting.
  signal_type text NOT NULL CHECK (signal_type IN (
    'cultural_moment',
    'vendor_mention',
    'regional_benchmark',
    'competitor_mention',
    'cross_platform_handle'
  )),
  -- The external signal that matched (cultural_moments row, vendor name
  -- + occurrence count, regional benchmark snapshot, competitor name +
  -- evidence pointers, handle + platform activity descriptor).
  signal_payload jsonb NOT NULL,
  -- LLM-generated when scoring required synthesis (cultural-moment
  -- cohort-fit assessment); null for forensic-rule matches (exact
  -- vendor-name match across N profiles).
  match_reasoning text,
  match_confidence_0_100 integer NOT NULL CHECK (
    match_confidence_0_100 >= 0 AND match_confidence_0_100 <= 100
  ),
  -- How relevant this signal is to the venue's couple cohort. Wave 5B's
  -- persona distribution informs this. Null when scoring not applicable
  -- (e.g. a couple-specific vendor mention is intrinsically cohort-fit).
  cohort_fit_score_0_100 integer CHECK (
    cohort_fit_score_0_100 IS NULL OR (
      cohort_fit_score_0_100 >= 0 AND cohort_fit_score_0_100 <= 100
    )
  ),
  -- Array of evidence quotes that triggered the match. Each entry is
  -- jsonb { quote, source, source_id?, sensitive?: bool }. Sensitive
  -- entries are stripped before they reach the cohort-level UI; the
  -- per-couple panel may reveal them based on
  -- venue_config.feature_flags.reveal_sensitive_themes.
  evidence_quotes jsonb,
  fired_at timestamptz NOT NULL DEFAULT now(),
  -- Coordinator triage state.
  dismissed_at timestamptz,
  dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dismissal_reason text,
  actioned_at timestamptz,
  -- Free-text label of what the coordinator did with the match. Common
  -- values: 'sent_to_couple' | 'added_to_marketing' | 'shared_with_team'
  -- | 'investigated' | 'ignored'.
  action_taken text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.intel_matches IS
  'owner:agent. Wave 5C external-signal match layer. One row per signal-'
  'scope match: signal_type defines the source (cultural_moment / '
  'vendor_mention / regional_benchmark / competitor_mention / '
  'cross_platform_handle); wedding_id NULL when match is cohort-level. '
  'Scored by match_confidence_0_100 (likelihood the signal applies) and '
  'cohort_fit_score_0_100 (how much the venue cohort cares). New evidence '
  'creates a NEW row — preserves audit history. Coordinator triage via '
  'dismissed_at + actioned_at. Migration 265.';

COMMENT ON COLUMN public.intel_matches.wedding_id IS
  'Couple this match attaches to. NULL when the match is cohort-level '
  '(e.g. a regional benchmark insight or a cohort-fit-scored cultural '
  'moment that applies venue-wide).';

COMMENT ON COLUMN public.intel_matches.signal_payload IS
  'The external signal in compact form. For cultural_moment: the '
  'cultural_moments row id + title + start_at. For vendor_mention: '
  '{ vendor_name, vendor_type, occurrences_count }. For regional_benchmark: '
  'the comparison snapshot. For competitor_mention: { competitor_name, '
  'mention_count, sample_couples }. For cross_platform_handle: '
  '{ platform, handle, activity_descriptor }.';

COMMENT ON COLUMN public.intel_matches.match_reasoning IS
  'LLM-generated reasoning when scoring required synthesis (typically '
  'cultural-moment cohort-fit). NULL for forensic-rule matches where the '
  'rule itself IS the reasoning (e.g. "3+ couples mentioned vendor X").';

COMMENT ON COLUMN public.intel_matches.cohort_fit_score_0_100 IS
  'How relevant this signal is to the venue cohort. Bias from Wave 5B '
  'persona distribution. NULL when the match is intrinsically cohort-fit '
  '(per-couple vendor mention) or scoring is not yet implemented for the '
  'signal_type.';

COMMENT ON COLUMN public.intel_matches.evidence_quotes IS
  'Array of jsonb { quote, source, source_id?, sensitive?: bool }. '
  'Sensitive entries are stripped before reaching cohort-level UI. The '
  'per-couple panel may reveal them based on venue_config.feature_flags.'
  'reveal_sensitive_themes.';

-- Active-matches index. Most-common query pattern: dashboard renders
-- recent active (non-dismissed) matches sorted newest-first.
CREATE INDEX IF NOT EXISTS idx_intel_matches_active_recent
  ON public.intel_matches (venue_id, fired_at DESC)
  WHERE dismissed_at IS NULL;

COMMENT ON INDEX public.idx_intel_matches_active_recent IS
  'Dashboard list path: recent active matches per venue, newest first.';

-- Per-signal-type slice. Dashboard tabs filter by signal_type.
CREATE INDEX IF NOT EXISTS idx_intel_matches_by_type
  ON public.intel_matches (venue_id, signal_type, fired_at DESC);

COMMENT ON INDEX public.idx_intel_matches_by_type IS
  'Per-signal-type tabs. Cultural Moments / Vendor Opportunities / '
  'Regional Benchmarks / Competitor Mentions / Cross-Platform Activity.';

-- Per-couple matches. Lead detail panel queries this slice.
CREATE INDEX IF NOT EXISTS idx_intel_matches_by_wedding
  ON public.intel_matches (wedding_id, fired_at DESC)
  WHERE wedding_id IS NOT NULL;

COMMENT ON INDEX public.idx_intel_matches_by_wedding IS
  'Per-couple slice for the lead-detail Wave 5C panel.';

-- Idempotency lookup: same (venue, signal_type, signal_payload digest,
-- wedding_id) within 30 days = skip insert. The writer hashes the
-- signal_payload + wedding_id and compares against rows fired within
-- that window.

-- ============================================================================
-- STEP 2 — intel_match_jobs (queue table — mirrors venue_intel_jobs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intel_match_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Optional couple scope — when set, the scan is per-couple (triggered
  -- by reconstruct.ts after a profile change). When null, scan is
  -- venue-wide (drift refresh).
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.intel_match_jobs IS
  'owner:agent. Wave 5C external-signal match queue. Enqueue triggers: '
  '(a) reconstruct.ts after couple_identity_profile upsert, with wedding_id '
  'set; (b) drift_refresh from external_match_sweep cron, venue-level; '
  '(c) admin_backfill via /api/admin/intel/external-matches/scan with '
  'force=true. Worker drains 5 jobs per tick. Migration 265.';

COMMENT ON COLUMN public.intel_match_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text: profile_change | drift_refresh | '
  'admin_backfill | manual_force.';

CREATE INDEX IF NOT EXISTS idx_intel_match_jobs_dequeue
  ON public.intel_match_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_intel_match_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=queued LIMIT 5.';

CREATE INDEX IF NOT EXISTS idx_intel_match_jobs_venue
  ON public.intel_match_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_intel_match_jobs_venue IS
  'Per-venue 24h dedupe lookup mirrors Wave 4 + 5A + 5B queue patterns.';

-- ============================================================================
-- STEP 3 — RLS (mirrors venue_intel pattern, scoped on venue_id)
-- ============================================================================

ALTER TABLE public.intel_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intel_matches_auth_select"
  ON public.intel_matches;
CREATE POLICY "intel_matches_auth_select"
  ON public.intel_matches
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_matches_auth_insert"
  ON public.intel_matches;
CREATE POLICY "intel_matches_auth_insert"
  ON public.intel_matches
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_matches_auth_update"
  ON public.intel_matches;
CREATE POLICY "intel_matches_auth_update"
  ON public.intel_matches
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

ALTER TABLE public.intel_match_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intel_match_jobs_auth_select"
  ON public.intel_match_jobs;
CREATE POLICY "intel_match_jobs_auth_select"
  ON public.intel_match_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_match_jobs_auth_insert"
  ON public.intel_match_jobs;
CREATE POLICY "intel_match_jobs_auth_insert"
  ON public.intel_match_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_match_jobs_auth_update"
  ON public.intel_match_jobs;
CREATE POLICY "intel_match_jobs_auth_update"
  ON public.intel_match_jobs
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

COMMIT;

NOTIFY pgrst, 'reload schema';
