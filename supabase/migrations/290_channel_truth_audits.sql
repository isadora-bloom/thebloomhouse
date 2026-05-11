-- ---------------------------------------------------------------------------
-- 290_channel_truth_audits.sql
-- ---------------------------------------------------------------------------
-- Wave 24 — Channel Truth Report (narrated-intelligence surface).
--
-- Anchor docs:
--   - feedback_measure_dont_assume.md (system MEASURES; doesn't validate
--     a pre-judged narrative — every cell carries sample size + prompt
--     version + freshness so the operator and external readers can
--     reproduce the number)
--   - feedback_self_reported_sources_not_truth.md (disagreement is gold;
--     Wave 24 reads disagreement_findings axis=crm_source into the
--     channel-mix question)
--   - feedback_deep_fix_vs_bandaid.md (this is the EVIDENCE-LEADING
--     surface — Isadora will demo it externally; airtightness rules are
--     layered into every answer, not bolted on per question)
--   - PROMPT-BIAS-AUDIT.md (v1-contaminated prompt rows are surfaced
--     with an explicit warning band on any answer that depends on them)
--
-- Why this migration exists
-- -------------------------
-- Wave 24 ships a narrated-intelligence page at /intel/channel-truth.
-- The page reads existing tables (attribution_events, weddings,
-- disagreement_findings, discovery_sources, marketing_spend_records).
-- It does NOT compute new forensic data — its job is to NARRATE the
-- forensic data we already have, with sample sizes + prompt-version
-- disclosure + evidence chains.
--
-- The only NEW persisted state is the audit log: every page view is
-- snapshotted so when Isadora exports an answer to send externally
-- (PDF / CSV / share link), the underlying numbers are reproducible
-- months later even if the underlying data has shifted.
--
-- Schema additions
-- ----------------
--   - public.channel_truth_audits — one row per page view + share
--     action. Stores the rendered question list, the answers' headline
--     values + sample sizes + prompt versions + evidence-chain refs at
--     view time.
--
-- What is NOT in this migration
-- -----------------------------
--   - No new attribution columns (Wave 24 reads existing ones).
--   - No new prompt versions stored as schema (lives in TS as
--     CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION).
--   - No cron registration. Wave 24 is read-only intel display.
--
-- Idempotent: every CREATE uses IF NOT EXISTS. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — channel_truth_audits
-- ============================================================================
-- One row per page view AND per share action. View rows carry
-- shared_at=NULL; share rows update an existing view row OR insert a
-- fresh share-only snapshot (depending on flow).
--
-- snapshot_jsonb shape (validated client-side; never queried by jsonb-
-- path operators, so no GIN index needed):
--
--   {
--     "questions": [
--       {
--         "question_id": "knot_targeted_vs_broadcast_conversion",
--         "computed_at_iso": "2026-05-11T15:00:00Z",
--         "headline_value": "<string for narrator>",
--         "sample_size": { "targeted": 47, "broadcast": 31 },
--         "confidence_level": "high" | "moderate" | "thin",
--         "evidence_wedding_ids": ["uuid", "uuid"],   // up to 50
--         "prompt_versions_used": ["intent-classifier.v2"],
--         "v1_contamination_pct": 0,
--         "data_freshness_iso": "2026-05-11T12:00:00Z",
--         "deterministic_sql_signature": "fn:answerKnotConversion"
--       }
--     ],
--     "page_calibration": {
--       "v1_pct_at_view_time": 0,
--       "data_freshness_iso": "2026-05-11T12:00:00Z",
--       "narrator_prompt_version": "channel-truth-narrator.prompt.v1"
--     }
--   }
--
CREATE TABLE IF NOT EXISTS public.channel_truth_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  -- Nullable: anon / demo viewers don't have an auth user.
  viewed_by uuid,
  -- Which questions were rendered on this view (in order).
  question_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- Full snapshot of answers + sample sizes + evidence-chain refs.
  -- See the shape comment above.
  snapshot_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Populated when the operator clicks "Share this finding".
  shared_at timestamptz,
  -- Free-text: 'csv' | 'pdf' | 'link' | 'embed' | null.
  share_format text
    CHECK (share_format IS NULL
           OR share_format IN ('csv', 'pdf', 'link', 'embed')),
  -- When share_format != null, store which question_id was shared (a
  -- single share artifact wraps one finding, not the whole page).
  shared_question_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.channel_truth_audits IS
  'Wave 24 (mig 290). Channel Truth Report audit log. One row per page '
  'view. share_format + shared_at populated when the operator exports '
  'an answer externally (PDF / CSV / link / embed) — the snapshot lets '
  'external readers reproduce the number months later even if the '
  'underlying data has shifted. Read-only intel display; no cron, no '
  'auto-actions.';

COMMENT ON COLUMN public.channel_truth_audits.snapshot_jsonb IS
  'Full reproducibility snapshot. See migration 290 head for the shape. '
  'Carries per-question sample sizes, prompt-versions-used, v1-contam '
  'pct, deterministic SQL signature, evidence wedding-ids (capped at 50 '
  'for size). Validated client-side at write time — never queried via '
  'jsonb-path operators.';

COMMENT ON COLUMN public.channel_truth_audits.viewed_by IS
  'auth.users.id of the viewer when known. NULL for demo / anon. The '
  'audit row is per-VIEW, not per-user, so the same operator viewing '
  'twice produces two rows (acceptable for reproducibility scope).';

CREATE INDEX IF NOT EXISTS idx_channel_truth_audits_venue_viewed
  ON public.channel_truth_audits (venue_id, viewed_at DESC);

COMMENT ON INDEX public.idx_channel_truth_audits_venue_viewed IS
  'Wave 24 — primary lookup for "what did we show this venue and when?" '
  'Used by the share-history dropdown + an eventual stale-snapshot '
  'detector.';

CREATE INDEX IF NOT EXISTS idx_channel_truth_audits_shared
  ON public.channel_truth_audits (venue_id, shared_at DESC)
  WHERE shared_at IS NOT NULL;

COMMENT ON INDEX public.idx_channel_truth_audits_shared IS
  'Partial index over shared snapshots only — used by the share-history '
  'panel + external-reader reproducibility.';

-- ============================================================================
-- STEP 2 — RLS (venue_id scope)
-- ============================================================================
ALTER TABLE public.channel_truth_audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "channel_truth_audits_select"
  ON public.channel_truth_audits;
CREATE POLICY "channel_truth_audits_select"
  ON public.channel_truth_audits
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

DROP POLICY IF EXISTS "channel_truth_audits_insert"
  ON public.channel_truth_audits;
CREATE POLICY "channel_truth_audits_insert"
  ON public.channel_truth_audits
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

DROP POLICY IF EXISTS "channel_truth_audits_update"
  ON public.channel_truth_audits;
CREATE POLICY "channel_truth_audits_update"
  ON public.channel_truth_audits
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

DROP POLICY IF EXISTS "demo_anon_select"
  ON public.channel_truth_audits;
CREATE POLICY "demo_anon_select"
  ON public.channel_truth_audits
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

DROP POLICY IF EXISTS "demo_anon_insert"
  ON public.channel_truth_audits;
CREATE POLICY "demo_anon_insert"
  ON public.channel_truth_audits
  FOR INSERT TO anon
  WITH CHECK (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMIT;

NOTIFY pgrst, 'reload schema';
