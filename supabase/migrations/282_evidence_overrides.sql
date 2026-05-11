-- ============================================================================
-- Migration 282 — Wave 15: evidence precision overrides + Calendly discovery.
-- ============================================================================
--
-- Anchor docs (~/.claude memory/):
--   - bloom-constitution.md (forensic identity reconstruction; operator
--     override > inferred state. Always. Dismissed evidence preserves
--     audit history — Constitution: never hard-delete.)
--   - bloom-wave4-identity-reconstruction.md (Wave 4 doctrine — evidence
--     precision is constitutional. Stricter filtering happens BEFORE the
--     prompt is built; the prompt + schema are sealed.)
--   - feedback_deep_fix_vs_bandaid.md (layer fix not rule — overrides are
--     a layer with audit history, not a regex rule)
--
-- WHAT THIS ADDS
-- --------------
-- Wave 15 closes three precision gaps surfaced during testing
-- (Sophie Thomas & Luke Wright — inquiry 2026-05-08):
--
--   1. **review_match_review_queue** — when a loose review-to-couple match
--      is ambiguous (multiple weddings share the same surname), the match
--      defers here instead of guessing. Operator reviews + decides.
--
--   2. **evidence_overrides** — per-evidence operator override. When a
--      reconstructed identity attaches a review/interaction/contract that
--      doesn't belong, the operator dismisses that single evidence row
--      and the next reconstruction excludes it from the prompt input.
--      Same pattern as handle_merge_decisions (mig 259) — audit row per
--      operator decision; never hard-deleted; reconstruction respects it.
--
--   3. **discovery_sources** — when a Calendly Q&A captures
--      "Where did you first hear about us?" the answer lands here, with
--      a canonical_source mapping (chatgpt / claude / perplexity →
--      'ai_tool'; instagram → 'instagram'; etc.) plus the verbatim
--      answer. Surfaces in attribution_events for ROI rollups AND on
--      the reconstructed-identity panel via evidence_summary.
--
-- Idempotent: every CREATE / ADD uses IF NOT EXISTS or DROP-THEN-CREATE.
-- Permissive RLS matches the 225/226/246/259/261/278/279/281 doctrine.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 1 — evidence_overrides
-- ----------------------------------------------------------------------------
-- One row per operator override action. The reconstruction service (and
-- the Wave 12 timeline builder) read this table to filter evidence rows
-- before they reach the LLM / UI.
--
-- evidence_kind is text-with-CHECK rather than an enum so future evidence
-- classes can extend without a heavy migration.
--
-- evidence_ref is jsonb with the structured shape:
--   { table: 'reviews' | 'interactions' | 'tangential_signals' | ...,
--     id:    '<uuid of the row>',
--     field_path: '<optional dotted path for sub-field corrections>' }

CREATE TABLE IF NOT EXISTS public.evidence_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,

  evidence_kind text NOT NULL
    CHECK (evidence_kind IN (
      'review',
      'interaction',
      'calendar',
      'contract',
      'payment',
      'handle',
      'tangential_signal',
      'attribution_event',
      'tour',
      'profile_field'
    )),

  -- Structured reference into the underlying source row.
  -- Shape: { table: 'reviews', id: '<uuid>', field_path?: 'names.partner1.first' }
  evidence_ref jsonb NOT NULL,

  override_action text NOT NULL
    CHECK (override_action IN ('dismiss', 'unlink', 'correct_value')),

  -- When override_action='correct_value', the operator-supplied replacement.
  -- Shape is callsite-dependent (string for a name, jsonb-shaped claim for
  -- a residence). NULL for 'dismiss' / 'unlink' actions.
  correction_value jsonb,

  reason text,

  -- Operator audit metadata.
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- active=false retires the override without deleting it (Constitution:
  -- never hard-delete). The /admin/identity/wedding/[id]/overrides UI
  -- can flip this to restore the original evidence.
  active boolean NOT NULL DEFAULT true,

  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.evidence_overrides IS
  'Wave 15 (migration 282). Per-evidence operator overrides. When a '
  'forensic reconstruction or timeline view attaches a piece of '
  'evidence (review, interaction, tangential, contract...) that does '
  'not belong to the couple, the operator dismisses or corrects that '
  'single row here. Reconstruction reads this table BEFORE building '
  'the prompt; timeline builder filters dismissed evidence from the '
  'event stream. Constitution: operator override > inferred state. '
  'Audit history preserved via active=false (never hard-deleted).';

COMMENT ON COLUMN public.evidence_overrides.evidence_ref IS
  'Structured pointer: { table: ''reviews'' | ''interactions'' | ... , '
  'id: ''<uuid>'', field_path?: ''<dotted path>'' }. The dotted path '
  'lets correct_value target a sub-field of a structured profile '
  'claim (e.g. names.partner1.first).';

COMMENT ON COLUMN public.evidence_overrides.override_action IS
  'dismiss = drop this evidence from reconstruction + timeline. '
  'unlink  = same as dismiss but semantic for explicit attachments '
  '          (review wedding_id linkage, etc.). '
  'correct_value = replace the evidence-derived field with '
  '          correction_value at reconstruction time.';

COMMENT ON COLUMN public.evidence_overrides.active IS
  'False retires the override but preserves audit history. The '
  'overrides admin UI lets operators restore = flip active back to '
  'true. Constitution: never hard-delete forensic audit rows.';

CREATE INDEX IF NOT EXISTS idx_evidence_overrides_wedding_active
  ON public.evidence_overrides (wedding_id)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_evidence_overrides_venue_created
  ON public.evidence_overrides (venue_id, created_at DESC);

-- Updated-at touch trigger.
CREATE OR REPLACE FUNCTION public.evidence_overrides_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_evidence_overrides_touch ON public.evidence_overrides;
CREATE TRIGGER trg_evidence_overrides_touch
  BEFORE UPDATE ON public.evidence_overrides
  FOR EACH ROW
  EXECUTE FUNCTION public.evidence_overrides_touch_updated_at();

ALTER TABLE public.evidence_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_evidence_overrides" ON public.evidence_overrides;
CREATE POLICY "auth_select_evidence_overrides" ON public.evidence_overrides
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_evidence_overrides" ON public.evidence_overrides;
CREATE POLICY "auth_insert_evidence_overrides" ON public.evidence_overrides
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_evidence_overrides" ON public.evidence_overrides;
CREATE POLICY "auth_update_evidence_overrides" ON public.evidence_overrides
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_evidence_overrides" ON public.evidence_overrides;
CREATE POLICY "auth_delete_evidence_overrides" ON public.evidence_overrides
  FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "demo_anon_select" ON public.evidence_overrides;
CREATE POLICY "demo_anon_select" ON public.evidence_overrides
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));


-- ----------------------------------------------------------------------------
-- STEP 2 — review_match_review_queue
-- ----------------------------------------------------------------------------
-- When the loose review-to-couple match in reconstruct.ts / build-timeline.ts
-- finds AMBIGUOUS evidence (e.g. two weddings both contain a "Thomas"
-- surname token), defer the match here instead of guessing. Operator
-- decides which wedding (if any) the review belongs to.
--
-- Companion table to evidence_overrides — when the operator picks a
-- wedding from the queue, the system writes BOTH a queue resolution row
-- (here) AND a reviews.wedding_id linkage update.

CREATE TABLE IF NOT EXISTS public.review_match_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES public.reviews(id) ON DELETE CASCADE,

  -- The wedding candidates that matched at deferral time. Shape:
  --   [{ wedding_id, partner1_name, partner2_name, inquiry_date,
  --      wedding_date, match_reason }, ...]
  -- match_reason values: 'first_name_match' / 'surname_match_only' /
  --                      'temporal_pre_inquiry' (review predates inquiry —
  --                      not a candidate but recorded for audit).
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Why this review was flagged. One of:
  --   ambiguous_multiple_candidates: two or more weddings matched
  --   pre_inquiry_review:            review predates the couple's inquiry
  --   surname_only_no_first_match:   loose surname-token match without first-name confirmation
  defer_reason text NOT NULL,

  -- Operator resolution (null = open).
  resolution text
    CHECK (resolution IS NULL OR resolution IN (
      'matched',           -- operator picked a wedding from candidates
      'no_match',          -- operator confirms no wedding owns this review
      'dismissed'          -- operator marked the review as not relevant
    )),
  resolved_wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.review_match_review_queue IS
  'Wave 15 (migration 282). Deferral queue for ambiguous review-to-couple '
  'matches. When the review loader cannot uniquely identify the couple '
  '(multiple weddings share a surname, or the review predates the '
  'inquiry), it writes one row here instead of guessing. The operator '
  'resolves via /admin/identity/review-match-queue. Same audit pattern '
  'as handle_merge_decisions (mig 259).';

COMMENT ON COLUMN public.review_match_review_queue.candidates IS
  'Snapshot of candidate weddings at deferral time. Includes inquiry_date '
  '/ wedding_date so the operator can confirm temporal alignment. Each '
  'candidate carries a match_reason explaining why it surfaced.';

COMMENT ON COLUMN public.review_match_review_queue.defer_reason IS
  'Why the loader deferred this review. ambiguous_multiple_candidates '
  '(2+ weddings matched), pre_inquiry_review (review older than inquiry '
  '— the constitution rule is "reviews older than the couple''s inquiry '
  'are NEVER theirs"), surname_only_no_first_match.';

CREATE INDEX IF NOT EXISTS idx_review_match_queue_venue_open
  ON public.review_match_review_queue (venue_id, created_at DESC)
  WHERE resolution IS NULL;

CREATE INDEX IF NOT EXISTS idx_review_match_queue_review
  ON public.review_match_review_queue (review_id);

-- Unique on (review_id, defer_reason) so the loader can re-run idempotently
-- without spamming the queue. A given review with a given defer_reason
-- only ever produces ONE queue row per venue.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_review_match_queue_review_reason
  ON public.review_match_review_queue (venue_id, review_id, defer_reason);

CREATE OR REPLACE FUNCTION public.review_match_queue_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_review_match_queue_touch ON public.review_match_review_queue;
CREATE TRIGGER trg_review_match_queue_touch
  BEFORE UPDATE ON public.review_match_review_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.review_match_queue_touch_updated_at();

ALTER TABLE public.review_match_review_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_review_match_queue" ON public.review_match_review_queue;
CREATE POLICY "auth_select_review_match_queue" ON public.review_match_review_queue
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_review_match_queue" ON public.review_match_review_queue;
CREATE POLICY "auth_insert_review_match_queue" ON public.review_match_review_queue
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_review_match_queue" ON public.review_match_review_queue;
CREATE POLICY "auth_update_review_match_queue" ON public.review_match_review_queue
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_review_match_queue" ON public.review_match_review_queue;
CREATE POLICY "auth_delete_review_match_queue" ON public.review_match_review_queue
  FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "demo_anon_select" ON public.review_match_review_queue;
CREATE POLICY "demo_anon_select" ON public.review_match_review_queue
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));


-- ----------------------------------------------------------------------------
-- STEP 3 — discovery_sources
-- ----------------------------------------------------------------------------
-- Captures "Where did you first hear about us?" answers from Calendly
-- (and future intake forms). Per Wave 14, ChatGPT-as-referrer is refused
-- as a human — but the value still needs to be CAPTURED as a SOURCE.
-- This is that capture layer.
--
-- canonical_source is mapped from the verbatim answer at write time
-- ('chatgpt' / 'gpt' / 'claude' / 'perplexity' / 'ai chatbot' →
-- 'ai_tool'). The mapping is deterministic and lives in
-- src/lib/services/discovery-source/canonical.ts. UNKNOWN values stay
-- as 'unknown' but the verbatim answer is preserved.

CREATE TABLE IF NOT EXISTS public.discovery_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  -- person_id is the prospect at capture time. wedding_id may be NULL
  -- when the Calendly booking has not yet resolved to a wedding.
  person_id uuid REFERENCES public.people(id) ON DELETE SET NULL,

  -- The capture origin. Free-text for forward-compat:
  --   'calendly' / 'website_form' / 'intake_form' / 'phone' / ...
  capture_source text NOT NULL,

  -- The verbatim question text that produced this answer ("Where did
  -- you first hear about us?"). Audit value — lets a later schema
  -- migration re-map answers if the canonical mapping changes.
  question_text text,

  -- The verbatim answer.
  answer_text text NOT NULL,

  -- The deterministic canonical mapping.
  --   'ai_tool'        — chatgpt / gpt / claude / perplexity / ai search / ai chatbot
  --   'instagram'      — instagram
  --   'tiktok'         — tiktok
  --   'pinterest'      — pinterest
  --   'google'         — google search / google maps / google
  --   'theknot'        — theknot / the knot / knot
  --   'weddingwire'    — weddingwire / wedding wire
  --   'friend'         — friend / family / referral (word-of-mouth)
  --   'vendor'         — vendor / photographer / planner
  --   'social_media'   — generic social
  --   'other'          — answer present but unrecognised
  --   'unknown'        — answer empty/unparseable
  canonical_source text NOT NULL,

  -- When the answer maps to 'friend' / 'family' / 'referral', this is
  -- the referrer name when the form captures it separately (Calendly
  -- forms can have a follow-up "Who referred you?" field).
  referrer_name text,

  captured_at timestamptz NOT NULL DEFAULT now(),

  -- Optional pointer back to the capture event (Calendly invitee URI,
  -- form-submission id, etc.).
  capture_ref text
);

COMMENT ON TABLE public.discovery_sources IS
  'Wave 15 (migration 282). Captures "How did you hear about us?" '
  'answers from Calendly Q&A and other intake forms. canonical_source '
  'is the deterministic mapping (chatgpt → ai_tool, instagram → '
  'instagram, etc.). The verbatim answer is preserved. Surfaces via '
  'attribution_events (one event per discovery_source row) + on the '
  'couple_identity_profile evidence_summary.';

COMMENT ON COLUMN public.discovery_sources.canonical_source IS
  'Deterministic mapping at write time: ai_tool / instagram / tiktok / '
  'pinterest / google / theknot / weddingwire / friend / vendor / '
  'social_media / other / unknown. Mapping table lives at '
  'src/lib/services/discovery-source/canonical.ts. unknown reserved '
  'for empty/unparseable answers; other for present-but-unrecognised.';

COMMENT ON COLUMN public.discovery_sources.referrer_name IS
  'When canonical_source ∈ {friend, family, referral} AND the intake '
  'form captured a separate referrer name, this is that name. The '
  'Wave 14 referrer resolver can pick this up and write a matching '
  'attribution_event with referrer_wedding_id when it resolves.';

CREATE INDEX IF NOT EXISTS idx_discovery_sources_wedding
  ON public.discovery_sources (wedding_id, captured_at DESC)
  WHERE wedding_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discovery_sources_venue_canonical
  ON public.discovery_sources (venue_id, canonical_source, captured_at DESC);

-- Dedupe: one row per (venue, person_id, capture_source, capture_ref).
-- If Calendly retries the webhook, we don't double-write.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_discovery_sources_capture
  ON public.discovery_sources (venue_id, COALESCE(person_id, '00000000-0000-0000-0000-000000000000'::uuid), capture_source, COALESCE(capture_ref, ''));

ALTER TABLE public.discovery_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_discovery_sources" ON public.discovery_sources;
CREATE POLICY "auth_select_discovery_sources" ON public.discovery_sources
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_discovery_sources" ON public.discovery_sources;
CREATE POLICY "auth_insert_discovery_sources" ON public.discovery_sources
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_discovery_sources" ON public.discovery_sources;
CREATE POLICY "auth_update_discovery_sources" ON public.discovery_sources
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_discovery_sources" ON public.discovery_sources;
CREATE POLICY "auth_delete_discovery_sources" ON public.discovery_sources
  FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "demo_anon_select" ON public.discovery_sources;
CREATE POLICY "demo_anon_select" ON public.discovery_sources
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));


COMMIT;

NOTIFY pgrst, 'reload schema';
