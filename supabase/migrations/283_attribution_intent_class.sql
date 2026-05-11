-- ---------------------------------------------------------------------------
-- 283_attribution_intent_class.sql
-- ---------------------------------------------------------------------------
-- Wave 16 — Inquiry intent classification (broadcast vs targeted).
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction thesis;
--     Wave 16 applies the same evidence-chain rigor as Wave 7B but on
--     an ORTHOGONAL dimension — intent of the inquiry, not role of the
--     channel)
--   - bloom-may9-llm-vs-template.md (deterministic where signals are
--     clear; LLM judge only for ambiguous)
--   - bloom-phase-b-decisions.md (attribution_events architecture — we
--     ADD intent_class columns alongside Wave 7B's role columns;
--     orthogonal dimensions never overwrite each other)
--   - bloom-wave4-5-6-master-plan.md (Wave 7B spec which Wave 16
--     extends)
--
-- Why this migration exists
-- -------------------------
-- Wave 7B classifies the ROLE of a channel touchpoint:
--   - acquisition (this channel sourced the couple — pre-inquiry
--     engagement evidence on the SAME platform)
--   - validation (couple discovered the venue elsewhere; this channel
--     was just the intake form)
--   - conversion (closing-step event)
--
-- Wave 16 classifies the INTENT of the inquiry — orthogonal to role:
--   - targeted (couple actively chose the venue and wrote a
--     personalised message)
--   - broadcast (Knot/WW's "Inquire to similar venues" button
--     auto-distributed the couple's interest to N venues; the couple
--     did not actively select us — they got bcc'd by the platform's
--     ranker)
--   - validation (mirror of Wave 7B's validation when the inquiry-
--     intent classifier can confirm the couple discovered the venue
--     elsewhere via post-inquiry engagement patterns)
--   - unknown (default; classifier has not run, or platform is not in
--     the broadcast-capable set)
--
-- The combination matters for spend strategy:
--   - role=acquisition + intent=targeted → real Knot acquisition. Full
--     CAC weight.
--   - role=acquisition + intent=broadcast → Knot's algorithm pushed us
--     into a multi-venue blast. Couple didn't actively choose us.
--     Should NOT carry full CAC weight — closer to a paid impression
--     than an inbound lead.
--   - role=validation + intent=* → couple found us elsewhere; intent
--     dimension doesn't matter for this case.
--
-- Schema additions (only ADD — never touches Wave 7B's role columns):
--   - attribution_intent_class enum (targeted | broadcast | validation
--     | unknown)
--   - attribution_events.intent_class
--   - attribution_events.intent_class_confidence_0_100
--   - attribution_events.intent_class_signals (jsonb evidence chain)
--   - attribution_events.intent_classified_at
--   - attribution_intent_jobs (worker queue mirroring
--     attribution_role_jobs from mig 264)
--   - knot_template_patterns (operator-curated phrase / regex
--     patterns that the broadcast detector matches against)
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS or DO/EXCEPTION.
-- Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — attribution_intent_class enum
-- ============================================================================
-- targeted: couple actively chose to inquire with this venue. The
--   inquiry body contains personalised language (venue name, specific
--   features, distinctive details) OR the couple subsequently engaged
--   post-inquiry (reply, click, tour booking, etc.).
-- broadcast: the inquiry matches Knot/WeddingWire's auto-distributed
--   "Inquire to similar venues" template AND the couple did not engage
--   post-inquiry within 14 days. Strong signal the platform's ranker
--   bcc'd us rather than the couple picking us.
-- validation: couple discovered the venue elsewhere; this channel is
--   just the intake form. Mirrors Wave 7B's validation role but lives
--   on the intent dimension when the inquiry-intent classifier can
--   independently confirm the pattern.
-- unknown: default for new rows. Set when the classifier has not run
--   OR the platform is not broadcast-capable (only theknot,
--   weddingwire run through the broadcast detector — other channels
--   default to unknown unless explicit signals emerge).
DO $$ BEGIN
  CREATE TYPE public.attribution_intent_class AS ENUM (
    'targeted',
    'broadcast',
    'validation',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

COMMENT ON TYPE public.attribution_intent_class IS
  'Wave 16 (mig 283). Forensic intent classification for attribution_events. '
  'Orthogonal to Wave 7B''s role enum. targeted = couple actively chose '
  'this venue (personalised message OR post-inquiry engagement). '
  'broadcast = Knot/WW auto-distributed template + no post-inquiry '
  'engagement (couple did not pick us; got bcc''d by the platform''s '
  'ranker). validation = mirror of Wave 7B validation when intent '
  'classifier independently confirms. unknown = classifier not yet run '
  'OR platform is not broadcast-capable.';

-- ============================================================================
-- STEP 2 — attribution_events intent columns
-- ============================================================================
ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS intent_class public.attribution_intent_class
    NOT NULL DEFAULT 'unknown';

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS intent_class_confidence_0_100 integer
    CHECK (intent_class_confidence_0_100 IS NULL
      OR (intent_class_confidence_0_100 BETWEEN 0 AND 100));

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS intent_class_signals jsonb;

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS intent_classified_at timestamptz;

COMMENT ON COLUMN public.attribution_events.intent_class IS
  'Wave 16 forensic intent classification. Default ''unknown''. Set by '
  'classifyInquiryIntent (forensic rule + Haiku judge for ambiguous). '
  'Orthogonal to .role: role=acquisition + intent=broadcast = Knot '
  'pushed us, couple did not actively choose; should carry less CAC '
  'weight than role=acquisition + intent=targeted.';

COMMENT ON COLUMN public.attribution_events.intent_class_confidence_0_100 IS
  'Wave 16. 0-100 integer. Forensic check: 90+ when templateScore + '
  'post-inquiry signals are unambiguous; 60-89 when single dimension '
  'commits; 40-59 → Haiku judge fired.';

COMMENT ON COLUMN public.attribution_events.intent_class_signals IS
  'Wave 16. jsonb evidence chain. Shape: { '
  '"templateScore": int 0-100, '
  '"matchedPatterns": [string], '
  '"postInquiryEngagementDays": int | null, '
  '"postInquiryInteractionCount": int, '
  '"postInquiryTourCount": int, '
  '"timingClusterDetected": bool | null, '
  '"timingClusterVenues": [string], '
  '"forensic_path": string, '
  '"llmJudgeFired": bool, '
  '"llm_judge": { "reasoning": string, "prompt_version": string } | null }. '
  'Replays the decision so a coordinator can audit.';

COMMENT ON COLUMN public.attribution_events.intent_classified_at IS
  'Wave 16. Timestamp the intent_class was last computed. Drift refresh: '
  'events older than 30 days are re-evaluated so post-inquiry engagement '
  'signals that arrived AFTER initial classification can flip broadcast → '
  'targeted.';

CREATE INDEX IF NOT EXISTS idx_attribution_events_intent_classified
  ON public.attribution_events (intent_class, intent_classified_at);

COMMENT ON INDEX public.idx_attribution_events_intent_classified IS
  'Wave 16. Drift sweep index: ORDER BY intent_classified_at ASC WHERE '
  'intent_class IN (...) — picks the staleness frontier.';

CREATE INDEX IF NOT EXISTS idx_attribution_events_venue_intent
  ON public.attribution_events (venue_id, intent_class);

COMMENT ON INDEX public.idx_attribution_events_venue_intent IS
  'Wave 16. intent-summary aggregate path. Cheap GROUP BY intent_class '
  'per venue.';

-- ============================================================================
-- STEP 3 — attribution_intent_jobs (queue)
-- ============================================================================
-- Mirrors attribution_role_jobs (mig 264). Worker drains via the cron
-- dispatcher /api/cron?job=intent_classify_sweep (TODO: register in
-- route.ts + vercel.json — Wave 16 leaves this for the reconciliation
-- stream so parallel agents don't fight the cron route file).
CREATE TABLE IF NOT EXISTS public.attribution_intent_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_event_id uuid NOT NULL
    REFERENCES public.attribution_events(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.attribution_intent_jobs IS
  'owner:agent. Wave 16 inquiry-intent classifier queue. Mirrors '
  'attribution_role_jobs. Triggers: (a) new attribution_events row '
  '(event_inserted), (b) admin bulk reclassify (manual_bulk), '
  '(c) cron drift refresh (drift_refresh). 24h dedupe per event. '
  'Worker drains 50/tick via intent_classify_sweep (cron registration '
  'TODO). Migration 283.';

COMMENT ON COLUMN public.attribution_intent_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text label. Common values: '
  'event_inserted | manual_bulk | drift_refresh | admin_backfill.';

CREATE INDEX IF NOT EXISTS idx_attribution_intent_jobs_dequeue
  ON public.attribution_intent_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_attribution_intent_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 50. Partial index so the queue stays cheap.';

CREATE INDEX IF NOT EXISTS idx_attribution_intent_jobs_event
  ON public.attribution_intent_jobs (attribution_event_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_attribution_intent_jobs_event IS
  '24h dedupe lookup. Avoids double-spending the classifier on event-'
  'insert bursts.';

-- ============================================================================
-- STEP 4 — knot_template_patterns (operator-curated detector inputs)
-- ============================================================================
-- The broadcast detector is grounded in patterns. Hardcoding them in
-- code locks us in; living in a table lets coordinators add patterns
-- when Knot rotates its templates. Venue-scoped + global (venue_id IS
-- NULL applies to every venue). Coordinator UI to manage these will
-- land in a follow-up wave; for now this is operator-editable via SQL.
CREATE TABLE IF NOT EXISTS public.knot_template_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = applies to every venue. Otherwise scoped to one venue.
  venue_id uuid REFERENCES public.venues(id) ON DELETE CASCADE,
  -- 'exact_phrase' = case-insensitive substring match.
  -- 'regex' = JavaScript-style regex match (compiled in TS).
  -- 'similarity_threshold' = reserved for future cosine-sim style
  --   matchers; ignored by the current detector but reserved so the
  --   schema doesn't churn when we add it.
  pattern_type text NOT NULL
    CHECK (pattern_type IN ('exact_phrase', 'regex', 'similarity_threshold')),
  pattern_value text NOT NULL,
  -- 0-100 weight. Aggregate templateScore = sum of matched weights,
  -- capped at 100.
  weight numeric NOT NULL DEFAULT 25
    CHECK (weight >= 0 AND weight <= 100),
  -- Where the pattern came from: 'seed_v1' for the initial Wave 16
  -- seed, or coordinator note.
  source text,
  -- Soft-disable without dropping the row.
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.knot_template_patterns IS
  'Wave 16 (mig 283). Operator-curated phrase / regex patterns the '
  'broadcast detector matches against. venue_id IS NULL → applies to '
  'all venues. Weighted: templateScore = sum(weight) for matched '
  'patterns, capped at 100. Seeded with canonical Knot/WW broadcast '
  'phrases that consistently appear in the platform''s auto-distributed '
  '"Inquire to similar venues" template. Coordinator can extend.';

CREATE INDEX IF NOT EXISTS idx_knot_template_patterns_lookup
  ON public.knot_template_patterns (venue_id, enabled);

-- ============================================================================
-- STEP 5 — Seed Knot broadcast patterns
-- ============================================================================
-- Grounded in Rixey's actual Knot inquiry corpus (see anchor doc
-- references). The Knot's auto-distributed "New Lead" emails to
-- venues all share these patterns:
--   - Generic "Hello" + name openers (no venue-specific reference)
--   - "looking for" / "interested in" + generic ask (pricing,
--     availability, packages, information)
--   - The "Acceptable Content Policy" footer Knot appends to every
--     templated form-fill
--   - Short, vague messages that work for any venue receiving the
--     same blast
-- The detector also looks for ABSENCE of personalisation, but that's
-- handled in code (the patterns list is "things present in
-- broadcast" — code can compute "things absent for broadcast" as a
-- separate dimension).
-- Each insert is wrapped in a DO block so re-running the migration is
-- a no-op when the pattern already exists.
INSERT INTO public.knot_template_patterns (venue_id, pattern_type, pattern_value, weight, source, enabled)
VALUES
  -- The classic broadcast-template openers
  (NULL, 'exact_phrase', 'I''m reaching out to several venues', 40, 'seed_v1', true),
  (NULL, 'exact_phrase', 'reaching out to several venues', 40, 'seed_v1', true),
  (NULL, 'exact_phrase', 'I''m looking for options', 35, 'seed_v1', true),
  (NULL, 'exact_phrase', 'looking for options', 30, 'seed_v1', true),
  (NULL, 'exact_phrase', 'Could you send me information about pricing and availability', 45, 'seed_v1', true),
  (NULL, 'exact_phrase', 'information about pricing and availability', 35, 'seed_v1', true),
  (NULL, 'exact_phrase', 'I''d like to receive a brochure', 40, 'seed_v1', true),
  (NULL, 'exact_phrase', 'I am inquiring about your venue', 30, 'seed_v1', true),
  (NULL, 'exact_phrase', 'inquiring about your venue', 25, 'seed_v1', true),

  -- Patterns observed directly in Rixey Knot corpus (grounded, not guessed)
  (NULL, 'exact_phrase', 'we saw your listing', 30, 'seed_v1_rixey_corpus', true),
  (NULL, 'exact_phrase', 'are interested in the prices and details', 35, 'seed_v1_rixey_corpus', true),
  (NULL, 'exact_phrase', 'Looking for pricing first', 30, 'seed_v1_rixey_corpus', true),
  (NULL, 'exact_phrase', 'Lots of details are still TBD', 25, 'seed_v1_rixey_corpus', true),
  (NULL, 'exact_phrase', 'Can you share what options are available', 30, 'seed_v1_rixey_corpus', true),
  (NULL, 'exact_phrase', 'pricing and any packages you may offer', 30, 'seed_v1_rixey_corpus', true),
  (NULL, 'exact_phrase', 'wanted to reach out for a quote', 25, 'seed_v1_rixey_corpus', true),

  -- Knot's acceptable-content footer is appended ONLY to templated form-fills
  (NULL, 'exact_phrase', 'your messages may be monitored for quality, safety, and security', 25, 'seed_v1_knot_footer', true),
  (NULL, 'exact_phrase', 'Acceptable Content Policy', 20, 'seed_v1_knot_footer', true),

  -- Generic-greeting patterns (regex). Short messages starting with
  -- "Hi" / "Hello" / "Hey" with no venue name in the first 200 chars
  -- are very common in broadcast.
  (NULL, 'regex', '^\s*(Hi|Hello|Hey)\s*(there|!|,)?\s*$', 20, 'seed_v1_generic_opener', true),

  -- WeddingWire's parallel templated phrases
  (NULL, 'exact_phrase', 'wants to learn more about your offerings', 30, 'seed_v1_weddingwire', true),
  (NULL, 'exact_phrase', 'we found you on WeddingWire', 25, 'seed_v1_weddingwire', true),

  -- "Quote/pricing/info only" thin asks (templated request bodies)
  (NULL, 'exact_phrase', 'send through information on your packages', 30, 'seed_v1', true),
  (NULL, 'exact_phrase', 'interested in your services', 20, 'seed_v1', true)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 6 — RLS
-- ============================================================================

-- attribution_intent_jobs RLS mirrors attribution_role_jobs.
ALTER TABLE public.attribution_intent_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attribution_intent_jobs_select"
  ON public.attribution_intent_jobs;
CREATE POLICY "attribution_intent_jobs_select"
  ON public.attribution_intent_jobs
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

DROP POLICY IF EXISTS "attribution_intent_jobs_insert"
  ON public.attribution_intent_jobs;
CREATE POLICY "attribution_intent_jobs_insert"
  ON public.attribution_intent_jobs
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

DROP POLICY IF EXISTS "attribution_intent_jobs_update"
  ON public.attribution_intent_jobs;
CREATE POLICY "attribution_intent_jobs_update"
  ON public.attribution_intent_jobs
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
  ON public.attribution_intent_jobs;
CREATE POLICY "demo_anon_select"
  ON public.attribution_intent_jobs
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- knot_template_patterns RLS: select is open to authenticated (the
-- detector needs to read every venue's patterns + globals). Insert/
-- update is restricted: super_admin can manage globals; coordinators
-- can manage their own venue's rows.
ALTER TABLE public.knot_template_patterns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "knot_template_patterns_select"
  ON public.knot_template_patterns;
CREATE POLICY "knot_template_patterns_select"
  ON public.knot_template_patterns
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "knot_template_patterns_insert"
  ON public.knot_template_patterns;
CREATE POLICY "knot_template_patterns_insert"
  ON public.knot_template_patterns
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_super_admin()
    OR (
      venue_id IS NOT NULL
      AND venue_id IN (
        SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
        UNION
        SELECT v.id FROM public.venues v
          JOIN public.user_profiles up ON up.org_id = v.org_id
         WHERE up.id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "knot_template_patterns_update"
  ON public.knot_template_patterns;
CREATE POLICY "knot_template_patterns_update"
  ON public.knot_template_patterns
  FOR UPDATE
  TO authenticated
  USING (
    public.is_super_admin()
    OR (
      venue_id IS NOT NULL
      AND venue_id IN (
        SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
        UNION
        SELECT v.id FROM public.venues v
          JOIN public.user_profiles up ON up.org_id = v.org_id
         WHERE up.id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "demo_anon_select_patterns"
  ON public.knot_template_patterns;
CREATE POLICY "demo_anon_select_patterns"
  ON public.knot_template_patterns
  FOR SELECT TO anon
  USING (true);

COMMIT;

NOTIFY pgrst, 'reload schema';
