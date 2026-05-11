-- ---------------------------------------------------------------------------
-- 286_knowledge_capture.sql
-- ---------------------------------------------------------------------------
-- Wave 19 — Knowledge gap remediation flow (capture-once persist-forever).
--
-- Anchor docs:
--   - bloom-constitution.md (operator authority — captured answers are
--     authoritative, LLM never overrides)
--   - memory/feedback_deep_fix_vs_bandaid.md Pattern 8 (detect-without-fix
--     is operator burden — turn the existing knowledge_gaps detection
--     into a structured close-the-loop)
--
-- Why this migration exists
-- -------------------------
-- knowledge_gaps (mig 009) records WHEN Sage encounters a question it
-- cannot answer. The current /agent/knowledge-gaps page lets a
-- coordinator type a "resolution" string and optionally copy it into
-- knowledge_base — but the connection is loose: the resolution sits
-- on the gap row, the KB has its own entry, and nothing guarantees
-- Sage's NEXT draft reads from either source. Wave 19 introduces a
-- dedicated knowledge_captures table that is the canonical operator-
-- authored answer store, folded into every brain prompt as a VENUE
-- KNOWLEDGE block.
--
-- Why augment knowledge_gaps rather than recreate it
-- --------------------------------------------------
-- The existing table has runtime writers (pipeline question extraction,
-- brain-dump operational-note routing, CRM-import FAQ rows) and a UI
-- the coordinator already uses. Wave 19 adds two pointer columns
-- (captured_at + captured_id) so a gap can reference the capture row
-- without losing existing data.
--
-- Schema additions (only ADD — never modifies / drops existing columns):
--   - knowledge_captures (the operator-authored answer rows)
--   - knowledge_gaps.captured_at (when this gap was resolved into a
--     capture)
--   - knowledge_gaps.captured_id (FK to the capture row, ON DELETE SET
--     NULL so deleting a capture doesn't cascade-destroy gap audit)
--   - updated_at trigger on knowledge_captures
--   - RLS on knowledge_captures mirroring knowledge_gaps
--   - GIN index on tags for fast tag-overlap relevance scoring
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS or DO/EXCEPTION.
-- Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — knowledge_captures (operator-authored answers)
-- ============================================================================
-- This is what Sage learns from. Every row is an operator-authoritative
-- answer that gets folded into the brain prompt as VENUE KNOWLEDGE.
--
-- source_kind:
--   - 'operator_input'        : coordinator typed the answer in /agent/knowledge-gaps
--   - 'inferred_from_past_email' : answer extracted from a coordinator's
--                                  past human-written email reply (Wave 19+)
--   - 'venue_doc'             : answer pulled from a brain-dump doc / FAQ
--                               sheet import
--
-- confidence_0_100: operator answers default to 100 (authoritative).
-- Inferred answers can sit lower (60-80) until a coordinator confirms.
--
-- applies_until: optional expiry. Seasonal policies ("no outdoor events
-- after Nov 1st") or rate-card windows ("2026 pricing valid until Dec
-- 31") can self-deactivate. NULL = no expiry.
--
-- tags: free-form text array with conventional values: 'pricing',
-- 'policies', 'logistics', 'inclusions', 'vendor', 'logistics',
-- 'ceremony', 'catering'. Used for relevance scoring against current
-- inquiry context (tag-overlap with the inquiry's classifier output).
CREATE TABLE IF NOT EXISTS public.knowledge_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Optional pointer to the gap row that triggered this capture. SET
  -- NULL on gap delete so a deleted gap doesn't cascade-destroy the
  -- captured answer (the answer remains valuable even if the original
  -- detection row goes away).
  knowledge_gap_id uuid REFERENCES public.knowledge_gaps(id) ON DELETE SET NULL,

  question text NOT NULL,
  answer text NOT NULL,

  source_kind text NOT NULL DEFAULT 'operator_input'
    CHECK (source_kind IN ('operator_input', 'inferred_from_past_email', 'venue_doc')),

  tags text[] NOT NULL DEFAULT ARRAY[]::text[],

  confidence_0_100 integer NOT NULL DEFAULT 100
    CHECK (confidence_0_100 BETWEEN 0 AND 100),

  applies_until timestamptz,

  active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.knowledge_captures IS
  'owner:agent. Wave 19 (mig 286). Operator-authored answers Sage learns '
  'from. Every brain draft folds the venue''s active, in-window, tag-'
  'relevant captures into the system prompt as a VENUE KNOWLEDGE block. '
  'source_kind=operator_input is authoritative (confidence default 100); '
  'inferred sources sit lower until confirmed. applies_until lets '
  'seasonal/rate-card answers self-expire.';

COMMENT ON COLUMN public.knowledge_captures.knowledge_gap_id IS
  'Wave 19. Optional pointer to the gap row that triggered this capture. '
  'ON DELETE SET NULL so a deleted gap does not cascade-destroy the '
  'captured answer.';

COMMENT ON COLUMN public.knowledge_captures.source_kind IS
  'Wave 19. Where the answer came from. operator_input = coordinator '
  'typed it; inferred_from_past_email = extracted from a coordinator''s '
  'human-written reply; venue_doc = brain-dump FAQ sheet import.';

COMMENT ON COLUMN public.knowledge_captures.confidence_0_100 IS
  'Wave 19. 0-100. Operator answers default to 100. Inferred answers '
  'sit lower until confirmed by a coordinator review.';

COMMENT ON COLUMN public.knowledge_captures.applies_until IS
  'Wave 19. Optional expiry. NULL = no expiry (most policies). Used for '
  'seasonal rules ("no outdoor events after Nov 1") or dated pricing '
  '("2026 packages, valid until Dec 31, 2026"). When set + past, the '
  'fold-in loader filters this row out.';

COMMENT ON COLUMN public.knowledge_captures.tags IS
  'Wave 19. Free-form labels for relevance scoring. Conventional values: '
  'pricing, policies, logistics, inclusions, vendor, ceremony, catering. '
  'Fold-in loader scores captures by tag overlap with the current '
  'inquiry classifier output.';

-- ============================================================================
-- STEP 2 — Indexes
-- ============================================================================

-- Primary fetch path: venue_id + active. The brain fold-in loads
-- captures for a venue, active=true, and applies_until is NULL or
-- future. Index supports the most common path.
CREATE INDEX IF NOT EXISTS idx_knowledge_captures_venue_active
  ON public.knowledge_captures (venue_id, active);

-- GIN on tags for fast tag-overlap matching. The brain fold-in
-- computes tag overlap between the inquiry's classifier output and
-- each capture's tags; GIN supports `tags && ARRAY[...]` in O(matched).
CREATE INDEX IF NOT EXISTS idx_knowledge_captures_tags_gin
  ON public.knowledge_captures USING gin (tags);

-- Pointer-back from a gap row → its capture.
CREATE INDEX IF NOT EXISTS idx_knowledge_captures_gap_id
  ON public.knowledge_captures (knowledge_gap_id)
  WHERE knowledge_gap_id IS NOT NULL;

-- Expiry sweep: a low-volume cron may want to deactivate rows whose
-- applies_until has passed. Partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_knowledge_captures_expiry
  ON public.knowledge_captures (applies_until)
  WHERE applies_until IS NOT NULL AND active = true;

-- ============================================================================
-- STEP 3 — updated_at trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION public.knowledge_captures_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_captures_updated_at_trigger
  ON public.knowledge_captures;
CREATE TRIGGER knowledge_captures_updated_at_trigger
  BEFORE UPDATE ON public.knowledge_captures
  FOR EACH ROW
  EXECUTE FUNCTION public.knowledge_captures_set_updated_at();

-- ============================================================================
-- STEP 4 — knowledge_gaps augmentation
-- ============================================================================
-- Add two pointer columns to the existing table. Both nullable.
-- Existing rows / writers are unaffected — the augmentation is purely
-- additive.

ALTER TABLE public.knowledge_gaps
  ADD COLUMN IF NOT EXISTS captured_at timestamptz;

ALTER TABLE public.knowledge_gaps
  ADD COLUMN IF NOT EXISTS captured_id uuid
    REFERENCES public.knowledge_captures(id) ON DELETE SET NULL;

ALTER TABLE public.knowledge_gaps
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

ALTER TABLE public.knowledge_gaps
  ADD COLUMN IF NOT EXISTS dismissed_reason text;

COMMENT ON COLUMN public.knowledge_gaps.captured_at IS
  'Wave 19 (mig 286). Timestamp when this gap was resolved into a '
  'knowledge_captures row. NULL = gap is still open.';

COMMENT ON COLUMN public.knowledge_gaps.captured_id IS
  'Wave 19 (mig 286). Pointer to the knowledge_captures row that '
  'answered this gap. ON DELETE SET NULL so deleting a capture does '
  'not destroy the gap audit row.';

COMMENT ON COLUMN public.knowledge_gaps.dismissed_at IS
  'Wave 19 (mig 286). Timestamp when this gap was dismissed as noise. '
  'Dismissed gaps stay in the audit log but never re-surface.';

COMMENT ON COLUMN public.knowledge_gaps.dismissed_reason IS
  'Wave 19 (mig 286). Free-text coordinator note explaining why the '
  'gap was dismissed (e.g. "irrelevant question", "duplicate of #abc").';

CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_captured
  ON public.knowledge_gaps (venue_id, captured_at)
  WHERE captured_at IS NOT NULL;

-- ============================================================================
-- STEP 5 — RLS on knowledge_captures
-- ============================================================================
-- Mirrors the standard venue-scoped pattern: authenticated users see /
-- write captures for their venue (direct + org-membership). Demo
-- venues are read-only via the anon policy.

ALTER TABLE public.knowledge_captures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "knowledge_captures_select"
  ON public.knowledge_captures;
CREATE POLICY "knowledge_captures_select"
  ON public.knowledge_captures
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

DROP POLICY IF EXISTS "knowledge_captures_insert"
  ON public.knowledge_captures;
CREATE POLICY "knowledge_captures_insert"
  ON public.knowledge_captures
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

DROP POLICY IF EXISTS "knowledge_captures_update"
  ON public.knowledge_captures;
CREATE POLICY "knowledge_captures_update"
  ON public.knowledge_captures
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
  ON public.knowledge_captures;
CREATE POLICY "demo_anon_select"
  ON public.knowledge_captures
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMIT;

NOTIFY pgrst, 'reload schema';
