-- ---------------------------------------------------------------------------
-- 274_discovery_feedback.sql
-- ---------------------------------------------------------------------------
-- Wave 7D — discovery surface + feedback loop.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 7D closes the discovery loop. Wave 7A
--     hunts unknown-unknowns; Wave 7C validates them; Wave 7D writes
--     validated discoveries BACK into Wave 5/6 consuming systems so the
--     intelligence stack incorporates the insight automatically.)
--   - bloom-wave4-5-6-master-plan.md (Wave 7D spec — discoveries page
--     becomes a coordinator workspace + weekly digest of new discoveries.)
--   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Discovery
--     feedback writes never name couples; payloads are anonymised
--     aggregates / channel labels / persona labels only.)
--   - feedback_parallel_stream_safety.md (Wave 7D holds migration 274.
--     Wave 6D=273. Wave 7C=272. We don't restructure existing columns.)
--
-- Why this migration exists
-- -------------------------
-- Wave 7C populates `intel_discoveries.validation_status='validated'`
-- but until now nothing closed the loop into Wave 5/6. Wave 7D introduces
-- a feedback-loop service that maps each validated discovery's
-- hypothesis_category to a consuming system (attribution_role_jobs /
-- venue_intel.rollup / persona_channel_rollups / marketing_recommendations
-- / intel_matches / couple_intel / tag-only) and writes the insight
-- back. This migration provides:
--
--   * intel_discoveries.feedback_applied_at — set when feedback writes
--     completed for a validated discovery.
--   * discovery_feedback_actions — audit log of every feedback write.
--     Each row records target_system + action_type + payload + error.
--     Lets the dashboard show "we did X to Y systems" per discovery.
--   * discovery_digests — weekly digest table sibling to marketing_digests.
--     Per (venue, week) one row capturing top validated + top pending
--     high-confidence discoveries this week. Sonnet narrates ~$0.04.
--
-- Idempotent: every CREATE TABLE / ALTER TABLE / CREATE INDEX / CREATE
-- POLICY uses IF NOT EXISTS or DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — extend intel_discoveries with feedback-applied tracking
-- ============================================================================

ALTER TABLE public.intel_discoveries
  ADD COLUMN IF NOT EXISTS feedback_applied_at timestamptz;

COMMENT ON COLUMN public.intel_discoveries.feedback_applied_at IS
  'Wave 7D (mig 274). Set when applyDiscoveryFeedback completed for this '
  'discovery (writes to consuming Wave 5/6 systems landed). NULL = '
  'feedback not yet applied. The Wave 7A sweep checks for newly-validated '
  'rows with NULL feedback_applied_at and fires applyDiscoveryFeedback '
  'as a non-fatal post-validation hook.';

-- ============================================================================
-- STEP 2 — discovery_feedback_actions (audit log of every feedback write)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.discovery_feedback_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE: the discovery is the primary entity; deleting it
  -- removes its feedback audit trail.
  discovery_id uuid NOT NULL
    REFERENCES public.intel_discoveries(id) ON DELETE CASCADE,
  -- Denormalised so RLS + per-venue indexes don't need a join.
  venue_id uuid NOT NULL
    REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Which Wave 5/6 system received the write. Free-text so new mappings
  -- can land without a migration. Standard values:
  --   'attribution_role_jobs'             — enqueue role re-classification
  --   'venue_intel.service_demand_map'    — upsert vendor partner section
  --   'venue_intel.timing_patterns'       — flag/tag timing observation
  --   'venue_intel.over_indexed_personas' — upsert demographic clustering
  --   'persona_channel_rollups'           — tag a cell with a discovery
  --   'marketing_recommendations'         — create recommendation seed
  --   'intel_matches'                     — upsert competitor signal
  --   'couple_intel'                      — enqueue refresh for couples
  --   'tag_only'                          — record-only (LLM-invented
  --                                          category we don't auto-write)
  target_system text NOT NULL,
  -- What was done.
  --   'enqueue' — wrote a row to a queue table (work to be done later)
  --   'upsert'  — created or updated an aggregate row directly
  --   'tag'     — annotated an existing row in place
  --   'flag'    — added a flag entry (timing_patterns, etc.)
  action_type text NOT NULL
    CHECK (action_type IN ('enqueue', 'upsert', 'tag', 'flag')),
  -- The actual payload that was written. Anonymised aggregate shapes only;
  -- channel labels, persona labels, counts, lift_pct numbers — never
  -- per-couple identifiers. Free-form jsonb because each target_system
  -- has its own shape.
  payload jsonb,
  written_at timestamptz NOT NULL DEFAULT now(),
  -- Set when the feedback write failed. NULL on success. Lets the
  -- dashboard show partial-failure state when applyDiscoveryFeedback
  -- caught an error per-action and continued (the service layer does
  -- per-action try/catch so one failure doesn't abort the rest).
  error text
);

COMMENT ON TABLE public.discovery_feedback_actions IS
  'owner:agent. Wave 7D feedback-loop audit log. One row per write a '
  'validated intel_discovery generated against a Wave 5/6 consuming '
  'system. target_system is free-text (not enum) so new mappings land '
  'without a migration. payload is anonymised aggregate shapes; NEVER '
  'contains couple names. error is set on per-action failure (the '
  'feedback service runs each mapping in its own try/catch). Migration 274.';

COMMENT ON COLUMN public.discovery_feedback_actions.target_system IS
  'Wave 7D (mig 274). Free-text label of the consuming system that '
  'received the feedback write. Standard values: attribution_role_jobs | '
  'venue_intel.service_demand_map | venue_intel.timing_patterns | '
  'venue_intel.over_indexed_personas | persona_channel_rollups | '
  'marketing_recommendations | intel_matches | couple_intel | tag_only. '
  'New mappings land via the code-side mapping table without a migration.';

COMMENT ON COLUMN public.discovery_feedback_actions.action_type IS
  'Wave 7D (mig 274). enqueue=row added to a worker queue (later async '
  'work). upsert=aggregate row created or updated directly. tag='
  'annotation added to an existing row in place. flag=flag-shaped entry '
  'added (e.g. into venue_intel.timing_patterns).';

COMMENT ON COLUMN public.discovery_feedback_actions.payload IS
  'Wave 7D (mig 274). The actual data written. Anonymised aggregate '
  'shapes only — channel labels, persona labels, counts, percentages. '
  'Aggregate ≠ disclose: NEVER includes couple names. Free-form jsonb '
  'because each target_system has its own shape; readers should '
  'discriminate on target_system before unpacking.';

COMMENT ON COLUMN public.discovery_feedback_actions.error IS
  'Wave 7D (mig 274). NULL on success. Set when this single feedback '
  'write failed; applyDiscoveryFeedback runs each mapping in its own '
  'try/catch and surfaces partial failure here without aborting the '
  'rest. Operator override path can re-try via /api/admin/intel/'
  'discoveries/{id}/apply-feedback.';

-- Per-discovery audit history: most recent action first.
CREATE INDEX IF NOT EXISTS idx_discovery_feedback_actions_discovery
  ON public.discovery_feedback_actions (discovery_id, written_at DESC);

COMMENT ON INDEX public.idx_discovery_feedback_actions_discovery IS
  'Per-discovery audit history. Drives /api/admin/intel/discoveries/{id}/'
  'feedback-actions and the dashboard per-card feedback section.';

-- Per-venue + per-target-system slice: drives "which systems received
-- feedback this week" rollups.
CREATE INDEX IF NOT EXISTS idx_discovery_feedback_actions_venue_target
  ON public.discovery_feedback_actions (venue_id, target_system);

COMMENT ON INDEX public.idx_discovery_feedback_actions_venue_target IS
  'Per-venue per-target-system rollup. Drives the discovery digest "key '
  'feedback actions taken" section and operator overview chips.';

-- ============================================================================
-- STEP 3 — discovery_digests (weekly digest sibling to marketing_digests)
-- ============================================================================
-- Mirrors marketing_digests shape (venue, period_start, period_end,
-- digest_jsonb, cost_cents, prompt_version, generated_at). Sonnet
-- narrates the week's discoveries (top validated + top pending +
-- key feedback actions). Refuses when there's nothing to narrate.

CREATE TABLE IF NOT EXISTS public.discovery_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  digest_period_start date NOT NULL,
  digest_period_end date NOT NULL,
  -- Standard shape (the prompt enforces): {
  --   headline, this_week_in_3_sentences,
  --   top_validated_discoveries: [{ title, summary }],
  --   top_pending_high_confidence: [{ title, confidence_0_100 }],
  --   key_feedback_actions: [{ target_system, action_type, count }],
  --   refusal: string | null
  -- }
  digest_jsonb jsonb NOT NULL,
  -- Delivery state (mirrors marketing_digests).
  delivered_via text,
  delivered_at timestamptz,
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  prompt_version text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.discovery_digests IS
  'owner:agent. Wave 7D weekly discovery digest. One row per (venue, '
  'week). Sibling to marketing_digests (mig 273) but content is '
  'discovery-focused: top validated discoveries, top pending high-'
  'confidence ones, key feedback actions taken. Sonnet narrates the '
  'week. Refuses with "no validated discoveries this week" when the '
  'evidence block is empty rather than fabricating optimism. '
  'Migration 274.';

-- Idempotency: re-running the builder for the same week REPLACES
-- digest_jsonb. The unique index makes (venue, week) the natural identity.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_discovery_digests_period
  ON public.discovery_digests (venue_id, digest_period_start, digest_period_end);

COMMENT ON INDEX public.uniq_discovery_digests_period IS
  'Wave 7D (mig 274). Identity of a digest = (venue, week). Re-running '
  'the builder upserts on this constraint so the audit trail keeps one '
  'row per week, with cost_cents reflecting the most recent build.';

CREATE INDEX IF NOT EXISTS idx_discovery_digests_venue_recent
  ON public.discovery_digests (venue_id, generated_at DESC);

COMMENT ON INDEX public.idx_discovery_digests_venue_recent IS
  'Wave 7D (mig 274). Dashboard list path: most recent digests for a '
  'venue, newest first.';

-- ============================================================================
-- STEP 4 — RLS (mirrors intel_discoveries pattern, scoped on venue_id)
-- ============================================================================

ALTER TABLE public.discovery_feedback_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "discovery_feedback_actions_auth_select"
  ON public.discovery_feedback_actions;
CREATE POLICY "discovery_feedback_actions_auth_select"
  ON public.discovery_feedback_actions
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "discovery_feedback_actions_auth_insert"
  ON public.discovery_feedback_actions;
CREATE POLICY "discovery_feedback_actions_auth_insert"
  ON public.discovery_feedback_actions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

ALTER TABLE public.discovery_digests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "discovery_digests_auth_select"
  ON public.discovery_digests;
CREATE POLICY "discovery_digests_auth_select"
  ON public.discovery_digests
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "discovery_digests_auth_insert"
  ON public.discovery_digests;
CREATE POLICY "discovery_digests_auth_insert"
  ON public.discovery_digests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "discovery_digests_auth_update"
  ON public.discovery_digests;
CREATE POLICY "discovery_digests_auth_update"
  ON public.discovery_digests
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
