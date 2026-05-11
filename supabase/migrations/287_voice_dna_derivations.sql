-- ---------------------------------------------------------------------------
-- 287_voice_dna_derivations.sql
-- ---------------------------------------------------------------------------
-- Wave 20 — Voice DNA auto-derive (saves ~3hr coordinator onboarding per
-- venue).
--
-- Anchor docs (~/.claude memory/):
--   - bloom-constitution.md (operator authority — derivations are
--     PROPOSALS, never auto-applied; the operator picks which fields
--     merge into voice_preferences)
--   - feedback_deep_fix_vs_bandaid.md (Pattern 7 — one-derive-all: the
--     data already exists, derive from it rather than asking the
--     operator to re-input)
--   - feedback_no_em_dash.md (when the coordinator's actual corpus
--     shows zero em dashes, derive that as a hard banned pattern)
--
-- WHAT THIS ADDS
-- --------------
-- voice_preferences (mig 005/012/023/168/179) holds banned phrases,
-- approved phrases, tone descriptors, principles. Coordinator currently
-- types each manually during onboarding — 3+ hours of work that the
-- platform already has the evidence to skip:
--   - Every outbound interaction the coordinator's ever sent
--     (interactions.direction='outbound')
--   - Every Sage draft the coordinator approved-with-edits
--     (draft_feedback.action='edited' carries original_body vs
--     edited_body so the diff IS the operator's voice signal)
--
-- Wave 20 runs a forensic Sonnet pass over that evidence and produces
-- four derived buckets (banned / approved / tone / principles), each
-- item carrying a verbatim evidence_quote (Wave 4 doctrine). The
-- operator then accepts which buckets to merge into voice_preferences.
--
-- Two new tables:
--   1. voice_dna_derivations — audit row per derivation run. Holds the
--      derived buckets + the source summary + applied state.
--   2. voice_dna_jobs — queue for the optional drift-refresh sweep
--      (60-day cadence). Worker drains via /api/cron?job=voice_dna_sweep
--      (TODO: register in route.ts + vercel.json — Wave 20 leaves the
--      cron registration for the reconciliation stream so parallel
--      agents don't fight the cron route file).
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS or DROP-THEN-CREATE.
-- Permissive RLS matches the 282/283 doctrine.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — voice_dna_derivations
-- ============================================================================
-- One row per derivation RUN. Holds the four derived buckets, the source
-- summary (how much evidence the pass saw), cost, and the applied state
-- (whether the operator picked any items into voice_preferences).
--
-- Constitution clause: derivations are PROPOSALS. applied=false is the
-- default; applied=true means the operator hit "apply" in the Voice DNA
-- UI. Nothing in the brain reads from voice_dna_derivations directly —
-- the brain continues reading voice_preferences (the apply flow is what
-- merges into voice_preferences).
CREATE TABLE IF NOT EXISTS public.voice_dna_derivations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  derived_at timestamptz NOT NULL DEFAULT now(),

  -- source_summary shape:
  --   { coordinator_emails_count: int,
  --     draft_edits_count:        int,
  --     time_window_days:         int,
  --     correlation_id:           string }
  -- coordinator_emails_count = outbound interactions sampled.
  -- draft_edits_count        = draft_feedback rows with action='edited'
  --                            and original_body+edited_body both set.
  source_summary jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Each derived bucket: array of { phrase|descriptor|principle,
  -- evidence_quote, confidence }.
  -- evidence_quote is verbatim from the coordinator's corpus
  -- (Wave 4 doctrine — every forensic claim has a quote).
  -- confidence 0-100 integer.
  derived_banned_phrases   jsonb NOT NULL DEFAULT '[]'::jsonb,
  derived_approved_phrases jsonb NOT NULL DEFAULT '[]'::jsonb,
  derived_tone_descriptors jsonb NOT NULL DEFAULT '[]'::jsonb,
  derived_voice_principles jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Cost in dollars from api_costs join (NOT cents — spec says
  -- numeric(10,4) so we can carry sub-cent precision for Haiku-tier
  -- additions later. Column name stays cost_cents per spec; semantics
  -- in code = dollars * 1 with 4 decimal places. The /api/admin/voice-dna
  -- reader formats it for display.)
  cost_cents numeric(10,4),

  -- Prompt version identifier (e.g. 'voice-dna-derive.prompt.v1') so a
  -- drift audit can see which prompt rev produced each derivation.
  prompt_version text,

  -- Operator-apply state. applied=false (default) = derivation is a
  -- proposal awaiting operator review. applied=true = operator hit
  -- "apply" for AT LEAST ONE field; the JSON in applied_fields records
  -- which fields were merged.
  applied boolean NOT NULL DEFAULT false,
  applied_fields jsonb,  -- e.g. ['banned_phrases', 'tone_descriptors']
  applied_at timestamptz,
  applied_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Dismissed state — operator can also reject a derivation outright
  -- without applying. Mutually exclusive with applied.
  dismissed boolean NOT NULL DEFAULT false,
  dismissed_at timestamptz,
  dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dismiss_reason text,

  CONSTRAINT voice_dna_derivations_apply_or_dismiss
    CHECK (NOT (applied AND dismissed))
);

COMMENT ON TABLE public.voice_dna_derivations IS
  'owner:ai_system. Wave 20 (mig 287). One row per voice-DNA derivation '
  'run. Holds the four derived buckets (banned / approved / tone / '
  'principles) plus operator apply state. Derivations are PROPOSALS — '
  'nothing merges into voice_preferences until the operator hits '
  '"apply". Per Constitution: operator authority > inferred state. '
  'Audit history preserved (never hard-delete).';

COMMENT ON COLUMN public.voice_dna_derivations.source_summary IS
  'Evidence pool the derivation saw. Shape: { coordinator_emails_count, '
  'draft_edits_count, time_window_days, correlation_id }.';

COMMENT ON COLUMN public.voice_dna_derivations.derived_banned_phrases IS
  'Array of { phrase, evidence_quote, confidence } — phrases the '
  'coordinator NEVER uses (or uses only in negative contexts). '
  'Operator apply = merge into voice_preferences as preference_type='
  '"banned_phrase".';

COMMENT ON COLUMN public.voice_dna_derivations.derived_approved_phrases IS
  'Array of { phrase, evidence_quote, confidence } — signature phrases '
  'the coordinator repeatedly uses. Operator apply = merge into '
  'voice_preferences as preference_type="approved_phrase".';

COMMENT ON COLUMN public.voice_dna_derivations.derived_tone_descriptors IS
  'Array of { descriptor, evidence_quote, confidence } — tone tags '
  '(warm / direct / playful / formal / etc). Operator apply = merge '
  'into voice_preferences as preference_type="dimension" with content '
  'prefixed "TONE: ".';

COMMENT ON COLUMN public.voice_dna_derivations.derived_voice_principles IS
  'Array of { principle, reasoning, confidence } — distilled rules '
  '(e.g. "always uses contractions", "never starts with I hope this '
  'finds you well"). Operator apply = merge into voice_preferences as '
  'preference_type="rule".';

COMMENT ON COLUMN public.voice_dna_derivations.cost_cents IS
  'Cost of this derivation run in USD with sub-cent precision. Derived '
  'from api_costs.cost rows joined by correlation_id. Numeric(10,4) so '
  'tiny Haiku-tier sub-derivations can also be tracked precisely.';

COMMENT ON COLUMN public.voice_dna_derivations.applied IS
  'Operator-apply state. False (default) = proposal awaiting review. '
  'True = operator merged at least one field into voice_preferences. '
  'applied_fields lists which fields were merged.';

CREATE INDEX IF NOT EXISTS idx_voice_dna_derivations_venue_derived
  ON public.voice_dna_derivations (venue_id, derived_at DESC);

COMMENT ON INDEX public.idx_voice_dna_derivations_venue_derived IS
  'Per-venue history listing path. ORDER BY derived_at DESC LIMIT N.';

CREATE INDEX IF NOT EXISTS idx_voice_dna_derivations_unapplied
  ON public.voice_dna_derivations (venue_id, derived_at DESC)
  WHERE applied = false AND dismissed = false;

COMMENT ON INDEX public.idx_voice_dna_derivations_unapplied IS
  'UI "needs review" badge. Cheap COUNT(*) WHERE applied=false AND '
  'dismissed=false per venue.';


-- ============================================================================
-- STEP 2 — voice_dna_jobs (drift-refresh queue)
-- ============================================================================
-- 60-day drift re-derive cadence. Worker drains via cron
-- /api/cron?job=voice_dna_sweep (TODO: register in route.ts + vercel.json
-- — Wave 20 leaves cron registration for the reconciliation stream).
--
-- One queued row per venue per planned tick. status='done' = the
-- derivation ran (regardless of whether the operator applied it).
-- status='skipped' = the venue had insufficient evidence (e.g. <10
-- coordinator emails since last derivation).
CREATE TABLE IF NOT EXISTS public.voice_dna_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,  -- 'cron_drift_60d' | 'manual_admin' | 'onboarding'
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  derivation_id uuid REFERENCES public.voice_dna_derivations(id) ON DELETE SET NULL,
  error_text text
);

COMMENT ON TABLE public.voice_dna_jobs IS
  'owner:ai_system. Wave 20 voice-DNA drift-refresh queue. Mirrors '
  'attribution_intent_jobs (mig 283). 60-day cadence; worker drains '
  'via voice_dna_sweep cron (TODO registration). On success, links to '
  'the resulting voice_dna_derivations row via derivation_id.';

COMMENT ON COLUMN public.voice_dna_jobs.trigger_signal IS
  'What kicked this enqueue. Common: cron_drift_60d | manual_admin | '
  'onboarding | api_derive.';

CREATE INDEX IF NOT EXISTS idx_voice_dna_jobs_dequeue
  ON public.voice_dna_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_voice_dna_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=queued '
  'LIMIT N. Partial index keeps the queue cheap.';

CREATE INDEX IF NOT EXISTS idx_voice_dna_jobs_venue_enqueued
  ON public.voice_dna_jobs (venue_id, enqueued_at DESC);


-- ============================================================================
-- STEP 3 — RLS
-- ============================================================================
-- Permissive matches the 282/283 doctrine. Tightening to per-org venue
-- scope happens during the cross-table RLS sweep (per
-- bloom-house-rls-056-footgun.md).

ALTER TABLE public.voice_dna_derivations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_voice_dna_derivations" ON public.voice_dna_derivations;
CREATE POLICY "auth_select_voice_dna_derivations" ON public.voice_dna_derivations
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_voice_dna_derivations" ON public.voice_dna_derivations;
CREATE POLICY "auth_insert_voice_dna_derivations" ON public.voice_dna_derivations
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_voice_dna_derivations" ON public.voice_dna_derivations;
CREATE POLICY "auth_update_voice_dna_derivations" ON public.voice_dna_derivations
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select" ON public.voice_dna_derivations;
CREATE POLICY "demo_anon_select" ON public.voice_dna_derivations
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));


ALTER TABLE public.voice_dna_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_voice_dna_jobs" ON public.voice_dna_jobs;
CREATE POLICY "auth_select_voice_dna_jobs" ON public.voice_dna_jobs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_voice_dna_jobs" ON public.voice_dna_jobs;
CREATE POLICY "auth_insert_voice_dna_jobs" ON public.voice_dna_jobs
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_voice_dna_jobs" ON public.voice_dna_jobs;
CREATE POLICY "auth_update_voice_dna_jobs" ON public.voice_dna_jobs
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_voice_dna_jobs" ON public.voice_dna_jobs;
CREATE POLICY "demo_anon_select_voice_dna_jobs" ON public.voice_dna_jobs
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMIT;

NOTIFY pgrst, 'reload schema';
