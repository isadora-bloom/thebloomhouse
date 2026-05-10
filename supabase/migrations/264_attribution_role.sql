-- ---------------------------------------------------------------------------
-- 264_attribution_role.sql
-- ---------------------------------------------------------------------------
-- Wave 7B — Channel-Role re-classification (forensic acquisition vs validation).
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction is the
--     thesis; Wave 7B applies the same evidence-chain rigor to
--     attribution events)
--   - bloom-wave4-5-6-master-plan.md (Wave 7B spec — channel-role
--     classification, "30% of Knot leads may be validation not
--     acquisition")
--   - bloom-phase-b-decisions.md (attribution_events architecture —
--     this migration ADDS columns to that audit table; never modifies
--     persona_overlay (Wave 6A) or other shipped columns)
--
-- Why this migration exists
-- -------------------------
-- Wave 6A's persona overlay tells us WHICH persona converted from a
-- channel. Wave 7B answers a different question: did the channel ACTUALLY
-- acquire the couple, or did the couple already know the venue and use
-- the channel as a confirmation tool?
--
-- Concrete shape: a couple inquires via theknot.com/ a Knot proxy email.
-- Every other CRM credits Knot. Bloom asks: did this couple have ANY
-- engagement signal on Knot before the inquiry timestamp? If not, Knot
-- is the validation/intake form. Their REAL acquisition channel was
-- whoever showed them the venue first (Instagram, organic search, vendor
-- referral, etc.).
--
-- Schema additions (only ADD — never touches existing columns or
-- persona_overlay which Wave 6A owns):
--   - attribution_role enum (acquisition | validation | conversion |
--     mixed | unknown)
--   - attribution_events.role
--   - attribution_events.role_confidence_0_100
--   - attribution_events.role_classified_at
--   - attribution_events.role_reasoning
--   - attribution_events.role_evidence (jsonb of platform engagement
--     dates + missing signals + decision trace)
--
-- Plus the worker queue table public.attribution_role_jobs (mirrors the
-- shape of identity_reconstruction_jobs / couple_intel_jobs). Worker is
-- registered as 'attribution_role_sweep' in /api/cron/route.ts (TODO
-- comment placed by Wave 7B; reconciliation stream wires the actual
-- dispatcher case + vercel.json).
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS or DO/EXCEPTION.
-- Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — attribution_role enum
-- ============================================================================
-- acquisition: this touchpoint sourced the couple (they discovered the
--   venue via this channel). Pre-inquiry engagement evidence on this
--   channel exists.
-- validation: the couple discovered the venue elsewhere and used this
--   touchpoint as a confirmation/intake step. No pre-inquiry engagement
--   evidence on this channel; Knot/HoneyBook/Calendly are the canonical
--   validation channels.
-- conversion: this is a closing-step touchpoint (form-fill that opened
--   the wedding, tour booking, contract signature). Always credits the
--   conversion bucket, never an acquisition channel.
-- mixed: forensic check produced contradictory signals OR LLM judge
--   refused to commit. Coordinator review queue.
-- unknown: not yet classified. The default for new rows; the sweep
--   worker drains these.
DO $$ BEGIN
  CREATE TYPE public.attribution_role AS ENUM (
    'acquisition',
    'validation',
    'conversion',
    'mixed',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

COMMENT ON TYPE public.attribution_role IS
  'Wave 7B (mig 264). Forensic role classification for attribution_events. '
  'acquisition = channel sourced the couple (pre-inquiry engagement '
  'present). validation = couple discovered venue elsewhere, used this '
  'channel to confirm/submit. conversion = closing-step (inquiry submit, '
  'tour book, contract). mixed = contradictory signals (coordinator '
  'review). unknown = not yet classified (default for new rows).';

-- ============================================================================
-- STEP 2 — attribution_events role columns
-- ============================================================================
-- Each ADD COLUMN IF NOT EXISTS is its own statement so a partial
-- previous run cannot leave the table half-migrated.
ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS role public.attribution_role NOT NULL DEFAULT 'unknown';

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS role_confidence_0_100 integer
    CHECK (role_confidence_0_100 IS NULL
      OR (role_confidence_0_100 BETWEEN 0 AND 100));

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS role_classified_at timestamptz;

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS role_reasoning text;

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS role_evidence jsonb;

COMMENT ON COLUMN public.attribution_events.role IS
  'Wave 7B forensic role classification. Default ''unknown'' — populated '
  'by the channel-role classifier (forensic check + LLM judge for '
  'ambiguous cases). Reveals "30% of Knot leads are validation, not '
  'acquisition" via /api/admin/attribution/role-summary aggregate.';

COMMENT ON COLUMN public.attribution_events.role_confidence_0_100 IS
  'Wave 7B. 0-100 integer. Forensic check: 95 when prior engagement '
  'evidence is unambiguous; 60-89 when LLM judge committed; <60 when '
  'evidence is mixed/contradictory.';

COMMENT ON COLUMN public.attribution_events.role_classified_at IS
  'Wave 7B. Timestamp the role was last computed. Drift refresh: events '
  'older than 30 days are re-evaluated by the cron sweep so new pre-'
  'inquiry signals (post-classification) can flip a validation row to '
  'acquisition.';

COMMENT ON COLUMN public.attribution_events.role_reasoning IS
  'Wave 7B. Human-readable summary of WHY the classifier picked this '
  'role. Forensic-rule reasons: "no Knot engagement in 30d before '
  'inquiry → validation". LLM-judge reasons: ~1 sentence summary.';

COMMENT ON COLUMN public.attribution_events.role_evidence IS
  'Wave 7B. jsonb evidence chain. Shape: { '
  '"platform_engagement_dates": [iso strings], '
  '"missing_signals": [string], '
  '"forensic_path": string (acquisition | validation | conversion | '
  'mixed_deferred_to_llm), '
  '"llm_judge": { '
  '   "key_evidence_signals": [string], '
  '   "refusal": string | null, '
  '   "prompt_version": string '
  '} | null }. '
  'Replays the forensic check + LLM call so a coordinator can audit.';

CREATE INDEX IF NOT EXISTS idx_attribution_events_role_classified
  ON public.attribution_events (role, role_classified_at);

COMMENT ON INDEX public.idx_attribution_events_role_classified IS
  'Wave 7B. Drift sweep index: ORDER BY role_classified_at ASC WHERE '
  'role IN (...) — picks the staleness frontier for re-classification.';

CREATE INDEX IF NOT EXISTS idx_attribution_events_venue_role
  ON public.attribution_events (venue_id, role);

COMMENT ON INDEX public.idx_attribution_events_venue_role IS
  'Wave 7B. role-summary aggregate path. Cheap GROUP BY role per '
  'venue; reveals the validation-vs-acquisition split per channel.';

-- ============================================================================
-- STEP 3 — attribution_role_jobs (queue)
-- ============================================================================
-- Mirrors identity_reconstruction_jobs (mig 260) and couple_intel_jobs
-- (mig 261). Worker drains via the cron dispatcher
-- /api/cron?job=attribution_role_sweep (TODO: register in route.ts +
-- vercel.json — Wave 7B leaves this for the reconciliation stream so
-- two parallel agents don't fight the cron route file).
CREATE TABLE IF NOT EXISTS public.attribution_role_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_event_id uuid NOT NULL
    REFERENCES public.attribution_events(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of the signal that produced this enqueue. Examples:
  -- 'event_inserted' (fired when a new attribution_events row is written
  -- by candidate-resolver / backtrack), 'manual_bulk', 'drift_refresh',
  -- 'admin_backfill'.
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.attribution_role_jobs IS
  'owner:agent. Wave 7B channel-role classifier queue. Enqueue triggers: '
  '(a) new attribution_events row inserted by candidate-resolver / '
  'identity backtrack (trigger_signal=event_inserted), (b) admin bulk '
  'reclassify (manual_bulk), (c) cron drift refresh of events whose '
  'role_classified_at < 30 days ago (drift_refresh). 24h dedupe per '
  'attribution_event at the enqueue layer. Worker drains 50/tick. '
  'Migration 264.';

COMMENT ON COLUMN public.attribution_role_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text label so new triggers can land '
  'without a migration. Common values: event_inserted | manual_bulk | '
  'drift_refresh | admin_backfill.';

CREATE INDEX IF NOT EXISTS idx_attribution_role_jobs_dequeue
  ON public.attribution_role_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_attribution_role_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 50. Partial index so the queue stays cheap even after millions '
  'of done/failed/skipped historical rows.';

CREATE INDEX IF NOT EXISTS idx_attribution_role_jobs_event
  ON public.attribution_role_jobs (attribution_event_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_attribution_role_jobs_event IS
  '24h dedupe lookup: "is there already a queued/running job for this '
  'attribution_event within the last 24h?" Avoids double-spending the '
  'classifier on event-insert bursts (e.g. backfill).';

-- ============================================================================
-- STEP 4 — RLS for attribution_role_jobs
-- ============================================================================
-- attribution_events itself already has RLS (mig 105). The new columns
-- inherit those policies — no policy changes needed there. The new
-- queue table mirrors attribution_events' policy shape.
ALTER TABLE public.attribution_role_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attribution_role_jobs_select"
  ON public.attribution_role_jobs;
CREATE POLICY "attribution_role_jobs_select"
  ON public.attribution_role_jobs
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

DROP POLICY IF EXISTS "attribution_role_jobs_insert"
  ON public.attribution_role_jobs;
CREATE POLICY "attribution_role_jobs_insert"
  ON public.attribution_role_jobs
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

DROP POLICY IF EXISTS "attribution_role_jobs_update"
  ON public.attribution_role_jobs;
CREATE POLICY "attribution_role_jobs_update"
  ON public.attribution_role_jobs
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
  ON public.attribution_role_jobs;
CREATE POLICY "demo_anon_select"
  ON public.attribution_role_jobs
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMIT;

NOTIFY pgrst, 'reload schema';
