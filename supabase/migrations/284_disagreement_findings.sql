-- ---------------------------------------------------------------------------
-- 284_disagreement_findings.sql
-- ---------------------------------------------------------------------------
-- Wave 17 — Disagreement surfacing dashboard (Pattern 12: the gap IS gold).
--
-- Anchor docs:
--   - bloom-constitution.md (Bloom is forensic identity reconstruction;
--     every feature is a view over one forensic record per couple. The
--     forensic record's job is to be MORE COMPLETE than the couple's
--     own memory.)
--   - feedback_self_reported_sources_not_truth.md (the doctrine — self-
--     reported "How did you hear about us?" answers are inputs, not
--     truth. The gap between stated and forensic is exactly the value
--     Bloom delivers vs every other CRM that just trusts what's typed
--     in.)
--   - feedback_measure_dont_assume.md (don't pre-judge which side is
--     right; surface the gap and let the operator decide.)
--   - bloom-phase-b-decisions.md (attribution_events architecture —
--     Wave 17 reads Wave 7B role + Wave 16 intent + Wave 15 discovery
--     captures; it never overwrites them.)
--
-- Why this migration exists
-- -------------------------
-- Across the platform we accumulate two parallel versions of the truth:
--
--   1. STATED — what the couple typed into a Calendly Q&A, what an
--      operator clicked in HoneyBook's "Source" column, what the couple
--      put down as their wedding_date or guest_count_estimate.
--
--   2. FORENSIC — what the system actually derived: Wave 7B's channel-
--      role classifier, Wave 5A's persona, Wave 4's reconstructed
--      names, the lifecycle event sequence, the booking_value at
--      contract.
--
-- When these two disagree, the disagreement itself is the intelligence.
-- A CRM that just trusts the typed-in form is throwing away the signal.
-- Wave 17's job is to detect, store, narrate, and surface each
-- disagreement so the operator can resolve, dismiss, or investigate.
--
-- Wave 17 NEVER auto-resolves. It surfaces; the operator decides.
--
-- Schema additions:
--   - public.disagreement_findings   one row per (venue_id, wedding_id,
--                                    axis) disagreement
--   - public.disagreement_jobs       queue table for the sweep worker
--   - per-axis + per-magnitude indexes
--   - RLS scoped to venue_id (mirrors 282/283 doctrine)
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS or DROP-THEN-
-- CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — disagreement_findings
-- ============================================================================
-- One row per (venue_id, wedding_id, axis). The detector upserts on this
-- triplet so re-running on stable data refreshes last_observed_at without
-- creating duplicates.
--
-- `axis` is text-with-CHECK rather than an enum because future axes
-- (e.g. 'vendor_relationships', 'rehearsal_dinner_count') should not
-- require a heavy migration to extend.

CREATE TABLE IF NOT EXISTS public.disagreement_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE CASCADE,

  -- The dimension on which stated and forensic disagree.
  axis text NOT NULL
    CHECK (axis IN (
      'source',             -- Stated source (Calendly Q&A, HoneyBook col)
                            -- vs Wave 7B forensic role + Wave 16 intent
      'wedding_date',       -- Stated wedding_date vs Calendly tour-date
                            -- temporal sense (tour scheduled for a date
                            -- inconsistent with the stated event date)
      'guest_count',        -- Stated guest_count_estimate vs final
                            -- invitation count (when an invitation
                            -- count source exists)
      'budget',             -- Stated budget vs actual booking_value
                            -- (when wedding hits booked terminal)
      'persona',            -- Wave 5A predicted persona_label vs an
                            -- operator-stated override
      'close_prediction',   -- Wave 5A predicted_close_probability_pct
                            -- vs actual lifecycle outcome (when in
                            -- booked or lost terminal state)
      'name',               -- Wave 4 reconstructed name from
                            -- couple_identity_profile vs people row
                            -- (when sync didn't propagate)
      'crm_source',         -- HoneyBook "Source" column (couple-entered
                            -- or operator-entered) vs forensic source
                            -- attribution from Wave 7B
      'other'               -- future-extensible escape hatch
    )),

  -- What was self-reported / operator-input. Free-shape JSON so each
  -- axis can carry the values it needs (string for a source name,
  -- date string for a wedding_date, integer for a guest count, etc.).
  stated_value jsonb,

  -- Where the stated value came from. Free-text but suggested values:
  --   'calendly_qa' | 'web_form' | 'operator_override' |
  --   'honeybook_source_col' | 'couple_email' | 'inquiry_form' | 'crm'
  stated_source_kind text,

  -- What the system derived. Same free-shape JSON shape as stated.
  forensic_value jsonb,

  -- Where the forensic value came from. Free-text but suggested:
  --   'wave_7b_role_classifier' | 'wave_4_reconstruct' |
  --   'wave_5a_persona' | 'lifecycle_event_sequence' |
  --   'wave_16_intent' | 'booking_value' | 'couple_identity_profile'
  forensic_source_kind text,

  -- Axis-specific magnitude. The scale is per-axis; the dashboard
  -- normalises for display via a per-axis label.
  --   source / crm_source / persona / name : 100 = total mismatch,
  --                                          0 = match
  --   wedding_date                         : abs diff in days
  --   guest_count                          : abs diff (people)
  --   budget                               : abs diff in dollars
  --   close_prediction                     : abs diff in pct points
  magnitude_score numeric(10,2),

  -- How confident we are this is a real disagreement vs noise. Detector
  -- writes this based on signal strength (e.g. high-confidence Wave 7B
  -- classification + high-confidence Calendly answer = high; low
  -- confidence on either side = low).
  confidence_0_100 integer
    CHECK (confidence_0_100 IS NULL
      OR (confidence_0_100 BETWEEN 0 AND 100)),

  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),

  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'resolved', 'dismissed', 'investigating')),

  resolution_note text,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dismissed_at timestamptz,
  dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- LLM narrator output (cached on the row). One paragraph "the gap
  -- and why it matters" generated by Haiku from the structured
  -- disagreement. Re-generated when stated_value or forensic_value
  -- changes (detector clears it on update).
  narrator_text text,
  narrator_generated_at timestamptz,
  narrator_prompt_version text,
  narrator_cost_cents numeric(10,4),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.disagreement_findings IS
  'owner:intel. Wave 17 (migration 284). Pattern 12 — when two sources '
  'of truth disagree, the disagreement itself is intelligence. Each row '
  'captures one (wedding_id, axis) disagreement between a STATED value '
  '(Calendly Q&A, HoneyBook col, operator input) and the FORENSIC value '
  'the system derived (Wave 4 reconstruct, Wave 5A persona, Wave 7B role, '
  'Wave 16 intent, lifecycle outcome). Wave 17 NEVER auto-resolves — '
  'operator decides via resolve / dismiss / investigate. Detector is '
  'idempotent on (venue_id, wedding_id, axis); re-running on stable '
  'data refreshes last_observed_at.';

COMMENT ON COLUMN public.disagreement_findings.axis IS
  'The dimension on which stated and forensic disagree. source | '
  'wedding_date | guest_count | budget | persona | close_prediction | '
  'name | crm_source | other. Extensible — future axes add values '
  'without enum migration.';

COMMENT ON COLUMN public.disagreement_findings.magnitude_score IS
  'Axis-specific magnitude. source/crm_source/persona/name: 100=total '
  'mismatch, 0=match. wedding_date: abs days diff. guest_count: abs '
  'people diff. budget: abs dollars diff. close_prediction: abs pct '
  'points diff. The dashboard normalises display via per-axis label.';

COMMENT ON COLUMN public.disagreement_findings.confidence_0_100 IS
  'How confident the detector is the disagreement is real vs noise. '
  'Aggregates signal strength on both sides: high-confidence Wave 7B '
  'classification + high-confidence stated answer → high. Low '
  'confidence on either side → low. Use to filter dashboard.';

COMMENT ON COLUMN public.disagreement_findings.narrator_text IS
  'Wave 17 LLM narrator paragraph. Haiku writes ~80-150 words describing '
  'the gap and why it matters. Cached on the row; re-generated when '
  'either side of the disagreement changes. Cost ~$0.002 per finding.';

-- Upsert key: one finding per (venue, wedding, axis). Re-detection
-- refreshes last_observed_at without inserting a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_disagreement_findings_axis
  ON public.disagreement_findings (venue_id, wedding_id, axis)
  WHERE wedding_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_disagreement_findings_venue_axis_status
  ON public.disagreement_findings (venue_id, axis, status);

CREATE INDEX IF NOT EXISTS idx_disagreement_findings_venue_magnitude
  ON public.disagreement_findings (venue_id, magnitude_score DESC);

CREATE INDEX IF NOT EXISTS idx_disagreement_findings_wedding
  ON public.disagreement_findings (wedding_id)
  WHERE wedding_id IS NOT NULL;

-- Touch-updated_at trigger.
CREATE OR REPLACE FUNCTION public.disagreement_findings_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_disagreement_findings_touch
  ON public.disagreement_findings;
CREATE TRIGGER trg_disagreement_findings_touch
  BEFORE UPDATE ON public.disagreement_findings
  FOR EACH ROW
  EXECUTE FUNCTION public.disagreement_findings_touch_updated_at();

-- ============================================================================
-- STEP 2 — disagreement_jobs (sweep queue)
-- ============================================================================
-- The cron sweep (TODO: wire job=disagreement_sweep in cron/route.ts +
-- vercel.json) drains 50 weddings per tick. Mirrors the queue shape used
-- by Wave 7B (attribution_role_jobs, mig 264) + Wave 16
-- (attribution_intent_jobs, mig 283).

CREATE TABLE IF NOT EXISTS public.disagreement_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.disagreement_jobs IS
  'owner:intel. Wave 17 (migration 284) disagreement-sweep queue. Worker '
  'drains 50/tick via runDisagreementSweep (cron registration TODO — '
  'job string disagreement_sweep). Triggers: (a) lifecycle transition '
  '(booking, loss → reveals close_prediction + budget disagreements), '
  '(b) Wave 4 reconstruction completion (reveals name disagreements), '
  '(c) Wave 7B/Wave 16 reclassification (reveals source disagreements), '
  '(d) manual admin backfill, (e) periodic drift refresh.';

COMMENT ON COLUMN public.disagreement_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text label. Common values: '
  'lifecycle_transition | wave_4_reconstruction | wave_7b_reclassify | '
  'wave_16_reclassify | admin_backfill | drift_refresh | manual.';

CREATE INDEX IF NOT EXISTS idx_disagreement_jobs_dequeue
  ON public.disagreement_jobs (status, enqueued_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_disagreement_jobs_wedding
  ON public.disagreement_jobs (wedding_id, enqueued_at DESC)
  WHERE wedding_id IS NOT NULL;

-- ============================================================================
-- STEP 3 — RLS
-- ============================================================================
-- Mirrors the 282/283 doctrine: permissive auth + venue-scoped anon
-- demo. Service role bypasses RLS for the sweep worker.

ALTER TABLE public.disagreement_findings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_disagreement_findings"
  ON public.disagreement_findings;
CREATE POLICY "auth_select_disagreement_findings"
  ON public.disagreement_findings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_disagreement_findings"
  ON public.disagreement_findings;
CREATE POLICY "auth_insert_disagreement_findings"
  ON public.disagreement_findings
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_disagreement_findings"
  ON public.disagreement_findings;
CREATE POLICY "auth_update_disagreement_findings"
  ON public.disagreement_findings
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_disagreement_findings"
  ON public.disagreement_findings;
CREATE POLICY "auth_delete_disagreement_findings"
  ON public.disagreement_findings
  FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "demo_anon_select"
  ON public.disagreement_findings;
CREATE POLICY "demo_anon_select"
  ON public.disagreement_findings
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

ALTER TABLE public.disagreement_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_disagreement_jobs"
  ON public.disagreement_jobs;
CREATE POLICY "auth_select_disagreement_jobs"
  ON public.disagreement_jobs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_disagreement_jobs"
  ON public.disagreement_jobs;
CREATE POLICY "auth_insert_disagreement_jobs"
  ON public.disagreement_jobs
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_disagreement_jobs"
  ON public.disagreement_jobs;
CREATE POLICY "auth_update_disagreement_jobs"
  ON public.disagreement_jobs
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_jobs"
  ON public.disagreement_jobs;
CREATE POLICY "demo_anon_select_jobs"
  ON public.disagreement_jobs
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMIT;

NOTIFY pgrst, 'reload schema';
