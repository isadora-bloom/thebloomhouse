-- ---------------------------------------------------------------------------
-- 292_draft_edit_insights.sql
-- ---------------------------------------------------------------------------
-- Wave 26 — Sage approval-flow learning transparency.
--
-- Anchor docs:
--   - memory/feedback_deep_fix_vs_bandaid.md (LLM-as-primitive — every
--     operator edit fires a focused Haiku diff analyzer that names what
--     was learned and where it landed)
--   - memory/feedback_no_em_dash.md (em-dash is one of the rules Sage
--     learns; Wave 20 auto-derive proved zero em-dashes from corpus,
--     Wave 26's per-edit learner reinforces operator-specific signal)
--   - Wave 19 (knowledge_captures, mig 286) — content-add insights flow
--     into this existing table.
--   - Wave 20 (voice_preferences) — voice-rule + tone-shift insights
--     flow into the existing table.
--
-- What Wave 26 introduces
-- -----------------------
-- 1. drafts.original_sage_body — preserves the LLM's first output so a
--    later diff against the operator-edited draft_body is possible.
--    Idempotent: if the column exists, never overwrite; the pipeline
--    fills it on first generate, the operator never touches it.
-- 2. draft_edit_insights — every diff analysis writes a row here, even
--    when the insight didn't persist to a learning sink. This is the
--    audit-of-learnings table the /agent/learning/recent-edits view
--    reads.
--
-- Idempotent. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — drafts.original_sage_body
-- ============================================================================
-- Snapshot of Sage's first-pass body. NULL on legacy rows (pre-Wave 26).
-- Pipeline write path stamps this on the initial INSERT only; subsequent
-- operator edits update draft_body, never original_sage_body, so the
-- diff baseline is preserved.

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS original_sage_body text;

COMMENT ON COLUMN public.drafts.original_sage_body IS
  'Wave 26 (mig 292). Snapshot of the LLM''s first-pass output. Stamped '
  'on initial INSERT; never overwritten by operator edits. The diff '
  'between this and draft_body is what the per-edit learning analyzer '
  'reads. NULL on legacy rows generated before Wave 26.';

-- ============================================================================
-- STEP 2 — draft_edit_insights (the audit-of-learnings table)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.draft_edit_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  draft_id uuid NOT NULL REFERENCES public.drafts(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- What kind of edit. Drives the persistence routing in
  -- src/lib/services/draft-learning/persist-insight.ts.
  insight_kind text NOT NULL CHECK (insight_kind IN (
    'voice_rule',
    'content_addition',
    'tone_shift',
    'structure_change',
    'fact_correction',
    'formatting_change',
    'other'
  )),

  -- Verbatim excerpts. Wave 4 doctrine: every learning carries an
  -- evidence quote. Sage_text is the original; operator_text is the
  -- replacement (NULL for pure deletions, NULL on operator side
  -- when the operator added net-new content with no original).
  sage_text text,
  operator_text text,

  -- LLM-generated 1-sentence description of what was learned. Shown
  -- to the operator in the post-approve toast.
  learning_summary text NOT NULL,

  -- Where the insight landed:
  --   'voice_preferences'        - upsert into voice_preferences (Wave 20)
  --   'knowledge_captures'       - inserted into knowledge_captures (Wave 19)
  --   'draft_edit_insights_only' - audit row only, no further persistence
  --   'discarded'                - rejected (e.g. confidence too low)
  persisted_to text NOT NULL DEFAULT 'draft_edit_insights_only'
    CHECK (persisted_to IN (
      'voice_preferences',
      'knowledge_captures',
      'draft_edit_insights_only',
      'discarded'
    )),

  -- The row id (in voice_preferences / knowledge_captures) that this
  -- insight created or updated. NULL when persisted_to is
  -- 'draft_edit_insights_only' or 'discarded'. Operator UI uses this
  -- to deep-link back to the underlying row for verify/undo.
  persisted_ref uuid,

  confidence_0_100 integer NOT NULL DEFAULT 70
    CHECK (confidence_0_100 BETWEEN 0 AND 100),

  -- True until operator dismisses the learning toast. False = either
  -- already-acknowledged or no-toast-shown (e.g. background batch).
  operator_visible boolean NOT NULL DEFAULT true,

  -- Set when operator dismisses the toast — proves the operator saw
  -- the learning. (capture-once-persist-forever requires the operator
  -- saw at least once.)
  operator_acknowledged_at timestamptz,

  -- Operator's free-text override if they flag the learning as wrong.
  -- Setting this clears persisted_ref + reverts the persistence (the
  -- correction handler unwinds the voice_preferences / knowledge_captures
  -- row).
  operator_correction text,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.draft_edit_insights IS
  'owner:agent. Wave 26 (mig 292). One row per insight extracted from '
  'an operator edit of a Sage draft. Every diff analysis writes here, '
  'even when the insight is too low-confidence to persist to a learning '
  'sink. Surfaced in /agent/learning/recent-edits as the audit-of-'
  'learnings view.';

COMMENT ON COLUMN public.draft_edit_insights.insight_kind IS
  'Wave 26. Routes the insight to its sink: voice_rule + tone_shift -> '
  'voice_preferences; content_addition + fact_correction -> '
  'knowledge_captures; structure_change / formatting_change / other -> '
  'audit only.';

COMMENT ON COLUMN public.draft_edit_insights.persisted_to IS
  'Wave 26. Where this insight landed. draft_edit_insights_only means '
  'an audit row was written but the kind didn''t warrant pushing into a '
  'learning sink. discarded means the LLM judged it too low-signal.';

COMMENT ON COLUMN public.draft_edit_insights.persisted_ref IS
  'Wave 26. Row id in voice_preferences or knowledge_captures that '
  'was created/updated. Lets the operator deep-link from the learning '
  'toast to the underlying rule, and lets the correction handler unwind '
  'the persistence.';

-- ============================================================================
-- STEP 3 — Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_draft_edit_insights_venue_created
  ON public.draft_edit_insights (venue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_draft_edit_insights_draft
  ON public.draft_edit_insights (draft_id);

CREATE INDEX IF NOT EXISTS idx_draft_edit_insights_kind
  ON public.draft_edit_insights (insight_kind);

-- Partial index for the operator-visible toast queue (the unread set).
CREATE INDEX IF NOT EXISTS idx_draft_edit_insights_unread
  ON public.draft_edit_insights (venue_id, created_at DESC)
  WHERE operator_visible = true AND operator_acknowledged_at IS NULL;

-- ============================================================================
-- STEP 4 — RLS
-- ============================================================================
-- Standard venue-scoped pattern: authenticated users see / write
-- insights for their venue (direct + org-membership). Demo venues are
-- read-only via the anon policy.

ALTER TABLE public.draft_edit_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "draft_edit_insights_select"
  ON public.draft_edit_insights;
CREATE POLICY "draft_edit_insights_select"
  ON public.draft_edit_insights
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

DROP POLICY IF EXISTS "draft_edit_insights_insert"
  ON public.draft_edit_insights;
CREATE POLICY "draft_edit_insights_insert"
  ON public.draft_edit_insights
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

DROP POLICY IF EXISTS "draft_edit_insights_update"
  ON public.draft_edit_insights;
CREATE POLICY "draft_edit_insights_update"
  ON public.draft_edit_insights
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
  ON public.draft_edit_insights;
CREATE POLICY "demo_anon_select"
  ON public.draft_edit_insights
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMIT;

NOTIFY pgrst, 'reload schema';
