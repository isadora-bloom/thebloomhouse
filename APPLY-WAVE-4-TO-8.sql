-- ==============================================================================
-- BLOOM HOUSE — Wave 4 → Wave 8 + 7D + calendar fix migration bundle
-- Generated 2026-05-10. Apply via Supabase SQL editor (paste the whole file).
--
-- All 16 migrations are idempotent. Re-running is safe.
--
-- Migrations bundled (in order):
--   260-274  Wave 4 through Wave 7D
--   275      Calendar unique-index non-partial fix (2026-05-10 cron failure)
-- ==============================================================================


-- ==============================================================================
-- 260_couple_identity_profile.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 260_couple_identity_profile.sql
-- ---------------------------------------------------------------------------
-- Wave 4 — forensic identity reconstruction (Phase 1: foundation).
--
-- Anchor docs:
--   - bloom-constitution.md (Bloom is forensic identity-reconstruction;
--     every feature is a view over one forensic record per couple).
--   - bloom-wave4-identity-reconstruction.md (the doctrine that replaces
--     ~15 piecemeal heuristic detectors with ONE Sonnet judge per couple
--     and stores the structured output here).
--   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
--     is backed by a real callAI; Wave 4 extends from labels to
--     extractors).
--
-- Why this migration exists
-- -------------------------
-- Today identity is extracted by ~15 heuristic detectors: name-capture
-- rule cascades, body-extraction regex, intelligence-engine emotional-
-- theme keyword loops, pulse-extractor hardcoded keyword scanners,
-- phantom-partner duplicate detector, residence/occupation grep, etc.
-- The detectors miss obvious failure modes the live data shows daily:
--   * "Hannah Lord & Hannah Lord" (phantom partner with same last name)
--   * "Whole Weekend & Whole Weekend" (form value as a name)
--   * "Mconn" / "Erinhorrigan" / "Benandalexwedding" (email-username slugs)
--   * "Final Walkthrough - how is this so difficult" (form-field bleed)
--   * "Sarah Lemon & Kevan" (incomplete partner2)
-- Endless rule-stacking can't catch all of these. The Sonnet judge can.
--
-- Wave 4 collapses every per-couple identity extraction into ONE call
-- per couple. The structured output lands here. Every read surface
-- (lead detail, Sage email-reply brain, Sage review-reply brain,
-- risk-flags, intel rollups, cultural-moments LLM proposer, handle-
-- merge UI) reads from this row — they do NOT re-extract from raw
-- bodies.
--
-- Scope of THIS migration (Phase 1 — foundation only):
--   * couple_identity_profile (one row per wedding, jsonb profile +
--     evidence_summary + version + cost + reconstruction_count)
--   * identity_reconstruction_jobs (queue table — Phase 2 wires
--     signal-driven enqueue + cron drift refresh; this migration just
--     creates the storage)
--   * RLS scoped to venue_id (mirrors wedding_auto_context, mig 253)
--   * service-role bypass (the orchestrator + crons + repair endpoints
--     run as service-role)
--
-- What is NOT in this migration:
--   * Heuristic-detector deletes (Phase 4 retires those after read
--     surfaces have switched over).
--   * Read-surface migrations (Phase 3).
--   * Pipeline enqueue (Phase 2).
--   * Bulk endpoint + cron sweep (Phase 2).
--
-- Idempotent: every CREATE TABLE / CREATE INDEX / CREATE POLICY uses
-- IF NOT EXISTS or DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — couple_identity_profile (one row per wedding)
-- ============================================================================
-- The forensic-record substrate. Every read surface that wants names,
-- emotional truths, occupations, residence, family dynamics, vendor
-- preferences, handles, accessibility needs, cultural signals,
-- relationship history, or decision dynamics for a couple reads from
-- HERE — not from raw interaction bodies.
--
-- Shape of `profile`:
--   {
--     "names": {
--       "partner1": { "first": "...", "last": "...", "confidence_0_100": 95, "evidence_quote": "..." } | null,
--       "partner2": { ... } | null,
--       "is_phantom_partner_relationship": false,
--       "name_quality": "high" | "medium" | "low" | "unknown"
--     },
--     "emotional_truths": [{ "theme": "...", "evidence_quote": "...",
--                            "confidence_0_100": 80, "sensitive": false }],
--     "occupations": [{ "partner_role": "partner1", "occupation": "...",
--                       "evidence_quote": "..." }],
--     "residence": { "city": "...", "state": "...", "evidence_quote": "..." } | null,
--     "family_dynamics": [{ "relationship": "...", "signal": "...",
--                           "evidence_quote": "..." }],
--     "vendor_preferences": [...],
--     "handles": [...],
--     "accessibility_needs": [...],
--     "cultural_signals": [...],
--     "relationship_history": { "length_signal": "...", "prior_engagement_signal": "..." } | null,
--     "decision_dynamics": { "who_decides": "...", "who_questions": "...",
--                            "who_negotiates": "..." } | null,
--     "refusals": [{ "field": "...", "reason": "..." }]
--   }
--
-- Shape of `evidence_summary`:
--   { "interactions_count": 23, "calculator_count": 1,
--     "honeybook_present": false, "calendar_count": 2,
--     "reviews_count": 0, "contracts_count": 0,
--     "tangentials_count": 4, "payments_count": 0 }

CREATE TABLE IF NOT EXISTS public.couple_identity_profile (
  wedding_id uuid PRIMARY KEY REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  profile jsonb NOT NULL,
  evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_reconstructed_at timestamptz NOT NULL DEFAULT now(),
  -- Timestamp of the newest signal that fed this reconstruction. Lets
  -- the drift-refresh cron skip couples whose signals haven't moved
  -- since the last reconstruction.
  last_signal_at timestamptz,
  reconstruction_count integer NOT NULL DEFAULT 1,
  prompt_version text NOT NULL,
  -- Cumulative cost across every reconstruction for this wedding. Each
  -- reconstruction adds the per-call cost from callAI. Numeric(10,4) so
  -- a worst-case lifetime ($0.08 × 50 reconstructions = $4) fits with
  -- room for 4 decimal cents of precision.
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.couple_identity_profile IS
  'owner:agent. Wave 4 forensic identity-reconstruction substrate. One '
  'row per wedding, holding the structured Sonnet output for every '
  'identity claim Bloom has reconstructed for that couple — names, '
  'emotional truths, occupations, residence, family dynamics, vendor '
  'preferences, handles, accessibility needs, cultural signals, '
  'relationship history, decision dynamics. Every populated claim has a '
  'verbatim evidence_quote pulled from the input. Read surfaces (lead '
  'detail, Sage brains, risk-flags, intel rollups, cultural-moments '
  'proposer) read from HERE — they do NOT re-extract from raw bodies. '
  'The Sonnet judge runs ONCE per couple per signal-burst (with 24h '
  'dedupe) and on weekly drift-refresh. Cost target $0.03-$0.08 per '
  'reconstruction. Migration 260 (Phase 1: foundation).';

COMMENT ON COLUMN public.couple_identity_profile.profile IS
  'Structured Sonnet output. See migration header for the JSON shape. '
  'Locked at the prompt + parser layer — every populated claim carries '
  'a verbatim evidence_quote. Sensitive themes (medical/grief/'
  'financial_stress/family_conflict/mental_health) are tagged '
  'sensitive:true; read surfaces decide whether to display.';

COMMENT ON COLUMN public.couple_identity_profile.evidence_summary IS
  'Counters describing what evidence was on disk at reconstruction time '
  '(interactions_count, calculator_count, honeybook_present, '
  'calendar_count, reviews_count, contracts_count, tangentials_count, '
  'payments_count). Lets coordinator UIs say "reconstructed from 23 '
  'emails + 1 calculator submission" without re-querying.';

COMMENT ON COLUMN public.couple_identity_profile.last_reconstructed_at IS
  'When this profile was last produced by the Sonnet judge. The '
  '/api/admin/identity/reconstruct cache window keys off this — '
  'force=false within 24h returns cached.';

COMMENT ON COLUMN public.couple_identity_profile.last_signal_at IS
  'Timestamp of the newest signal (interaction / calculator / contract / '
  'calendar invite / tangential signal) that fed this reconstruction. '
  'Drift-refresh cron uses (last_signal_at > last_reconstructed_at) AS '
  'the dirty bit so couples without new signal don''t burn LLM budget.';

COMMENT ON COLUMN public.couple_identity_profile.reconstruction_count IS
  'Total times this profile has been rebuilt. Incremented on every '
  'upsert. Lets cost audits answer "how many times did we re-run the '
  'judge on this couple?"';

COMMENT ON COLUMN public.couple_identity_profile.prompt_version IS
  'Identifier of the prompt revision that produced THIS profile (e.g. '
  '"identity-reconstruction.prompt.v1"). Threaded into api_costs.'
  'prompt_version too. Lets a prompt-regression audit ask "any couples '
  'still on v1 after we shipped v2?"';

COMMENT ON COLUMN public.couple_identity_profile.cost_cents IS
  'Cumulative dollar cost (in cents, with sub-cent precision) of every '
  'reconstruction for this wedding. Numeric not integer because Sonnet '
  'cost-per-call is sub-cent on cache hits. Read by the cost dashboard '
  'when surfacing per-couple LLM spend.';

CREATE INDEX IF NOT EXISTS idx_couple_identity_profile_venue_recent
  ON public.couple_identity_profile (venue_id, last_reconstructed_at DESC);

COMMENT ON INDEX public.idx_couple_identity_profile_venue_recent IS
  'Hot-path index for venue-scoped recency queries: "show me every '
  'profile reconstructed in the last 24h" (drift dashboard), "any '
  'couples still on the old prompt version" (audit), "freshest profile '
  'feed for the team digest" (briefing).';

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_couple_identity_profile_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_couple_identity_profile_touch
  ON public.couple_identity_profile;
CREATE TRIGGER trg_couple_identity_profile_touch
  BEFORE UPDATE ON public.couple_identity_profile
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_couple_identity_profile_updated_at();

-- ============================================================================
-- STEP 2 — identity_reconstruction_jobs (queue table)
-- ============================================================================
-- Phase 2 wires signal-driven enqueue (new email / form submit / contract
-- arrival → enqueue) + drift-refresh cron sweeps. This migration just
-- creates the storage. Workers atomically claim the oldest queued job
-- by SET status='running' WHERE id=$1 AND status='queued' RETURNING.

CREATE TABLE IF NOT EXISTS public.identity_reconstruction_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of the signal that produced this enqueue. Examples:
  -- 'new_email', 'calculator_submit', 'contract_arrived',
  -- 'calendar_invite', 'manual', 'drift_refresh', 'admin_backfill'.
  -- Drives observability dashboards ("which signals trigger the most
  -- reconstructions").
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.identity_reconstruction_jobs IS
  'owner:agent. Wave 4 reconstruction-job queue. Phase 2 wires signal-'
  'driven enqueue (pipeline.processIncomingEmail, calculator-submit '
  'handler, contract-arrived handler, calendar-invite handler), the '
  'manual /api/admin/identity/reconstruct endpoint, and the weekly '
  'drift-refresh cron. Workers atomically claim the oldest queued job. '
  '24h dedupe-per-wedding lives at the enqueue side. Migration 260.';

COMMENT ON COLUMN public.identity_reconstruction_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text label so new triggers can land '
  'without a migration. Common values: new_email | calculator_submit | '
  'contract_arrived | calendar_invite | manual | drift_refresh | '
  'admin_backfill. Logged so observability dashboards can surface '
  '"which signals drive the most rebuilds".';

CREATE INDEX IF NOT EXISTS idx_identity_reconstruction_jobs_dequeue
  ON public.identity_reconstruction_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_identity_reconstruction_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 1. Partial index so the queue stays cheap to scan even after '
  'millions of done/failed/skipped historical rows accumulate.';

CREATE INDEX IF NOT EXISTS idx_identity_reconstruction_jobs_wedding
  ON public.identity_reconstruction_jobs (wedding_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_identity_reconstruction_jobs_wedding IS
  '24h dedupe lookup: "is there already a queued/running job for this '
  'wedding within the last 24h?" Phase 2 enqueue path uses this to '
  'avoid double-spending Sonnet on signal bursts (5 emails in 60s '
  'should produce 1 reconstruction, not 5).';

-- ============================================================================
-- STEP 3 — RLS (mirrors wedding_auto_context pattern, mig 253)
-- ============================================================================
-- Authenticated users see their own venue's rows. Service-role bypasses
-- RLS for the orchestrator + crons + ops endpoints. No anon access —
-- this is internal forensic substrate, not a public surface.

ALTER TABLE public.couple_identity_profile ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple_identity_profile_auth_select"
  ON public.couple_identity_profile;
CREATE POLICY "couple_identity_profile_auth_select"
  ON public.couple_identity_profile
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple_identity_profile_auth_insert"
  ON public.couple_identity_profile;
CREATE POLICY "couple_identity_profile_auth_insert"
  ON public.couple_identity_profile
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple_identity_profile_auth_update"
  ON public.couple_identity_profile;
CREATE POLICY "couple_identity_profile_auth_update"
  ON public.couple_identity_profile
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

ALTER TABLE public.identity_reconstruction_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "identity_reconstruction_jobs_auth_select"
  ON public.identity_reconstruction_jobs;
CREATE POLICY "identity_reconstruction_jobs_auth_select"
  ON public.identity_reconstruction_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "identity_reconstruction_jobs_auth_insert"
  ON public.identity_reconstruction_jobs;
CREATE POLICY "identity_reconstruction_jobs_auth_insert"
  ON public.identity_reconstruction_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "identity_reconstruction_jobs_auth_update"
  ON public.identity_reconstruction_jobs;
CREATE POLICY "identity_reconstruction_jobs_auth_update"
  ON public.identity_reconstruction_jobs
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


-- ==============================================================================
-- 261_couple_intel.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 261_couple_intel.sql
-- ---------------------------------------------------------------------------
-- Wave 5A — per-couple derivative intel layer.
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction is the thesis;
--     Wave 5A is the action layer derived from couple_identity_profile)
--   - bloom-wave4-5-6-master-plan.md (5A: per-couple persona + close-prob
--     + recommended action + coordinator brief + sensitivity flags +
--     stale-signal alerts; refreshed when the underlying profile drifts)
--   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
--     must be backed by a real callAI; Wave 5A is a Sonnet synthesizer
--     derived from the Wave 4 forensic substrate)
--
-- Why this migration exists
-- -------------------------
-- Wave 4 produces couple_identity_profile (WHO each couple is). Wave 5A
-- derives WHAT TO DO per couple. Different LLM job: Wave 4 is forensic
-- extraction; Wave 5A is synthesis + recommendation. Storing the synthesis
-- separately so we can:
--   * sort/triage by predicted_close_probability_pct without rebuilding
--     intel on every page render,
--   * cluster persona_label across cohorts (Wave 5B clustering pass),
--   * detect drift (source_profile_at vs couple_identity_profile.last_
--     reconstructed_at) and trigger refresh.
--
-- Shape of `intel`:
--   {
--     "predicted_close_probability": {
--       "pct_0_100": int,
--       "reasoning": string,
--       "key_signals": [string],
--       "confidence_0_100": int
--     },
--     "persona": {
--       "label": string,        -- discovered from data, not enum
--       "description": string,
--       "confidence_0_100": int
--     },
--     "recommended_next_action": {
--       "action": string,       -- imperative
--       "timing": string,       -- "within 4 hours", etc.
--       "reasoning": string
--     },
--     "coordinator_brief": string,  -- 80-150 words; voice-shape only,
--                                   -- never quotes sensitive evidence
--     "sensitivity_flags": [
--       { "category": string, "handle_with": string }
--     ],
--     "stale_signal_alerts": [
--       { "signal": string, "since": string, "suggested_action": string }
--     ],
--     "refusals": [{ "field": string, "reason": string }]
--   }
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — couple_intel (one row per wedding)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.couple_intel (
  wedding_id uuid PRIMARY KEY REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  intel jsonb NOT NULL,
  -- Hot columns hoisted out of jsonb for cheap sort/group queries.
  predicted_close_probability_pct integer
    CHECK (predicted_close_probability_pct IS NULL
      OR (predicted_close_probability_pct BETWEEN 0 AND 100)),
  persona_label text,
  last_derived_at timestamptz NOT NULL DEFAULT now(),
  -- Snapshot of couple_identity_profile.last_reconstructed_at at the
  -- time this intel was derived. Drift detector compares against the
  -- live value so we know when the underlying profile has moved.
  source_profile_at timestamptz,
  derive_count integer NOT NULL DEFAULT 1,
  prompt_version text NOT NULL,
  -- Cumulative cost in cents (sub-cent precision). Each derive adds the
  -- per-call cost from callAI on top of the existing cumulative.
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.couple_intel IS
  'owner:agent. Wave 5A per-couple derivative intel. One row per wedding '
  'holding the structured Sonnet synthesis: predicted close probability, '
  'persona label (discovered from data, not enum), recommended next '
  'action, coordinator brief (~80-150 words), sensitivity flags, and '
  'stale-signal alerts. Read by the lead detail page CoupleIntelPanel + '
  'inbox triage (Wave 5B). Refresh trigger: a fresh '
  'couple_identity_profile reconstruction enqueues an intel refresh; '
  'drift sweep also picks up profiles whose last_derived_at is older '
  'than 7d. Cost target $0.02 per derive. Migration 261.';

COMMENT ON COLUMN public.couple_intel.intel IS
  'Structured Sonnet synthesis. See migration header for the JSON shape. '
  'Voice-shape only — coordinator_brief NEVER quotes sensitive evidence '
  'verbatim. Sensitivity flags carry category + handle_with coaching '
  'pulled from profile.emotional_truths where sensitive=true; the '
  'evidence_quote stays in couple_identity_profile and is gated by '
  'venue_config.feature_flags.reveal_sensitive_themes.';

COMMENT ON COLUMN public.couple_intel.predicted_close_probability_pct IS
  'Hoisted out of intel.predicted_close_probability.pct_0_100 for cheap '
  'venue-scoped triage queries (sort hot leads desc, etc.). Indexed.';

COMMENT ON COLUMN public.couple_intel.persona_label IS
  'Hoisted out of intel.persona.label for cheap GROUP BY rollups. '
  'Discovered by the LLM, not an enum — Wave 5B will cluster these into '
  'cohort rollups when the label distribution stabilises.';

COMMENT ON COLUMN public.couple_intel.source_profile_at IS
  'couple_identity_profile.last_reconstructed_at at derive time. Drift '
  'detector: when profile.last_reconstructed_at > intel.source_profile_at, '
  'the underlying forensic record has moved and intel should refresh.';

COMMENT ON COLUMN public.couple_intel.derive_count IS
  'Total times this intel has been re-derived. Increments on every '
  'upsert. Same audit pattern as couple_identity_profile.reconstruction_'
  'count.';

COMMENT ON COLUMN public.couple_intel.cost_cents IS
  'Cumulative dollar cost (in cents, sub-cent precision) of every derive '
  'for this wedding. Numeric not integer because Sonnet cost-per-call is '
  'sub-cent on cache hits.';

CREATE INDEX IF NOT EXISTS idx_couple_intel_venue_close_prob
  ON public.couple_intel (venue_id, predicted_close_probability_pct DESC);

COMMENT ON INDEX public.idx_couple_intel_venue_close_prob IS
  'Hot-path index for venue-scoped close-probability sort: "show me the '
  'top-N hottest predicted closes" (lead triage), inbox sort by predicted '
  'closeability, etc.';

CREATE INDEX IF NOT EXISTS idx_couple_intel_venue_persona
  ON public.couple_intel (venue_id, persona_label);

COMMENT ON INDEX public.idx_couple_intel_venue_persona IS
  'Persona rollup index: "how many of each persona does this venue have?" '
  '(GROUP BY persona_label). Wave 5B uses this for cohort feeds + '
  'persona x channel ROI rollups in Wave 6.';

CREATE INDEX IF NOT EXISTS idx_couple_intel_venue_recent
  ON public.couple_intel (venue_id, last_derived_at DESC);

COMMENT ON INDEX public.idx_couple_intel_venue_recent IS
  'Drift / freshness index. Cron sweep picks N stalest derives per tick.';

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_couple_intel_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_couple_intel_touch ON public.couple_intel;
CREATE TRIGGER trg_couple_intel_touch
  BEFORE UPDATE ON public.couple_intel
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_couple_intel_updated_at();

-- ============================================================================
-- STEP 2 — couple_intel_jobs (queue table)
-- ============================================================================
-- Same shape as identity_reconstruction_jobs (mig 260). 24h dedupe at the
-- enqueue layer. Worker drains via the cron dispatcher
-- (/api/cron?job=couple_intel_sweep) every 10 minutes.

CREATE TABLE IF NOT EXISTS public.couple_intel_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of the signal that produced this enqueue. Examples:
  -- 'profile_updated' (fired from reconstruct.ts after the profile
  -- upsert), 'manual_bulk', 'drift_refresh', 'admin_backfill'.
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.couple_intel_jobs IS
  'owner:agent. Wave 5A intel-derive queue. Enqueue triggers: (a) Wave '
  '4 reconstruct.ts fires "profile_updated" after every profile upsert, '
  '(b) /api/admin/intel/couple-derive-bulk fires "manual_bulk" per '
  'paged wedding, (c) couple_intel_sweep cron fires "drift_refresh" '
  'for derives older than 7d. 24h dedupe per wedding at the enqueue '
  'layer. Worker drains 50 jobs per tick + drift refresh of 5. '
  'Migration 261.';

COMMENT ON COLUMN public.couple_intel_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text label so new triggers can land '
  'without a migration. Common values: profile_updated | manual_bulk | '
  'drift_refresh | admin_backfill.';

CREATE INDEX IF NOT EXISTS idx_couple_intel_jobs_dequeue
  ON public.couple_intel_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_couple_intel_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 50. Partial index so the queue stays cheap even after millions '
  'of done/failed/skipped historical rows.';

CREATE INDEX IF NOT EXISTS idx_couple_intel_jobs_wedding
  ON public.couple_intel_jobs (wedding_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_couple_intel_jobs_wedding IS
  '24h dedupe lookup: "is there already a queued/running job for this '
  'wedding within the last 24h?" Avoids double-spending Sonnet on '
  'profile-update bursts.';

-- ============================================================================
-- STEP 3 — RLS (mirrors couple_identity_profile pattern)
-- ============================================================================

ALTER TABLE public.couple_intel ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple_intel_auth_select"
  ON public.couple_intel;
CREATE POLICY "couple_intel_auth_select"
  ON public.couple_intel
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple_intel_auth_insert"
  ON public.couple_intel;
CREATE POLICY "couple_intel_auth_insert"
  ON public.couple_intel
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple_intel_auth_update"
  ON public.couple_intel;
CREATE POLICY "couple_intel_auth_update"
  ON public.couple_intel
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

ALTER TABLE public.couple_intel_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple_intel_jobs_auth_select"
  ON public.couple_intel_jobs;
CREATE POLICY "couple_intel_jobs_auth_select"
  ON public.couple_intel_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple_intel_jobs_auth_insert"
  ON public.couple_intel_jobs;
CREATE POLICY "couple_intel_jobs_auth_insert"
  ON public.couple_intel_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple_intel_jobs_auth_update"
  ON public.couple_intel_jobs;
CREATE POLICY "couple_intel_jobs_auth_update"
  ON public.couple_intel_jobs
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


-- ==============================================================================
-- 262_venue_intel.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 262_venue_intel.sql
-- ---------------------------------------------------------------------------
-- Wave 5B — per-venue cohort rollup intel layer.
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction is the thesis;
--     Wave 5 derives intel — 5A per-couple, 5B per-cohort/venue, 5C external).
--   - bloom-wave4-5-6-master-plan.md (5B spec: emerging_themes,
--     conversion_correlations, voice_calibration, service_demand_map,
--     timing_patterns; weekly cron; /intel/cohort dashboard; ~$5/venue/week).
--   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Sensitive
--     themes report counts at the venue level, never name couples).
--   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
--     must be a real callAI; Wave 5B is a Sonnet aggregator over the
--     per-couple substrate).
--
-- Why this migration exists
-- -------------------------
-- Wave 4 produced the forensic record (WHO each couple is). Wave 5A
-- produced the per-couple action layer (WHAT to do per couple). Wave 5B
-- aggregates across the venue's couples to surface what's emerging,
-- what's converting, what's stuck — at the cohort level. Different
-- LLM job from 4 + 5A: 4 is forensic extraction, 5A is per-couple
-- synthesis, 5B is multi-couple pattern synthesis.
--
-- Storage shape:
--   * one venue_intel row per venue (most-recent rollup),
--   * a venue_intel_jobs queue mirroring the Wave 4 + 5A job pattern
--     (status / trigger_signal / atomic-claim worker model).
--
-- Shape of `rollup`:
--   {
--     "emerging_themes": [
--       { "theme": "...", "trend": "rising"|"steady"|"declining",
--         "evidence_count": int, "evidence_window_days": int,
--         "sensitivity_filtered_count": int, "summary": "..." }
--     ],
--     "conversion_correlations": [
--       { "signal": "...", "outcome": "books"|"drops"|"slow",
--         "lift_pct": number, "n_couples": int,
--         "confidence_0_100": int, "reasoning": "..." }
--     ],
--     "voice_calibration": [
--       { "persona_label": "...",
--         "language_that_lands": ["..."],
--         "language_to_avoid": ["..."],
--         "evidence_summary": "..." }
--     ],
--     "service_demand_map": [
--       { "service_or_offering": "...", "demand_signal": "...",
--         "currently_offered": "yes"|"no"|"unknown",
--         "investment_recommendation": "..." }
--     ],
--     "timing_patterns": [
--       { "pattern": "...", "evidence_summary": "...",
--         "actionable_recommendation": "..." }
--     ],
--     "refusals": [{ "field": "...", "reason": "..." }]
--   }
--
-- Aggregate ≠ disclose. The cohort-rollup prompt enforces the rule:
-- sensitive themes (medical/grief/financial_stress/family_conflict/
-- mental_health) report COUNTS only via sensitivity_filtered_count.
-- The aggregator NEVER names couples and NEVER quotes evidence.
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — venue_intel (one row per venue)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.venue_intel (
  venue_id uuid PRIMARY KEY REFERENCES public.venues(id) ON DELETE CASCADE,
  rollup jsonb NOT NULL,
  last_refreshed_at timestamptz NOT NULL DEFAULT now(),
  -- The window aggregated. Default 90 days. Stored on the row so the
  -- coordinator surface can render "last 90d cohort" without rebuilding.
  source_window_days integer NOT NULL DEFAULT 90,
  -- Number of couples whose profile + intel fed into the aggregator.
  couples_in_window integer NOT NULL DEFAULT 0,
  prompt_version text NOT NULL,
  -- Cumulative cost across rollups for this venue. Numeric not integer
  -- because Sonnet cost-per-call is sub-cent on cache hits.
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.venue_intel IS
  'owner:agent. Wave 5B per-venue cohort rollup intel. One row per venue '
  'holding the structured Sonnet aggregator output: emerging_themes, '
  'conversion_correlations, voice_calibration, service_demand_map, '
  'timing_patterns. Read by /intel/cohort dashboard + Wave 5C will pipe '
  'voice_calibration into Sage drafts. Refresh trigger: weekly cron + '
  'manual force. Aggregate-not-disclose: sensitive themes report counts '
  'only, never name couples or quote evidence. Cost target $2-5 per '
  'rollup. Migration 262.';

COMMENT ON COLUMN public.venue_intel.rollup IS
  'Structured Sonnet aggregator output. See migration header for the '
  'JSON shape. Sensitive themes (medical/grief/financial_stress/family_'
  'conflict/mental_health) appear as counts (sensitivity_filtered_count) '
  'only — never named couples, never evidence_quote. Coordinator surfaces '
  'gate any deeper reveal on venue_config.feature_flags.reveal_sensitive_'
  'themes.';

COMMENT ON COLUMN public.venue_intel.source_window_days IS
  'Number of trailing days of couples aggregated. Defaults to 90 — long '
  'enough to span an inquiry-to-book median, short enough that emerging '
  'trends remain visible. Operator can override via /api/admin/intel/'
  'cohort-rollup body.windowDays.';

COMMENT ON COLUMN public.venue_intel.couples_in_window IS
  'Couples whose profile + intel fed the aggregator. Hoisted out of '
  'rollup so the freshness card can render "synthesized from 47 couples" '
  'without parsing jsonb. When 0, the surface renders an empty state.';

COMMENT ON COLUMN public.venue_intel.cost_cents IS
  'Cumulative dollar cost (in cents, sub-cent precision) of every rollup '
  'for this venue. Each refresh adds the per-call cost on top of the '
  'existing cumulative. Tracks Wave 5B spend over time.';

CREATE INDEX IF NOT EXISTS idx_venue_intel_venue_refreshed
  ON public.venue_intel (venue_id, last_refreshed_at DESC);

COMMENT ON INDEX public.idx_venue_intel_venue_refreshed IS
  'Drift / freshness index. Cron sweep picks venues whose '
  'last_refreshed_at is older than 7 days and enqueues a refresh job. '
  'Also used by the dashboard to show "last refreshed Nm/h/d ago".';

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_venue_intel_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_intel_touch ON public.venue_intel;
CREATE TRIGGER trg_venue_intel_touch
  BEFORE UPDATE ON public.venue_intel
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_venue_intel_updated_at();

-- ============================================================================
-- STEP 2 — venue_intel_jobs (queue table)
-- ============================================================================
-- Same shape as identity_reconstruction_jobs (mig 260) and
-- couple_intel_jobs (mig 261). Per-venue not per-couple, so volume is
-- low (one venue rollup per week per venue). Worker drains via the
-- cron dispatcher.

CREATE TABLE IF NOT EXISTS public.venue_intel_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of the signal that produced this enqueue.
  -- Common values: 'weekly_cron' | 'manual_bulk' | 'drift_refresh' |
  -- 'admin_backfill'.
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.venue_intel_jobs IS
  'owner:agent. Wave 5B cohort rollup queue. Enqueue triggers: (a) the '
  'weekly cohort_rollup_sweep cron fires drift_refresh for any venue '
  'whose last_refreshed_at < 7 days, (b) /api/admin/intel/cohort-rollup-'
  'bulk fires manual_bulk per venue. Worker drains 5 jobs per tick '
  '(volume is per-venue not per-couple, so low). Migration 262.';

COMMENT ON COLUMN public.venue_intel_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text label so new triggers can land '
  'without a migration. Common values: weekly_cron | manual_bulk | '
  'drift_refresh | admin_backfill.';

CREATE INDEX IF NOT EXISTS idx_venue_intel_jobs_dequeue
  ON public.venue_intel_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_venue_intel_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 5. Partial index so the queue stays cheap even after years of '
  'done/failed historical rows.';

CREATE INDEX IF NOT EXISTS idx_venue_intel_jobs_venue
  ON public.venue_intel_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_venue_intel_jobs_venue IS
  '24h dedupe lookup: "is there already a queued/running rollup job for '
  'this venue within the last 24h?" Avoids double-spending Sonnet on '
  'manual bursts.';

-- ============================================================================
-- STEP 3 — RLS (mirrors couple_intel pattern, scoped on venue_id)
-- ============================================================================

ALTER TABLE public.venue_intel ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_intel_auth_select"
  ON public.venue_intel;
CREATE POLICY "venue_intel_auth_select"
  ON public.venue_intel
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "venue_intel_auth_insert"
  ON public.venue_intel;
CREATE POLICY "venue_intel_auth_insert"
  ON public.venue_intel
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "venue_intel_auth_update"
  ON public.venue_intel;
CREATE POLICY "venue_intel_auth_update"
  ON public.venue_intel
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

ALTER TABLE public.venue_intel_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_intel_jobs_auth_select"
  ON public.venue_intel_jobs;
CREATE POLICY "venue_intel_jobs_auth_select"
  ON public.venue_intel_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "venue_intel_jobs_auth_insert"
  ON public.venue_intel_jobs;
CREATE POLICY "venue_intel_jobs_auth_insert"
  ON public.venue_intel_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "venue_intel_jobs_auth_update"
  ON public.venue_intel_jobs;
CREATE POLICY "venue_intel_jobs_auth_update"
  ON public.venue_intel_jobs
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


-- ==============================================================================
-- 263_marketing_spend.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 263_marketing_spend.sql
-- ---------------------------------------------------------------------------
-- Wave 6A — marketing spend ingestion + persona-aware attribution overlay.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 6 closes the forensic loop: ROI per
--     persona per channel)
--   - bloom-wave4-5-6-master-plan.md (6A spec)
--   - bloom-phase-b-decisions.md (attribution_events created in Phase B,
--     mig 105 — Wave 6A extends with persona_overlay; does NOT rebuild)
--
-- Why this migration exists
-- -------------------------
-- Marketing ROI requires two new substrates:
--   1. Per-day per-campaign spend records — finer than the legacy
--      monthly aggregate `marketing_spend` table from mig 003 (which is
--      kept intact). Wave 6A's ingestion is per-day per-channel per-
--      campaign with cents granularity, multi-currency aware, and
--      tracks which connector wrote each row for audit.
--   2. Persona overlay on attribution_events — joins each first-touch
--      decision (from Phase B) to the persona_label discovered by
--      Wave 5A's couple_intel synthesizer, so 6B's rollups can answer
--      "which channel acquired this persona?"
--
-- Naming choice: this file uses `marketing_spend_records` (not
-- `marketing_spend`) to avoid colliding with the legacy monthly-
-- aggregate table from mig 003. The legacy table stays in service for
-- the existing /intel/sources monthly summaries; new fine-grained
-- ingestion lands here.
--
-- What is NOT in this migration:
--   * Live Google Ads / Meta / TikTok integrations (Wave 6A2 — needs
--     OAuth + rate limit handling, separate work).
--   * Persona × channel rollups (Wave 6B).
--   * Cron registration (added by reconciliation stream after parallel
--     waves merge — see TODO in spend-sync-sweep.ts).
--   * Modifications to attribution_events.role (Wave 7B owns).
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS
-- or DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — marketing_spend_records (one row per spend record)
-- ============================================================================
-- Per-day per-campaign granularity. Cents not float to avoid rounding
-- error when summing across thousands of rows. source_platform_metadata
-- stores the raw API response so a re-ingest after a connector bug fix
-- is possible without re-fetching.

CREATE TABLE IF NOT EXISTS public.marketing_spend_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Free-text channel string. Common values: google_ads | meta_ads |
  -- tiktok_ads | theknot_fee | weddingwire_fee | organic_seo |
  -- vendor_referral | other. Free-text so UK venues (Hitched /
  -- Bridebook) and new platforms can land without a schema change.
  channel text NOT NULL,
  -- Platform-specific identifier. NULL for manual / fee entries that
  -- don't have a campaign concept (e.g. flat Knot listing fee).
  campaign_id text,
  campaign_name text,
  -- The date the spend OCCURRED, not when it was ingested. So a
  -- backfill can land 30 days of historical data and roll up correctly
  -- by spend_date.
  spend_date date NOT NULL,
  -- Always cents to avoid float math. UI converts at display time.
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'USD',
  -- Raw connector payload for debugging / re-ingest. Stored verbatim.
  source_platform_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  -- Free-text label of how this row landed: 'manual' |
  -- 'google_ads_connector' | 'meta_ads_connector' |
  -- 'tiktok_ads_connector' | 'theknot_manual' | 'csv_import' | etc.
  ingested_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_spend_records IS
  'owner:intelligence. Wave 6A per-day per-campaign spend ingestion. '
  'Cents granularity (no float rounding). One row per (venue, channel, '
  'campaign_id, spend_date) — duplicate ingestion is idempotent via the '
  'unique constraint. Distinct from the legacy public.marketing_spend '
  '(mig 003) which holds monthly aggregates. Migration 263.';

COMMENT ON COLUMN public.marketing_spend_records.channel IS
  'Free-text channel identifier. Common values: google_ads | meta_ads | '
  'tiktok_ads | theknot_fee | weddingwire_fee | organic_seo | '
  'vendor_referral | other. Free-text so new platforms / regional '
  'platforms can land without migration.';

COMMENT ON COLUMN public.marketing_spend_records.spend_date IS
  'Date the spend OCCURRED. Used for ROI rollups. Distinct from '
  'ingested_at, which is when the row hit our DB.';

COMMENT ON COLUMN public.marketing_spend_records.amount_cents IS
  'Spend in cents (integer). Currency lives in `currency` column. '
  'Float math is forbidden when summing thousands of rows — use cents.';

COMMENT ON COLUMN public.marketing_spend_records.source_platform_metadata IS
  'Raw connector payload (campaign meta, impressions, clicks, etc). '
  'Stored verbatim so a re-ingest after a parser fix can rebuild '
  'rollups without re-fetching the API.';

COMMENT ON COLUMN public.marketing_spend_records.ingested_by IS
  'Free-text label of which writer landed this row. manual | '
  'google_ads_connector | meta_ads_connector | tiktok_ads_connector | '
  'theknot_manual | csv_import. Drives connector-health dashboards '
  '(when did the Google Ads connector last write a row?).';

-- Idempotent ingestion: re-running a connector for the same date /
-- campaign should NOT create duplicate rows. The unique constraint
-- enforces this; the service layer uses ON CONFLICT DO NOTHING.
-- For manual / fee entries with NULL campaign_id, COALESCE gives a
-- sentinel so the unique constraint still distinguishes channels.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketing_spend_records_dedupe
  ON public.marketing_spend_records (
    venue_id,
    channel,
    COALESCE(campaign_id, ''),
    spend_date
  );

COMMENT ON INDEX public.uniq_marketing_spend_records_dedupe IS
  'Idempotent ingestion key. Re-running a connector for the same '
  '(venue, channel, campaign, date) is a no-op via ON CONFLICT DO '
  'NOTHING. NULL campaign_id collapses to '''' so manual fee entries '
  'still dedupe per (channel, date).';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_records_venue_date
  ON public.marketing_spend_records (venue_id, spend_date DESC);

COMMENT ON INDEX public.idx_marketing_spend_records_venue_date IS
  'Hot-path: "show me last 30 days of spend for this venue", "summary '
  'for this month", "trailing 12 months trend chart".';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_records_venue_channel_date
  ON public.marketing_spend_records (venue_id, channel, spend_date);

COMMENT ON INDEX public.idx_marketing_spend_records_venue_channel_date IS
  'Per-channel trend lookups: "trailing 90 days of Google Ads spend".';

-- ============================================================================
-- STEP 2 — marketing_spend_jobs (queue table for async ingestion)
-- ============================================================================
-- Mirror of identity_reconstruction_jobs (mig 260) and couple_intel_jobs
-- (mig 261). Spend-sync-sweep cron drains this queue per venue per
-- connector. For Wave 6A the connectors are stubs, so the queue mostly
-- stays empty — but the schema lands now so 6A2 can fill it without
-- another migration.

CREATE TABLE IF NOT EXISTS public.marketing_spend_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Which connector this job targets. Same free-text vocabulary as
  -- marketing_spend_records.channel.
  connector text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of what kicked this job. 'manual_sync' |
  -- 'spend_sync_sweep_cron' | 'admin_backfill'.
  trigger_signal text,
  -- Optional payload — connector-specific (e.g. date range to fetch).
  payload jsonb DEFAULT '{}'::jsonb,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  rows_ingested integer NOT NULL DEFAULT 0,
  error_text text
);

COMMENT ON TABLE public.marketing_spend_jobs IS
  'owner:intelligence. Wave 6A spend-ingestion queue. Workers drain via '
  'spend-sync-sweep cron (registration deferred to reconciliation '
  'stream — see spend-sync-sweep.ts TODO). Each job represents one '
  '(venue, connector) sync attempt. rows_ingested reports how many new '
  'spend rows landed. Migration 263.';

COMMENT ON COLUMN public.marketing_spend_jobs.connector IS
  'Which connector to run. Common values: google_ads | meta_ads | '
  'tiktok_ads | theknot_manual. Free-text so future connectors can '
  'land without migration.';

COMMENT ON COLUMN public.marketing_spend_jobs.payload IS
  'Connector-specific input. Examples: { "since": "2026-04-01", '
  '"until": "2026-04-30" } for date-range backfill.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_jobs_dequeue
  ON public.marketing_spend_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_marketing_spend_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued''.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_jobs_venue
  ON public.marketing_spend_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_marketing_spend_jobs_venue IS
  'Per-venue connector-health queries: "when did this venue last sync '
  'Google Ads?", "any failed syncs in the last 24h?"';

-- ============================================================================
-- STEP 3 — venue_config.spend_auto_sync_enabled
-- ============================================================================
-- Per-venue toggle for the daily sync cron. Defaults to false — venues
-- opt in per connector by populating their OAuth credentials elsewhere
-- (Wave 6A2). The sweep service iterates venues with this flag true.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS spend_auto_sync_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venue_config.spend_auto_sync_enabled IS
  'Wave 6A. When true, the spend-sync-sweep cron will attempt to drain '
  'configured connectors for this venue. Defaults false so opting in '
  'is explicit. Wave 6A2 wires per-connector credentials.';

-- ============================================================================
-- STEP 4 — attribution_events.persona_overlay (Wave 6A extension)
-- ============================================================================
-- Snapshot of couple_intel.persona_label at the time the overlay was
-- attached, so 6B's rollup can join attribution → persona without a
-- runtime triple-join. Idempotent re-attach refreshes the snapshot.
--
-- Shape:
--   {
--     "persona_label": string,
--     "persona_confidence": int,
--     "derived_at": timestamp,
--     "couple_intel_id": uuid | null
--   }
--
-- Wave 7B owns attribution_events.role; this migration ONLY adds
-- persona_overlay. No other column touched.

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS persona_overlay jsonb;

COMMENT ON COLUMN public.attribution_events.persona_overlay IS
  'Wave 6A. Snapshot of couple_intel.persona_label at the time the '
  'overlay was attached. Shape: { persona_label, persona_confidence, '
  'derived_at, couple_intel_id }. Lets Wave 6B''s rollup answer '
  '"which channel acquired this persona" without a runtime triple-'
  'join. Refreshed when couple_intel is re-derived. NULL until the '
  'first attach (couples without intel never get a value).';

CREATE INDEX IF NOT EXISTS idx_attribution_events_persona_overlay_label
  ON public.attribution_events ((persona_overlay->>'persona_label'))
  WHERE persona_overlay IS NOT NULL AND reverted_at IS NULL;

COMMENT ON INDEX public.idx_attribution_events_persona_overlay_label IS
  'Wave 6A. Persona × channel rollup index — speeds GROUP BY '
  'persona_overlay->>persona_label, source_platform queries. Filter '
  'on reverted_at IS NULL so reversed attributions don''t double-'
  'count.';

-- ============================================================================
-- STEP 5 — RLS (mirror couple_identity_profile pattern)
-- ============================================================================
-- Authenticated users see their own venue's rows. Service-role
-- bypasses RLS for the orchestrator + crons + admin endpoints. No
-- anon access — internal ops surface only.

ALTER TABLE public.marketing_spend_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_spend_records_auth_select"
  ON public.marketing_spend_records;
CREATE POLICY "marketing_spend_records_auth_select"
  ON public.marketing_spend_records
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_spend_records_auth_insert"
  ON public.marketing_spend_records;
CREATE POLICY "marketing_spend_records_auth_insert"
  ON public.marketing_spend_records
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_spend_records_auth_update"
  ON public.marketing_spend_records;
CREATE POLICY "marketing_spend_records_auth_update"
  ON public.marketing_spend_records
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

DROP POLICY IF EXISTS "marketing_spend_records_auth_delete"
  ON public.marketing_spend_records;
CREATE POLICY "marketing_spend_records_auth_delete"
  ON public.marketing_spend_records
  FOR DELETE
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

ALTER TABLE public.marketing_spend_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_spend_jobs_auth_select"
  ON public.marketing_spend_jobs;
CREATE POLICY "marketing_spend_jobs_auth_select"
  ON public.marketing_spend_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_spend_jobs_auth_insert"
  ON public.marketing_spend_jobs;
CREATE POLICY "marketing_spend_jobs_auth_insert"
  ON public.marketing_spend_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_spend_jobs_auth_update"
  ON public.marketing_spend_jobs;
CREATE POLICY "marketing_spend_jobs_auth_update"
  ON public.marketing_spend_jobs
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


-- ==============================================================================
-- 264_attribution_role.sql
-- ==============================================================================
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


-- ==============================================================================
-- 265_intel_matches.sql
-- ==============================================================================
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


-- ==============================================================================
-- 266_persona_channel_rollups.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 266_persona_channel_rollups.sql
-- ---------------------------------------------------------------------------
-- Wave 6B — persona × channel × revenue rollups.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 6 closes the forensic loop: ROI per
--     persona per channel reveals what aggregate-channel ROI hides)
--   - bloom-wave4-5-6-master-plan.md (6B: rollup table reading from
--     attribution_events.persona_overlay (mig 263) + marketing_spend_records
--     (mig 263) + weddings.booking_value (mig 181))
--   - bloom-phase-b-decisions.md (attribution_events is the source of truth
--     for first-touch — Wave 6B only READS, never modifies)
--   - feedback_parallel_stream_safety.md (Wave 6B holds migration 266;
--     Wave 5C holds 265 in parallel)
--
-- Why this migration exists
-- -------------------------
-- ROI per channel without persona overlay is a lie. "Knot brings 100 leads,
-- 5% convert" hides that "Knot brings 70% Cost-Conscious at 3% conversion +
-- 30% Heritage-Forward at 11% conversion." Wave 6B writes one row per cell
-- in the (channel × persona × time-window) matrix so the dashboard can
-- reveal the real story instead of the channel-aggregate fiction.
--
-- The cohort-size threshold (n ≥ 10) is enforced at write time via the
-- n_too_small flag — small cohorts get NULL'd numerics to prevent the
-- dashboard from rendering misleading "this channel has 22% conversion"
-- when the cell has 2 weddings.
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — persona_channel_rollups (one row per cell of the matrix)
-- ============================================================================
-- Cell key: (venue_id, channel, persona_label, time_window_start,
-- time_window_end). persona_label may be NULL when the cell rolls up
-- attributions that didn't have a persona overlay attached yet —
-- equivalent to "untagged" in the heatmap.

CREATE TABLE IF NOT EXISTS public.persona_channel_rollups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Free-text channel string. Mirrors the vocabulary used by Wave 6A's
  -- marketing_spend_records.channel + attribution_events.source_platform.
  -- Common values: google_ads | meta_ads | tiktok_ads | theknot_fee |
  -- weddingwire_fee | organic_seo | vendor_referral | other.
  channel text NOT NULL,

  -- Persona discovered by Wave 5A's couple_intel. NULL means "no persona
  -- overlay yet" — so a couple whose intel hasn't been derived rolls up
  -- under a single (channel, NULL) cell. Operator reads this as "we
  -- haven't tagged these yet" rather than as a persona name.
  persona_label text,

  time_window_start date NOT NULL,
  time_window_end date NOT NULL,

  -- Metrics. Cents on monetary fields to match the rest of the platform.
  spend_cents int NOT NULL DEFAULT 0,
  inquiries_count int NOT NULL DEFAULT 0,
  touring_count int NOT NULL DEFAULT 0,
  booked_count int NOT NULL DEFAULT 0,
  lost_count int NOT NULL DEFAULT 0,
  total_booked_value_cents int NOT NULL DEFAULT 0,

  -- Derived metrics. NULL when n_too_small=true so the dashboard never
  -- renders a misleading number. CAC is also NULL when booked_count=0.
  cac_cents int,
  conversion_pct numeric(5,2),
  avg_booking_value_cents int,
  ltv_cents int,
  roi_pct numeric(7,2),
  payback_months numeric(5,2),

  -- True when the cohort underlying this cell is < 10. Drives the
  -- "n < 10" gray-out in the heatmap. Reads from inquiries_count +
  -- booked_count totals.
  n_too_small boolean NOT NULL DEFAULT false,

  computed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.persona_channel_rollups IS
  'owner:intelligence. Wave 6B persona × channel × time-window rollup. One '
  'row per cell of the (venue, channel, persona_label, window) matrix. '
  'Point-in-time (NOT cumulative) — recompute REPLACES all numerics + '
  'computed_at. Read by /intel/marketing-roi heatmap + summary endpoints. '
  'Migration 266.';

COMMENT ON COLUMN public.persona_channel_rollups.persona_label IS
  'Persona discovered by Wave 5A couple_intel. NULL = no overlay attached '
  'yet (couples without derived intel roll up under one (channel, NULL) '
  'cell). Heatmap labels NULL cells "untagged" so operator sees the gap.';

COMMENT ON COLUMN public.persona_channel_rollups.cac_cents IS
  'Customer acquisition cost in cents. spend_cents / booked_count. NULL '
  'when n_too_small=true (cohort < 10) or booked_count=0.';

COMMENT ON COLUMN public.persona_channel_rollups.conversion_pct IS
  'Booked / inquiries as a percentage. NULL when n_too_small=true. The '
  'dashboard renders only n ≥ 10 cells as a number; smaller cells are '
  'grayed out so the operator never reads a 50% conversion rate from a '
  '2-wedding cohort.';

COMMENT ON COLUMN public.persona_channel_rollups.ltv_cents IS
  'Lifetime value placeholder. Wave 6B initial implementation defaults to '
  'avg_booking_value_cents (one-shot wedding). When repeat-event tracking '
  'lands later, this column upgrades to the full LTV calc.';

COMMENT ON COLUMN public.persona_channel_rollups.roi_pct IS
  'Return on spend as a percentage. (total_booked_value_cents - '
  'spend_cents) / spend_cents × 100. NULL when spend_cents=0 or '
  'n_too_small=true.';

COMMENT ON COLUMN public.persona_channel_rollups.payback_months IS
  'Months to recover the spend at the cell-level monthly revenue run rate. '
  'spend_cents / (total_booked_value_cents / months_in_window). NULL when '
  'spend or booked value is zero.';

COMMENT ON COLUMN public.persona_channel_rollups.n_too_small IS
  'True when (inquiries_count + booked_count) < 10. Drives the "n < 10" '
  'gray-out in the heatmap. Numeric fields are NULL when this flag is '
  'set so the UI cannot accidentally render a misleading percentage.';

-- Idempotent rollup: re-running for the same cell key REPLACES the
-- numerics + computed_at. Persona_label is part of the key but can be
-- NULL — the unique constraint uses COALESCE so the NULL case still
-- dedupes to one row per (venue, channel, '', window).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_persona_channel_rollups_cell
  ON public.persona_channel_rollups (
    venue_id,
    channel,
    COALESCE(persona_label, ''),
    time_window_start,
    time_window_end
  );

COMMENT ON INDEX public.uniq_persona_channel_rollups_cell IS
  'One row per (venue, channel, persona, window) cell. NULL persona_label '
  'collapses to '''' so the un-tagged bucket dedupes to one row per '
  '(channel, window).';

CREATE INDEX IF NOT EXISTS idx_persona_channel_rollups_venue_window
  ON public.persona_channel_rollups (venue_id, time_window_end DESC);

COMMENT ON INDEX public.idx_persona_channel_rollups_venue_window IS
  'Hot-path: "show me the latest rollup window for this venue" — the '
  'heatmap endpoint reads by venue + window range.';

CREATE INDEX IF NOT EXISTS idx_persona_channel_rollups_venue_channel
  ON public.persona_channel_rollups (venue_id, channel);

COMMENT ON INDEX public.idx_persona_channel_rollups_venue_channel IS
  'Per-channel summary card lookups: "for this venue, all rollup cells '
  'tagged channel=google_ads".';

CREATE INDEX IF NOT EXISTS idx_persona_channel_rollups_venue_persona
  ON public.persona_channel_rollups (venue_id, persona_label);

COMMENT ON INDEX public.idx_persona_channel_rollups_venue_persona IS
  'Per-persona aggregation: "all cells tagged persona=heritage_forward '
  'across channels for this venue".';

-- ============================================================================
-- STEP 2 — RLS (mirror marketing_spend_records pattern from mig 263)
-- ============================================================================
-- Authenticated users see their own venue's rows. Service-role bypasses
-- RLS for the rollup writer + sweep cron + admin endpoints. No anon
-- access — internal ops surface only.

ALTER TABLE public.persona_channel_rollups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "persona_channel_rollups_auth_select"
  ON public.persona_channel_rollups;
CREATE POLICY "persona_channel_rollups_auth_select"
  ON public.persona_channel_rollups
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

-- Insert / update are reserved for service-role (the rollup writer is
-- the only legitimate writer). We don't grant authenticated INSERT
-- because no UI ever needs to write rows directly. Mirroring 263's
-- shape only as far as helpful — leaving inserts to service-role keeps
-- the cell-key invariants safe.
DROP POLICY IF EXISTS "persona_channel_rollups_auth_insert"
  ON public.persona_channel_rollups;
CREATE POLICY "persona_channel_rollups_auth_insert"
  ON public.persona_channel_rollups
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "persona_channel_rollups_auth_update"
  ON public.persona_channel_rollups;
CREATE POLICY "persona_channel_rollups_auth_update"
  ON public.persona_channel_rollups
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "persona_channel_rollups_auth_delete"
  ON public.persona_channel_rollups;
CREATE POLICY "persona_channel_rollups_auth_delete"
  ON public.persona_channel_rollups
  FOR DELETE
  TO authenticated
  USING (false);

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ==============================================================================
-- 267_intel_discoveries.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 267_intel_discoveries.sql
-- ---------------------------------------------------------------------------
-- Wave 7A — pattern discovery engine (the unknown-unknowns hunter).
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction is the thesis;
--     Wave 7A is THE differentiator vs every other CRM — it tells the
--     operator what they DON'T know, not what they do).
--   - bloom-wave4-5-6-master-plan.md (Wave 7A spec — discovery, not
--     classification. Free-form output. The LLM invents the hypothesis
--     category instead of filling a pre-defined bucket).
--   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. The discovery
--     engine sees ANONYMISED rollups only — never names couples).
--   - feedback_parallel_stream_safety.md (migration 267 is pre-allocated
--     for Wave 7A; Wave 5D owns 268, Wave 6C owns 269).
--
-- Why this migration exists (and why it's structurally different from 5/6)
-- ------------------------------------------------------------------------
-- Wave 4 reconstructs WHO each couple is. Wave 5 derives PER-COUPLE,
-- COHORT, and EXTERNAL-MATCH intel inside pre-defined buckets. Wave 6
-- closes the marketing-ROI loop along persona × channel × revenue cells
-- the schema fixes upfront.
--
-- Wave 7A is a different KIND of LLM job. The seed prompts (channel-role
-- distortion, vendor referrals not formally tracked, persona × channel
-- patterns, stale-but-warm leads, booking-blocker questions, time-of-day
-- inquiry patterns, cross-platform identity drift, competitor positioning,
-- demographic clustering, conversion-rate disparity) are EXAMPLES — not
-- an enum. The LLM is given freedom to invent the hypothesis_category
-- because the whole point is hunting for things the operator (and the
-- schema designers) don't know to look for.
--
-- Storage shape:
--   * intel_discoveries — one row per discovered hypothesis. New runs
--     INSERT new rows (audit history); a follow-up dedupe pass may merge
--     near-duplicate titles in the same recent window — that's a Wave 7A
--     follow-up, not blocking.
--   * intel_discovery_jobs — queue table, mirrors intel_match_jobs.
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — intel_discoveries (one row per discovered hypothesis)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intel_discoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Short headline ("Knot may be a validation channel for 30% of leads").
  -- Capped at 200 chars; the prompt asks for < 80 but we leave headroom.
  hypothesis_title text NOT NULL,
  -- Full hypothesis paragraph. Free-form prose explaining the pattern,
  -- the evidence, and what the operator should consider testing.
  hypothesis_text text NOT NULL,
  -- LLM-INVENTED category, free-form. Examples (NOT enforced):
  --   'channel_role_distortion'
  --   'vendor_referral_unobserved'
  --   'persona_channel_pattern'
  --   'stale_warm_lead'
  --   'booking_blocker_question'
  --   'time_of_day_pattern'
  --   'cross_platform_drift'
  --   'competitor_positioning'
  --   'demographic_clustering'
  --   'conversion_rate_disparity'
  -- The whole point of Wave 7A is the LLM may invent a NEW category we
  -- haven't anticipated. NEVER make this an enum or CHECK constraint.
  hypothesis_category text NOT NULL,
  -- Structured evidence chain — the LLM decides the shape based on the
  -- hypothesis, but we ALWAYS expect:
  --   { signal_type, n_couples, n_evidence_points, aggregate_stats: {...},
  --     key_observations: [string] }
  -- Aggregate ≠ disclose: NEVER includes couple names. Only sample IDs
  -- (hashed or never present), persona-level shares, theme-level counts,
  -- etc.
  evidence_summary jsonb NOT NULL,
  -- LLM's proposed validation test (Wave 7C will execute this).
  recommended_test text,
  -- LLM's proposed action when the test validates the hypothesis.
  -- The operator decides whether to run the action; Wave 7A NEVER auto-
  -- executes anything.
  recommended_action_if_validated text,
  -- 0-100 confidence based on the strength of the evidence chain.
  confidence_0_100 integer NOT NULL CHECK (
    confidence_0_100 >= 0 AND confidence_0_100 <= 100
  ),
  -- Triage state machine. Default 'pending' on insert. Wave 7C populates
  -- 'in_progress' / 'validated' / 'refuted'. Coordinator can dismiss
  -- directly without running the test.
  validation_status text NOT NULL DEFAULT 'pending' CHECK (
    validation_status IN ('pending', 'in_progress', 'validated', 'refuted', 'dismissed')
  ),
  -- Wave 7C populates these after running the test.
  validation_result_summary text,
  -- { p_value, lift, confidence_interval, n }
  validation_metric jsonb,
  validated_at timestamptz,
  -- Coordinator dismissal triage.
  dismissed_at timestamptz,
  dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dismissal_reason text,
  -- When the operator records that they took an action based on this
  -- discovery (independent of validation — sometimes a hypothesis is
  -- compelling enough to act on without a formal test).
  actioned_at timestamptz,
  action_taken text,
  -- Prompt version threaded into api_costs.prompt_version for regression
  -- audits.
  prompt_version text NOT NULL,
  -- Cost in cents (numeric to keep cents-and-fractions precision; matches
  -- venue_intel.cost_cents pattern).
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.intel_discoveries IS
  'owner:agent. Wave 7A pattern discovery engine output. One row per '
  'discovered hypothesis. hypothesis_category is FREE-FORM (LLM-invented) '
  'by design — Wave 7A hunts for unknown-unknowns, so the schema must not '
  'pre-define the categories. evidence_summary is anonymised aggregate '
  'evidence; NEVER contains couple names. validation_status moves from '
  'pending → in_progress → validated/refuted (via Wave 7C) or dismissed '
  '(coordinator triage). New runs INSERT new rows — preserve audit '
  'history. Migration 267.';

COMMENT ON COLUMN public.intel_discoveries.hypothesis_category IS
  'LLM-invented free-form category. Examples in master prompt include '
  'channel_role_distortion, vendor_referral_unobserved, persona_channel_'
  'pattern, stale_warm_lead, booking_blocker_question, time_of_day_'
  'pattern, cross_platform_drift, competitor_positioning. NOT an enum. '
  'The LLM may invent a brand-new category to capture a pattern we '
  'haven''t anticipated — that is the entire point of Wave 7A.';

COMMENT ON COLUMN public.intel_discoveries.evidence_summary IS
  'Anonymised aggregate evidence chain. Standard shape: { signal_type, '
  'n_couples, n_evidence_points, aggregate_stats: {...}, key_observations: '
  '[string] }. Aggregate ≠ disclose — NEVER name couples. Sample IDs are '
  'hashed or omitted; persona-level shares + theme-level counts are the '
  'safe surface.';

COMMENT ON COLUMN public.intel_discoveries.recommended_test IS
  'LLM''s proposed validation test. Wave 7C executes this; Wave 7A only '
  'authors it. Common shape: cohort comparison + statistical lift target.';

COMMENT ON COLUMN public.intel_discoveries.validation_status IS
  'pending (initial) | in_progress (Wave 7C is running the test) | '
  'validated | refuted | dismissed (coordinator triaged without testing). '
  'Validated discoveries feed back into Wave 5/6 as new buckets — Wave 7D '
  'closes that loop.';

-- Active discoveries index. Most-common dashboard query: pending
-- discoveries newest-first per venue.
CREATE INDEX IF NOT EXISTS idx_intel_discoveries_active_recent
  ON public.intel_discoveries (venue_id, validation_status, created_at DESC);

COMMENT ON INDEX public.idx_intel_discoveries_active_recent IS
  'Dashboard list: discoveries grouped by validation_status, newest first.';

-- Per-category slice. Dashboard groups visually by hypothesis_category
-- so coordinators can scan a wall of patterns by type.
CREATE INDEX IF NOT EXISTS idx_intel_discoveries_by_category
  ON public.intel_discoveries (venue_id, hypothesis_category);

COMMENT ON INDEX public.idx_intel_discoveries_by_category IS
  'Per-category visual grouping for the discoveries dashboard.';

-- Validation feedback loop. Wave 7D queries validated discoveries to
-- promote them into new Wave 5/6 buckets.
CREATE INDEX IF NOT EXISTS idx_intel_discoveries_validated
  ON public.intel_discoveries (venue_id, validated_at DESC)
  WHERE validation_status = 'validated';

COMMENT ON INDEX public.idx_intel_discoveries_validated IS
  'Feedback loop: Wave 7D promotes validated discoveries to new Wave 5/6 '
  'buckets / correlations / attribution rules.';

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_intel_discoveries_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_intel_discoveries_touch ON public.intel_discoveries;
CREATE TRIGGER trg_intel_discoveries_touch
  BEFORE UPDATE ON public.intel_discoveries
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_intel_discoveries_updated_at();

-- ============================================================================
-- STEP 2 — intel_discovery_jobs (queue table — mirrors intel_match_jobs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intel_discovery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.intel_discovery_jobs IS
  'owner:agent. Wave 7A discovery-engine queue. Enqueue triggers: '
  '(a) couple_intel volume threshold (e.g. every 25 new derives per '
  'venue, see TODO_TRIGGER in enqueue.ts); (b) drift_refresh from '
  'discovery_engine_sweep cron, weekly; (c) admin_backfill via /api/admin/'
  'intel/discoveries/run with force=true. Worker drains 3 jobs per tick '
  '(Sonnet calls are expensive — pacing matters). Migration 267.';

COMMENT ON COLUMN public.intel_discovery_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text: volume_threshold | drift_refresh | '
  'admin_backfill | manual_force.';

CREATE INDEX IF NOT EXISTS idx_intel_discovery_jobs_dequeue
  ON public.intel_discovery_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_intel_discovery_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=queued LIMIT 3.';

CREATE INDEX IF NOT EXISTS idx_intel_discovery_jobs_venue
  ON public.intel_discovery_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_intel_discovery_jobs_venue IS
  'Per-venue 24h dedupe lookup. Mirrors Wave 4/5A/5B/5C queue patterns.';

-- ============================================================================
-- STEP 3 — RLS (mirrors intel_matches pattern, scoped on venue_id)
-- ============================================================================

ALTER TABLE public.intel_discoveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intel_discoveries_auth_select"
  ON public.intel_discoveries;
CREATE POLICY "intel_discoveries_auth_select"
  ON public.intel_discoveries
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_discoveries_auth_insert"
  ON public.intel_discoveries;
CREATE POLICY "intel_discoveries_auth_insert"
  ON public.intel_discoveries
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_discoveries_auth_update"
  ON public.intel_discoveries;
CREATE POLICY "intel_discoveries_auth_update"
  ON public.intel_discoveries
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

ALTER TABLE public.intel_discovery_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intel_discovery_jobs_auth_select"
  ON public.intel_discovery_jobs;
CREATE POLICY "intel_discovery_jobs_auth_select"
  ON public.intel_discovery_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_discovery_jobs_auth_insert"
  ON public.intel_discovery_jobs;
CREATE POLICY "intel_discovery_jobs_auth_insert"
  ON public.intel_discovery_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_discovery_jobs_auth_update"
  ON public.intel_discovery_jobs;
CREATE POLICY "intel_discovery_jobs_auth_update"
  ON public.intel_discovery_jobs
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


-- ==============================================================================
-- 268_venue_thesis.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 268_venue_thesis.sql
-- ---------------------------------------------------------------------------
-- Wave 5D — Onboarding bootstrap (venue thesis) + cross-venue overlap.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 5D auto-generates a venue's "thesis" once
--     ~50 reconstructions have landed; cross-venue overlap surfaces shared
--     cohort signals at AGGREGATE level only — never name couples across
--     venue boundaries)
--   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
--   - bloom-data-integrity-sweep.md (aggregate ≠ disclose; cross-venue
--     comparison NEVER reads couple-level data — only the peer's
--     venue_thesis aggregate output)
--   - feedback_parallel_stream_safety.md (Wave 5D holds migration 268;
--     Wave 7A holds 267; Wave 6C holds 269 — pre-allocated by master plan)
--
-- Why this migration exists
-- -------------------------
-- A new venue should never be onboarded "blank". Once Wave 4 has produced
-- ~50 reconstructed couples, Wave 5D's Sonnet synthesizer reads that
-- substrate and produces a strategic identity reconstruction: archetype,
-- over-indexed personas vs market average, recurring emotional landscape,
-- conversion signature, voice thesis, service demand strengths + gaps,
-- and an operator-facing brief paragraph. Stored on venue_thesis (one row
-- per venue, upserted on regeneration).
--
-- At Wedgewood scale (100+ venues), cross_venue_overlap stores the
-- aggregate-only intersection between an anchor venue's thesis and each
-- peer venue's thesis: shared persona archetypes, shared emerging themes,
-- shared service-demand gaps, shared voice principles. The peer's
-- couple_identity_profile rows are NEVER read — only the peer's
-- venue_thesis aggregate. Privacy doctrine: aggregate ≠ disclose.
--
-- Storage shape:
--   * one venue_thesis row per venue (most-recent generation),
--   * a venue_thesis_jobs queue mirroring the venue_intel_jobs pattern
--     (status / trigger_signal / atomic-claim worker model),
--   * one cross_venue_overlap row per (anchor, peer) pair — unique
--     constraint enforces dedupe on regeneration.
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — venue_thesis (one row per venue)
-- ============================================================================
-- The thesis itself is a structured Sonnet output. The shape is locked by
-- src/config/prompts/venue-thesis.ts validateVenueThesisOutput, but stored
-- as jsonb so the prompt can evolve without a migration.

CREATE TABLE IF NOT EXISTS public.venue_thesis (
  venue_id uuid PRIMARY KEY REFERENCES public.venues(id) ON DELETE CASCADE,
  thesis jsonb NOT NULL,
  -- Snapshot of how many reconstructed couples were in scope when this
  -- thesis was generated. Hoisted out of the jsonb so the freshness card
  -- can render "synthesized from 47 couples" without parsing.
  couples_at_generation int NOT NULL,
  last_generated_at timestamptz NOT NULL DEFAULT now(),
  -- Generation count tracks how many times the thesis has been refreshed
  -- for this venue (initial + drifts + manual regenerations). Useful for
  -- spotting venues whose thesis has churned (thesis-instability is a
  -- diagnostic signal).
  generation_count int NOT NULL DEFAULT 1,
  prompt_version text NOT NULL,
  -- Cumulative cost across thesis generations for this venue.
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.venue_thesis IS
  'owner:intelligence. Wave 5D venue thesis — strategic identity '
  'reconstruction from the venue''s reconstructed couple cohort. One row '
  'per venue, upserted on (re)generation. Read by /admin/onboarding/'
  'thesis dashboard + VenueThesisPanel onboarding embed. Refresh '
  'trigger: every 25 new reconstructions OR weekly drift OR manual. '
  'Aggregate-not-disclose: thesis NEVER names couples; sensitive themes '
  'reach as count-only summaries. Cost target $0.10-$0.20 per generation '
  '(one Sonnet call). Migration 268.';

COMMENT ON COLUMN public.venue_thesis.thesis IS
  'Structured Sonnet output: venue_archetype (LLM-invented label, not '
  'enum), over_indexed_personas, recurring_emotional_landscape, '
  'conversion_signature, voice_thesis, service_demand_strengths, '
  'service_demand_gaps, operator_brief_paragraph, cohort_size_at_'
  'generation, refusals. Schema enforced by validateVenueThesisOutput in '
  'src/config/prompts/venue-thesis.ts.';

COMMENT ON COLUMN public.venue_thesis.couples_at_generation IS
  'Couples in scope at generation time. Hoisted from thesis.cohort_size_'
  'at_generation so freshness panels can render "from 47 couples" '
  'without parsing jsonb. Drives the "regenerate when cohort grew '
  '25%" drift policy in the sweep.';

COMMENT ON COLUMN public.venue_thesis.cost_cents IS
  'Cumulative dollar cost (in cents, sub-cent precision) of every '
  'generation for this venue. Each (re)generation adds the per-call cost '
  'on top of the existing cumulative.';

CREATE INDEX IF NOT EXISTS idx_venue_thesis_venue_generated
  ON public.venue_thesis (venue_id, last_generated_at DESC);

COMMENT ON INDEX public.idx_venue_thesis_venue_generated IS
  'Drift / freshness index. Sweep picks venues whose last_generated_at '
  'is older than 7 days OR whose cohort has grown ≥25% since last '
  'generation and enqueues a regeneration job.';

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_venue_thesis_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_thesis_touch ON public.venue_thesis;
CREATE TRIGGER trg_venue_thesis_touch
  BEFORE UPDATE ON public.venue_thesis
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_venue_thesis_updated_at();

-- ============================================================================
-- STEP 2 — venue_thesis_jobs (queue table)
-- ============================================================================
-- Same shape as venue_intel_jobs (mig 262) and couple_intel_jobs (mig 261).
-- Per-venue volume is low (one thesis per venue per week + occasional
-- 25-couple-step refreshes). Worker drains via cron dispatcher.

CREATE TABLE IF NOT EXISTS public.venue_thesis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of the signal that produced this enqueue.
  -- Common values: 'cohort_milestone' (every 25 reconstructions) |
  -- 'weekly_drift' | 'manual_force' | 'admin_backfill'.
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.venue_thesis_jobs IS
  'owner:intelligence. Wave 5D venue thesis queue. Enqueue triggers: '
  '(a) cohort_milestone fires when couple_identity_profile inserts cross '
  '25/50/75/100 multiples for a venue, (b) weekly_drift fires from the '
  'sweep when last_generated_at < 7 days, (c) manual_force from the '
  'admin endpoint. Worker drains 5 jobs per tick (low volume, one per '
  'venue per refresh). Migration 268.';

COMMENT ON COLUMN public.venue_thesis_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text label so new triggers can land '
  'without a migration. Common values: cohort_milestone | weekly_drift | '
  'manual_force | admin_backfill.';

CREATE INDEX IF NOT EXISTS idx_venue_thesis_jobs_dequeue
  ON public.venue_thesis_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_venue_thesis_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 5. Partial index so the queue stays cheap even after years of '
  'done/failed historical rows.';

CREATE INDEX IF NOT EXISTS idx_venue_thesis_jobs_venue
  ON public.venue_thesis_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_venue_thesis_jobs_venue IS
  '24h dedupe lookup: "is there already a queued/running thesis job for '
  'this venue within the last 24h?" Avoids double-spending Sonnet on '
  'milestone bursts.';

-- ============================================================================
-- STEP 3 — cross_venue_overlap (one row per (anchor, peer) pair)
-- ============================================================================
-- At Wedgewood scale (100+ venues), this surfaces shared cohort signals
-- across venue boundaries — at AGGREGATE level only. The peer's couple-
-- level rows are NEVER read; only the peer's venue_thesis aggregate
-- output is compared. Privacy: aggregate ≠ disclose. Never name couples
-- across venue boundaries.

CREATE TABLE IF NOT EXISTS public.cross_venue_overlap (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  peer_venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Structured overlap output. Fields documented in
  -- src/lib/services/intel/onboarding/cross-venue-overlap.ts:
  --   { shared_persona_archetypes, shared_emerging_themes,
  --     shared_service_demand_gaps, shared_voice_principles,
  --     anchor_venue_label, peer_venue_label, computation_notes }
  -- All values are aggregate text labels — no couple-level data.
  overlap_jsonb jsonb NOT NULL,
  -- 0-100 scalar. Higher = more overlap. Computed as a weighted blend of
  -- archetype intersection / theme intersection / gap intersection /
  -- voice intersection. Used by the dashboard to rank peers.
  confidence_0_100 int NOT NULL CHECK (confidence_0_100 BETWEEN 0 AND 100),
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- Anchor / peer must differ. A venue overlapping with itself is a noop.
ALTER TABLE public.cross_venue_overlap
  DROP CONSTRAINT IF EXISTS cross_venue_overlap_distinct_chk;
ALTER TABLE public.cross_venue_overlap
  ADD CONSTRAINT cross_venue_overlap_distinct_chk
  CHECK (anchor_venue_id <> peer_venue_id);

-- One row per (anchor, peer). Re-running overlap computation upserts the
-- existing row rather than appending. The pair is directional: A→B and
-- B→A are separate rows so each anchor sees its own RLS-scoped view.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cross_venue_overlap_pair
  ON public.cross_venue_overlap (anchor_venue_id, peer_venue_id);

COMMENT ON INDEX public.uniq_cross_venue_overlap_pair IS
  'One row per (anchor, peer) directional pair. Regenerating overlap for '
  'an anchor REPLACES the row rather than appending.';

CREATE INDEX IF NOT EXISTS idx_cross_venue_overlap_anchor
  ON public.cross_venue_overlap (anchor_venue_id, computed_at DESC);

COMMENT ON INDEX public.idx_cross_venue_overlap_anchor IS
  'Hot-path: list overlaps for the current venue, newest first. Drives '
  'the cross-venue sidebar on /admin/onboarding/thesis.';

COMMENT ON TABLE public.cross_venue_overlap IS
  'owner:intelligence. Wave 5D cross-venue cohort overlap. One row per '
  '(anchor_venue, peer_venue) directional pair holding the AGGREGATE-'
  'level intersection between anchor and peer venue_thesis outputs. '
  'NEVER reads couple-level data across venue boundaries — only '
  'venue_thesis.thesis. Privacy doctrine: aggregate ≠ disclose. RLS '
  'enforces anchor-only visibility (a venue sees only the rows where it '
  'is the anchor, never rows where it is the peer being compared TO '
  'another venue). Migration 268.';

COMMENT ON COLUMN public.cross_venue_overlap.overlap_jsonb IS
  'Structured aggregate-only overlap output. Contains shared archetype '
  'labels, shared theme labels, shared service-demand gap labels, shared '
  'voice principles. NEVER couple names, NEVER evidence quotes, NEVER '
  'per-couple counts.';

COMMENT ON COLUMN public.cross_venue_overlap.confidence_0_100 IS
  'Weighted blend (archetype 30% / themes 25% / gaps 25% / voice 20%) '
  'of intersection-over-union ratios. Used by the dashboard to rank '
  'peers by similarity.';

-- ============================================================================
-- STEP 4 — RLS
-- ============================================================================
-- venue_thesis: standard venue-scoped pattern (mirror of venue_intel).
-- venue_thesis_jobs: same.
-- cross_venue_overlap: anchor_venue_id-scoped — the user only sees rows
-- where THEIR venue is the anchor. They never see rows where their venue
-- is the peer being compared INTO another venue (that's the other
-- venue's view, not theirs). This is the privacy invariant.

ALTER TABLE public.venue_thesis ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_thesis_auth_select"
  ON public.venue_thesis;
CREATE POLICY "venue_thesis_auth_select"
  ON public.venue_thesis
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

-- Insert / update reserved for service-role. The thesis writer is the
-- only legitimate writer; no UI ever inserts directly. Mirrors
-- persona_channel_rollups (mig 266).
DROP POLICY IF EXISTS "venue_thesis_auth_insert"
  ON public.venue_thesis;
CREATE POLICY "venue_thesis_auth_insert"
  ON public.venue_thesis
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "venue_thesis_auth_update"
  ON public.venue_thesis;
CREATE POLICY "venue_thesis_auth_update"
  ON public.venue_thesis
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "venue_thesis_auth_delete"
  ON public.venue_thesis;
CREATE POLICY "venue_thesis_auth_delete"
  ON public.venue_thesis
  FOR DELETE
  TO authenticated
  USING (false);

ALTER TABLE public.venue_thesis_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_thesis_jobs_auth_select"
  ON public.venue_thesis_jobs;
CREATE POLICY "venue_thesis_jobs_auth_select"
  ON public.venue_thesis_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "venue_thesis_jobs_auth_insert"
  ON public.venue_thesis_jobs;
CREATE POLICY "venue_thesis_jobs_auth_insert"
  ON public.venue_thesis_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "venue_thesis_jobs_auth_update"
  ON public.venue_thesis_jobs;
CREATE POLICY "venue_thesis_jobs_auth_update"
  ON public.venue_thesis_jobs
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.cross_venue_overlap ENABLE ROW LEVEL SECURITY;

-- ANCHOR-SCOPED RLS: a venue sees rows where it is the ANCHOR only.
-- It does NOT see rows where it is the peer being compared to another
-- venue. Privacy invariant — peer view leaks the other venue's anchor
-- intent, which is operator-private.
DROP POLICY IF EXISTS "cross_venue_overlap_anchor_select"
  ON public.cross_venue_overlap;
CREATE POLICY "cross_venue_overlap_anchor_select"
  ON public.cross_venue_overlap
  FOR SELECT
  TO authenticated
  USING (
    anchor_venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

-- Writes reserved for service-role (the overlap detector is the only
-- legitimate writer).
DROP POLICY IF EXISTS "cross_venue_overlap_anchor_insert"
  ON public.cross_venue_overlap;
CREATE POLICY "cross_venue_overlap_anchor_insert"
  ON public.cross_venue_overlap
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "cross_venue_overlap_anchor_update"
  ON public.cross_venue_overlap;
CREATE POLICY "cross_venue_overlap_anchor_update"
  ON public.cross_venue_overlap
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "cross_venue_overlap_anchor_delete"
  ON public.cross_venue_overlap;
CREATE POLICY "cross_venue_overlap_anchor_delete"
  ON public.cross_venue_overlap
  FOR DELETE
  TO authenticated
  USING (false);

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ==============================================================================
-- 269_marketing_recommendations.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 269_marketing_recommendations.sql
-- ---------------------------------------------------------------------------
-- Wave 6C — marketing reallocation recommendations.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 6 closes the forensic loop. Wave 6B
--     produces the persona × channel × ROI matrix; Wave 6C turns it into
--     actionable reallocation recommendations a coordinator can act on.)
--   - bloom-wave4-5-6-master-plan.md (Wave 6C spec: Sonnet recommendation
--     job reads (rollups + cohort intel + external signals) and outputs
--     specific reallocation moves with reasoning chain + confidence +
--     counterfactual.)
--   - feedback_parallel_stream_safety.md (Wave 6C holds migration 269;
--     Wave 7A holds 267, Wave 5D holds 268. We don't write into anyone
--     else's lane and we don't touch their writer code.)
--
-- Why this migration exists
-- -------------------------
-- Without explicit recommendations, the operator has to read the heatmap
-- and self-diagnose what to do. With recommendations, the system says
-- "Move 30% of Knot spend ($800/mo) to Instagram. Knot brings Heritage-
-- Forward at $180 CAC, you book 8%; Instagram brings Heritage-Forward at
-- $90 CAC, 22% conversion. Projected: +$14k/yr." Each recommendation
-- carries a reasoning chain, a counterfactual ("what happens if we DON'T
-- reallocate"), a payback timeline, and confidence — so the coordinator
-- can audit the math, not just the verdict.
--
-- Doctrine
-- --------
-- Recommendations are FLAG-DON'T-EXECUTE. The system never auto-spends.
-- Status defaults to 'pending'; coordinator decides accept / decline /
-- in-progress; the optional measure-after step lets the operator track
-- whether the projected impact actually showed up.
--
-- Cohort threshold
-- ----------------
-- n_too_small_warning fires when the source or target cell underlying
-- the recommendation has < 10 weddings. The LLM's job is to refuse such
-- cases explicitly; the boolean column is the belt-and-suspenders flag
-- the dashboard uses to soft-warn even when the LLM tried to recommend.
--
-- Idempotent: every CREATE TABLE / CREATE INDEX / CREATE POLICY uses
-- IF NOT EXISTS or DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — marketing_recommendations (one row per recommendation)
-- ============================================================================
-- Each generation pass produces 3-5 rows. Re-running on unchanged input
-- (same input_data_hash) is short-circuited at the service layer — last
-- week's recommendation stands. Re-running with new data inserts new
-- rows; old rows stay (audit trail of the system's evolving advice).

CREATE TABLE IF NOT EXISTS public.marketing_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Short headline ("Move 30% of Knot spend to Instagram"). < 80 chars
  -- recommended; the LLM is asked to keep it tight enough to use as a
  -- card title.
  recommendation_title text NOT NULL,

  -- Full reasoning paragraph. The "story" the operator reads first
  -- before drilling into reasoning_chain.
  recommendation_text text NOT NULL,

  -- Drives card visuals (arrow, badge color) on the dashboard.
  --   reallocate  — move spend from source_channel → target_channel
  --   pause       — stop spending on source_channel
  --   scale       — increase spend on target_channel
  --   investigate — data quality issue or anomaly that needs a human
  --   other       — anything else (let LLM be honest about the shape)
  action_type text NOT NULL
    CHECK (action_type IN ('reallocate', 'pause', 'scale', 'investigate', 'other')),

  -- Channels the recommendation references. NULL when the
  -- recommendation isn't about a specific channel pair (e.g. an
  -- 'investigate' recommendation about untagged personas).
  source_channel text,
  target_channel text,

  -- The persona this recommendation centers on. NULL when the
  -- recommendation is channel-level only (cross-persona generalisation).
  target_persona text,

  -- Projected revenue lift in cents per month. SIGNED:
  --   positive — expected upside (scale, reallocate to better cell)
  --   negative — expected downside the operator absorbs (pause cost
  --              reduction is positive; pause revenue loss would be a
  --              negative number on a different rec)
  -- Cents not dollars to match the rest of the platform.
  estimated_monthly_dollar_impact_cents int,

  confidence_0_100 int NOT NULL CHECK (confidence_0_100 BETWEEN 0 AND 100),

  -- Structured reasoning chain. Required keys:
  --   evidence_signals: [string] — specific cell numbers cited
  --   assumed_baseline: string  — what the rec assumes "today" looks like
  --   projected_outcome: string — what the rec predicts post-action
  --   counterfactual: string    — what happens if we DON'T act
  --   payback_months: number    — how long until impact materialises
  --   key_risks: [string]       — what could falsify the projection
  reasoning_chain jsonb NOT NULL,

  -- Hash of (rollups + cohort_intel + external signals) input. Lets the
  -- service layer short-circuit "input hasn't changed → last week's
  -- recommendation stands".
  input_data_hash text NOT NULL,

  -- Belt-and-suspenders flag for "the source cohort underlying this
  -- recommendation has < 10 weddings". Drives the soft-warn chip on the
  -- dashboard even when the LLM produced a confident-sounding rec.
  n_too_small_warning boolean NOT NULL DEFAULT false,

  generated_at timestamptz NOT NULL DEFAULT now(),

  -- Lifecycle:
  --   pending      — newly generated, awaiting coordinator decision
  --   accepted     — coordinator approved (next state: in_progress)
  --   declined     — coordinator rejected (terminal)
  --   in_progress  — accepted + operator is implementing
  --   completed    — implementation done; measured_outcome may be set
  --   invalidated  — superseded by newer data; auto-set when re-gen
  --                  produces a contradicting rec
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'accepted', 'declined', 'in_progress', 'completed', 'invalidated'
    )),

  decided_at timestamptz,
  decided_by uuid REFERENCES auth.users(id),
  decision_note text,
  actioned_at timestamptz,

  -- Post-action measurement. Operator records actual outcome here so
  -- the system can compare projected vs measured and tune confidence
  -- over time. Cents.
  measured_outcome_cents int,

  prompt_version text NOT NULL,
  -- Cumulative API cost (cents) attributable to this recommendation
  -- generation pass. numeric(10,4) matches the api_costs.cost convention
  -- (sub-cent precision for tiny calls).
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_recommendations IS
  'owner:intelligence. Wave 6C reallocation recommendations. One row per '
  'specific recommendation produced by the Sonnet analyst. Read by '
  '/intel/marketing-roi/recommendations dashboard + the embedded '
  'MarketingRecommendationsPanel. FLAG-DON''T-EXECUTE: the system never '
  'auto-spends; status defaults to ''pending'' awaiting coordinator '
  'decision. Migration 269.';

COMMENT ON COLUMN public.marketing_recommendations.recommendation_title IS
  'Short headline (< 80 chars). Used as a card title. The LLM is asked '
  'to keep it tight; the dashboard truncates beyond that.';

COMMENT ON COLUMN public.marketing_recommendations.action_type IS
  'reallocate | pause | scale | investigate | other. Drives the card '
  'visuals (arrow, badge color). investigate is the LLM''s honest signal '
  'when the data is too thin to recommend a spend move.';

COMMENT ON COLUMN public.marketing_recommendations.estimated_monthly_dollar_impact_cents IS
  'Projected lift in cents per month. SIGNED — positive for upside (scale, '
  'better-cell reallocation), negative for downside the operator absorbs. '
  'Cents not dollars to match the rest of the platform.';

COMMENT ON COLUMN public.marketing_recommendations.reasoning_chain IS
  'Structured reasoning. Required keys: evidence_signals (string array of '
  'specific cell numbers cited), assumed_baseline (string), '
  'projected_outcome (string), counterfactual (what happens if we DON''T '
  'reallocate), payback_months (number), key_risks (string array).';

COMMENT ON COLUMN public.marketing_recommendations.input_data_hash IS
  'Hash of the input dataset (rollups + cohort_intel + external signals). '
  'Service layer short-circuits "same hash → last week''s rec stands" so '
  'unchanged data does not produce duplicate rows.';

COMMENT ON COLUMN public.marketing_recommendations.n_too_small_warning IS
  'True when the cohort underlying this rec has < 10 weddings (source or '
  'target cell). Belt-and-suspenders flag even when the LLM tried to '
  'recommend; the dashboard renders a soft-warn chip so the coordinator '
  'reads the rec with the right grain of salt.';

COMMENT ON COLUMN public.marketing_recommendations.status IS
  'Lifecycle: pending → accepted → in_progress → completed (or declined / '
  'invalidated terminal). Wave 6C never auto-progresses status — every '
  'transition is operator-decided.';

COMMENT ON COLUMN public.marketing_recommendations.measured_outcome_cents IS
  'Post-action measurement. Operator records actual revenue impact in '
  'cents so the dashboard can show projected vs measured (variance pct). '
  'Feeds future confidence calibration.';

CREATE INDEX IF NOT EXISTS idx_marketing_recommendations_venue_status_generated
  ON public.marketing_recommendations (venue_id, status, generated_at DESC);

COMMENT ON INDEX public.idx_marketing_recommendations_venue_status_generated IS
  'Hot-path: dashboard reads "pending recs for this venue, newest first". '
  'Status filter is the most common scope.';

CREATE INDEX IF NOT EXISTS idx_marketing_recommendations_venue_source_channel
  ON public.marketing_recommendations (venue_id, source_channel)
  WHERE source_channel IS NOT NULL;

COMMENT ON INDEX public.idx_marketing_recommendations_venue_source_channel IS
  'Per-channel drill-down: "all recs that propose moving spend AWAY from '
  'this channel". Partial index keeps the entries small.';

CREATE INDEX IF NOT EXISTS idx_marketing_recommendations_venue_target_channel
  ON public.marketing_recommendations (venue_id, target_channel)
  WHERE target_channel IS NOT NULL;

COMMENT ON INDEX public.idx_marketing_recommendations_venue_target_channel IS
  'Per-channel drill-down: "all recs that propose moving spend INTO this '
  'channel". Partial index keeps the entries small.';

-- ============================================================================
-- STEP 2 — marketing_recommendation_jobs (queue table)
-- ============================================================================
-- Mirrors identity_reconstruction_jobs (mig 260) shape so the sweep code
-- can use the same atomic-claim pattern.

CREATE TABLE IF NOT EXISTS public.marketing_recommendation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of the signal that triggered this enqueue. Common
  -- values: 'manual', 'drift_refresh', 'admin_backfill',
  -- 'persona_channel_rollup_completed'.
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text,
  -- Number of recommendations produced by the run (when done).
  recommendations_produced int,
  -- Cumulative cost in cents.
  cost_cents numeric(10,4)
);

COMMENT ON TABLE public.marketing_recommendation_jobs IS
  'owner:intelligence. Wave 6C recommendation-job queue. Mirrors the '
  'identity_reconstruction_jobs shape so the sweep can atomically claim '
  'the oldest queued job. Default trigger is the weekly drift refresh; '
  'manual / admin_backfill paths also enqueue here. Migration 269.';

CREATE INDEX IF NOT EXISTS idx_marketing_recommendation_jobs_dequeue
  ON public.marketing_recommendation_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_marketing_recommendation_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 1. Partial index so the queue stays cheap to scan even after '
  'historical done/failed rows accumulate.';

CREATE INDEX IF NOT EXISTS idx_marketing_recommendation_jobs_venue
  ON public.marketing_recommendation_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_marketing_recommendation_jobs_venue IS
  '24h dedupe lookup: "is there already a queued/running job for this '
  'venue within the last 24h?" Sweep uses this to avoid double-spending '
  'Sonnet on signal bursts.';

-- ============================================================================
-- STEP 3 — RLS (mirror persona_channel_rollups pattern from mig 266)
-- ============================================================================
-- Authenticated users see their own venue's rows. Service-role bypasses
-- RLS for the recommendation writer + sweep cron + admin endpoints.
-- Authenticated coordinators may UPDATE their venue's recommendations
-- (status / decision_note / measured_outcome) — that's the Decide /
-- Measure path. INSERT + DELETE are reserved for service-role: only the
-- generation service writes new rows.

ALTER TABLE public.marketing_recommendations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_recommendations_auth_select"
  ON public.marketing_recommendations;
CREATE POLICY "marketing_recommendations_auth_select"
  ON public.marketing_recommendations
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_recommendations_auth_insert"
  ON public.marketing_recommendations;
CREATE POLICY "marketing_recommendations_auth_insert"
  ON public.marketing_recommendations
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_recommendations_auth_update"
  ON public.marketing_recommendations;
CREATE POLICY "marketing_recommendations_auth_update"
  ON public.marketing_recommendations
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

DROP POLICY IF EXISTS "marketing_recommendations_auth_delete"
  ON public.marketing_recommendations;
CREATE POLICY "marketing_recommendations_auth_delete"
  ON public.marketing_recommendations
  FOR DELETE
  TO authenticated
  USING (false);

ALTER TABLE public.marketing_recommendation_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_recommendation_jobs_auth_select"
  ON public.marketing_recommendation_jobs;
CREATE POLICY "marketing_recommendation_jobs_auth_select"
  ON public.marketing_recommendation_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_recommendation_jobs_auth_insert"
  ON public.marketing_recommendation_jobs;
CREATE POLICY "marketing_recommendation_jobs_auth_insert"
  ON public.marketing_recommendation_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_recommendation_jobs_auth_update"
  ON public.marketing_recommendation_jobs;
CREATE POLICY "marketing_recommendation_jobs_auth_update"
  ON public.marketing_recommendation_jobs
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_recommendation_jobs_auth_delete"
  ON public.marketing_recommendation_jobs;
CREATE POLICY "marketing_recommendation_jobs_auth_delete"
  ON public.marketing_recommendation_jobs
  FOR DELETE
  TO authenticated
  USING (false);

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ==============================================================================
-- 270_import_runs.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 270_import_runs.sql
-- ---------------------------------------------------------------------------
-- Wave 4 Phase 4c — unified import router + raw-source persistence.
--
-- Anchor docs:
--   - bloom-wave4-identity-reconstruction.md (Wave 4 doctrine: "raw source
--     preserved, parsing is a derivation". Reconstruction can only do its
--     job when the source-of-truth is preserved separately from the
--     parsed projection that landed in weddings/people/interactions).
--   - feedback_deep_fix_vs_bandaid.md (the deep fix is layer-replace, not
--     "more careful rule". Adapter shape detection lives at the import
--     layer; the brain-dump + onboarding endpoints both delegate so a
--     misroute in one path can't drift from the other).
--   - feedback_parallel_stream_safety.md (migration 270 pre-allocated
--     for Wave 4 Phase 4c; Round 4 is using 267/268/269).
--
-- The bug this closes
-- -------------------
-- Operator uploaded a HoneyBook export CSV via brain-dump (~71 wedding
-- records). Brain-dump's csv-shape.ts only recognised 8 shapes
-- (knowledge_base_qa/tc, leads, tour_links, platform_activity, reviews,
-- marketing_spend, unknown). The HoneyBook export hit platform_activity
-- (or close enough by header overlap) and routed to importPlatformSignals
-- → tangential_signals. importPlatformSignals' strict filters rejected 63
-- of 71 rows. The ACTUAL HoneyBook adapter in src/lib/services/crm-import/
-- was never invoked. Net: 63 wedding records lost from the booked-client
-- report; 8 partial rows in the wrong table.
--
-- The same misroute would happen for every other CRM-shaped export
-- (Aisleplanner, Dubsado, tour-scheduler, web-form, web-form-packages,
-- generic CSV with CRM columns) until brain-dump learns to detect adapter
-- shapes BEFORE the leads / platform_activity fallback fires.
--
-- The structural gap (raw source persistence)
-- -------------------------------------------
-- Neither brain-dump nor /onboarding/crm-import preserves the raw CSV
-- on disk after parsing. When the parser misclassifies (or the adapter
-- changes), the only way to recover is to ask the operator to re-export.
-- Wave 4 reconstruction reads ONLY from the parsed projection — if the
-- parse was incomplete the source-of-truth is gone.
--
-- This migration creates the audit table that import_router writes one
-- row per upload attempt + creates the storage bucket where every raw
-- CSV / PDF lives keyed by venue_id and ingested_at. Re-uploads land
-- in a new row; reprocessing re-reads from the bucket.
--
-- What this migration does
-- ------------------------
-- 1. Creates storage bucket `crm-imports` (private, venue-scoped via
--    storage path prefix). Bucket creation is via INSERT INTO
--    storage.buckets — Supabase exposes the buckets table directly to
--    SQL. Pattern matches migration 028.
-- 2. Adds storage.objects RLS policies for `crm-imports` (mirrors
--    migration 084 for brain-dump).
-- 3. Creates public.import_runs (one row per import attempt).
-- 4. Adds RLS scoped on venue_id (auth_select / auth_insert / auth_update).
-- 5. Indexes for the imports admin page (per-venue list, per-shape filter,
--    status filter for in-flight reprocessing).
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — Storage bucket: crm-imports (private)
-- ============================================================================
-- Mirrors migration 028's pattern. Bucket is private (public=false) — only
-- service-role + authenticated venue scope can read/write. Path convention
-- enforced at the application layer is {venueId}/{timestamp}-{uuid}-{filename}.

INSERT INTO storage.buckets (id, name, public)
VALUES ('crm-imports', 'crm-imports', false)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- ============================================================================
-- STEP 2 — storage.objects RLS for crm-imports (mirrors migration 084)
-- ============================================================================

DROP POLICY IF EXISTS "auth_insert_crm_imports" ON storage.objects;
CREATE POLICY "auth_insert_crm_imports" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'crm-imports');

DROP POLICY IF EXISTS "auth_select_crm_imports" ON storage.objects;
CREATE POLICY "auth_select_crm_imports" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'crm-imports');

DROP POLICY IF EXISTS "auth_update_crm_imports" ON storage.objects;
CREATE POLICY "auth_update_crm_imports" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'crm-imports')
  WITH CHECK (bucket_id = 'crm-imports');

DROP POLICY IF EXISTS "auth_delete_crm_imports" ON storage.objects;
CREATE POLICY "auth_delete_crm_imports" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'crm-imports');

-- ============================================================================
-- STEP 3 — import_runs (one row per import attempt)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Where this import was initiated. 'brain-dump' (FloatingBrainDump),
  -- 'crm-import-onboarding' (Day-3 onboarding flow), 'admin-imports-
  -- reprocess' (operator clicked Reprocess on an existing row). Free-text
  -- (no CHECK) so future entry points can label themselves without a
  -- migration.
  source_path text NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'crm-imports',
  -- Path within the bucket: {venueId}/{timestamp}-{uuid}-{safeFilename}.
  storage_path text NOT NULL,
  -- Original uploaded filename (user-supplied, kept verbatim for the
  -- imports admin display).
  filename text NOT NULL,
  mime_type text,
  file_size_bytes bigint,
  -- Output of csv-shape detector when an adapter shape was identified
  -- ('honeybook' | 'aisleplanner' | 'dubsado' | 'tour_scheduler' |
  -- 'web_form' | 'web_form_packages' | 'leads' | 'tour_links' |
  -- 'platform_activity' | 'reviews' | 'marketing_spend' |
  -- 'knowledge_base_qa' | 'knowledge_base_tc' | 'unknown').
  detected_shape text,
  -- Which adapter actually ran. May differ from detected_shape when the
  -- detector is uncertain and routing falls through to a generic path.
  adapter_used text,
  rows_attempted integer,
  rows_inserted integer,
  rows_updated integer,
  rows_skipped integer,
  -- Structured per-skip-reason counts, e.g.:
  --   { "duplicate": 12, "empty_name": 3, "unparseable_date": 1,
  --     "no_external_id": 5, "missing_required_column": 0 }
  -- The platform-signals importer surfaced 63 skips with NO reason; the
  -- import_runs row carries the breakdown so the imports admin page can
  -- show coordinators what tripped the filter and they can decide
  -- whether to clean the source CSV and reprocess.
  skip_reasons jsonb,
  errors jsonb,
  status text NOT NULL CHECK (
    status IN ('queued', 'processing', 'completed', 'failed', 'reprocessing')
  ),
  -- Wave 4 wiring: how many wedding rows were created/touched and had
  -- identity-reconstruction enqueued downstream. Surfaces in the imports
  -- admin so the operator can confirm the Sonnet judge picked up the
  -- imported rows.
  reconstruction_enqueued_count integer NOT NULL DEFAULT 0,
  ingested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

COMMENT ON TABLE public.import_runs IS
  'owner:agent. Wave 4 Phase 4c. One row per CSV/PDF upload that the '
  'unified import-router persists + dispatches. raw bytes live in '
  'storage_bucket/storage_path; the row carries the parsed projection''s '
  'rowcount + per-skip-reason breakdown. Reprocessing re-reads the bytes '
  'and runs them through the current adapter (closes the structural gap '
  'where a misroute used to require a re-export). Migration 270.';

COMMENT ON COLUMN public.import_runs.detected_shape IS
  'csv-shape detector output. Adapter shapes (honeybook, aisleplanner, '
  'dubsado, tour_scheduler, web_form, web_form_packages) take priority '
  'over the legacy generic shapes (leads, platform_activity, reviews, '
  'tour_links, marketing_spend, knowledge_base_qa, knowledge_base_tc). '
  'unknown means the detector fell through; the operator sees a "we '
  'couldn''t recognise this" prompt.';

COMMENT ON COLUMN public.import_runs.adapter_used IS
  'Which adapter actually ran. NULL until processing completes. Differs '
  'from detected_shape only when the detector confidence was below the '
  'route threshold and a fallback adapter was picked.';

COMMENT ON COLUMN public.import_runs.skip_reasons IS
  'Per-skip-reason counts. The platform-signals importer surfaced "63 '
  'skipped" with no reason; this column makes the breakdown explicit so '
  'the imports admin can show coordinators what tripped the filter.';

COMMENT ON COLUMN public.import_runs.reconstruction_enqueued_count IS
  'How many weddings touched by this import had identity-reconstruction '
  'enqueued (Wave 4 Phase 2 enqueueIdentityReconstruction). Zero is '
  'expected for non-wedding-shaped imports (reviews, knowledge_base, '
  'tour_links). Non-zero confirms the Sonnet judge picked up the import.';

-- Per-venue list — most-common imports admin query: rows by venue,
-- newest first.
CREATE INDEX IF NOT EXISTS idx_import_runs_venue_recent
  ON public.import_runs (venue_id, ingested_at DESC);

COMMENT ON INDEX public.idx_import_runs_venue_recent IS
  'Imports admin list page query: venue rows, newest first.';

-- Per-shape filter — coordinator wants "show me all HoneyBook imports".
CREATE INDEX IF NOT EXISTS idx_import_runs_venue_shape
  ON public.import_runs (venue_id, detected_shape);

COMMENT ON INDEX public.idx_import_runs_venue_shape IS
  'Imports admin filter: per-shape slice (e.g. honeybook only).';

-- Status filter — find in-flight reprocessing or recent failures.
CREATE INDEX IF NOT EXISTS idx_import_runs_status
  ON public.import_runs (status, ingested_at DESC);

COMMENT ON INDEX public.idx_import_runs_status IS
  'Worker / monitoring query: rows by status (queued / processing / '
  'reprocessing / failed) for active-imports surfacing.';

-- ============================================================================
-- STEP 4 — RLS (mirrors intel_discoveries / venue-scoped pattern)
-- ============================================================================

ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "import_runs_auth_select" ON public.import_runs;
CREATE POLICY "import_runs_auth_select"
  ON public.import_runs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "import_runs_auth_insert" ON public.import_runs;
CREATE POLICY "import_runs_auth_insert"
  ON public.import_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "import_runs_auth_update" ON public.import_runs;
CREATE POLICY "import_runs_auth_update"
  ON public.import_runs
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


-- ==============================================================================
-- 271_venue_location_derivations.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 271_venue_location_derivations.sql
-- ---------------------------------------------------------------------------
-- Wave 8 — external signals foundation. Layer fix not rule fix.
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction; one source of
--     truth, derive the rest — same doctrine applied to external-signal config)
--   - bloom-wave4-identity-reconstruction.md (Wave 4 doctrine — pattern: one
--     source of truth, derive the rest)
--   - feedback_deep_fix_vs_bandaid.md (LLM-as-primitive doctrine; broader
--     principle: layer fix not rule fix. We were whack-a-moling each external
--     signal's config field; this migration unifies them.)
--
-- Why this migration exists
-- -------------------------
-- Eight distinct external signal sources (Google Trends, Weather, Holiday
-- calendar, Government / DC-shutdown, Cultural moments, Market intelligence,
-- FRED, Census) each gate on their own venue config field. Today the
-- gating fields live across the venues table:
--   * venues.google_trends_metro      — SerpAPI metro code (mig 008)
--   * venues.noaa_station_id          — NOAA CDO station ID  (mig 008)
--   * venues.state                    — calendar geo_scope, market_intel region_key, DC-proxy
--   * venues.latitude / longitude     — DC-proxy radius, future use
--   * venues.zip                      — needed for census FIPS lookup (NEW gate)
--
-- Two of those (google_trends_metro, noaa_station_id) are NOT captured by
-- /settings/venue-info, so a "fully-filled" venue still has trends + weather
-- broken silently. Census FIPS + BLS metro MSA code don't exist yet at all.
-- This migration:
--   (1) adds the missing derived columns
--   (2) creates external_signal_health for at-a-glance status per venue
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS or DROP-then-CREATE.
-- Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — extend venues with derived location fields
-- ============================================================================

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS census_fips text,
  ADD COLUMN IF NOT EXISTS metro_msa_code text,
  ADD COLUMN IF NOT EXISTS dc_region_proxy boolean,
  ADD COLUMN IF NOT EXISTS location_derived_at timestamptz,
  ADD COLUMN IF NOT EXISTS location_derivation_source jsonb;

COMMENT ON COLUMN public.venues.census_fips IS
  '11-digit county FIPS code (state+county). Derived from ZIP via the US '
  'Census Geocoder API. Gates the Census signal channel. Wave 8 / mig 271.';

COMMENT ON COLUMN public.venues.metro_msa_code IS
  'BLS Metropolitan Statistical Area code (different from google_trends_metro '
  'which is a SerpAPI-specific code). Used by future labor / employment '
  'channel readers. Wave 8 / mig 271.';

COMMENT ON COLUMN public.venues.dc_region_proxy IS
  'Derived: state IN (VA, DC, MD) OR lat/lng within 100mi of the Capitol. '
  'Persisted (rather than always-recomputed) so the writer audit shows when '
  'and how the value was set. Mirrors government.ts isDCRegionVenue logic. '
  'Wave 8 / mig 271.';

COMMENT ON COLUMN public.venues.location_derived_at IS
  'When the auto-derivation last ran (manual or sweep). NULL = never derived; '
  'derived columns are stale or hand-edited. Wave 8 / mig 271.';

COMMENT ON COLUMN public.venues.location_derivation_source IS
  'Audit jsonb: { source: "manual" | "auto_derive" | "sweep", inputs: {...}, '
  'results: {...}, errors: [...] }. Lets ops trace which fields came from '
  'which network call. Wave 8 / mig 271.';

-- ============================================================================
-- STEP 2 — external_signal_health (one row per (venue, signal))
-- ============================================================================
--
-- Status meanings:
--   * ready          — signal has all config + recent data
--   * config_missing — at least one required venue field is null
--   * data_stale     — config OK, but last_refresh_at older than threshold
--   * error          — last refresh attempt failed (last_error populated)
--   * disabled       — signal explicitly turned off for this venue (future use)
--
-- The signals (8): google_trends, weather, holiday_calendar, government,
-- cultural_moments, market_intelligence, fred, census. New signals slot in
-- by adding a row — no schema change required.

CREATE TABLE IF NOT EXISTS public.external_signal_health (
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  signal_name text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'ready',
    'config_missing',
    'data_stale',
    'error',
    'disabled'
  )),
  -- What's required to flip this signal to 'ready', when status='config_missing'.
  -- Free-text array so new signals don't need a migration to add new keys.
  missing_config_fields text[],
  last_refresh_at timestamptz,
  record_count integer NOT NULL DEFAULT 0,
  last_error text,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, signal_name)
);

COMMENT ON TABLE public.external_signal_health IS
  'owner:intelligence. Wave 8 external-signal foundation. One row per '
  '(venue, signal) pair. Read by /intel/external-signals dashboard, '
  'written by the health-check service + sweep cron. Migration 271.';

COMMENT ON COLUMN public.external_signal_health.signal_name IS
  'Free-text signal id. Current set: google_trends, weather, holiday_calendar, '
  'government, cultural_moments, market_intelligence, fred, census. New '
  'signals slot in by inserting a row.';

COMMENT ON COLUMN public.external_signal_health.missing_config_fields IS
  'Array of venue/config field names that need filling for status to flip '
  'to ready. e.g. {google_trends_metro} for trends, {noaa_station_id, '
  'latitude} for weather. Empty/null when status != config_missing.';

CREATE INDEX IF NOT EXISTS idx_external_signal_health_venue_status
  ON public.external_signal_health (venue_id, status);

COMMENT ON INDEX public.idx_external_signal_health_venue_status IS
  'Dashboard hero query: count of ready/config_missing/error per venue.';

CREATE INDEX IF NOT EXISTS idx_external_signal_health_signal_status
  ON public.external_signal_health (signal_name, status);

COMMENT ON INDEX public.idx_external_signal_health_signal_status IS
  'Cross-venue ops view: which signals are config_missing across the fleet.';

-- ============================================================================
-- STEP 3 — RLS (mirrors venue-scoped pattern)
-- ============================================================================

ALTER TABLE public.external_signal_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "external_signal_health_auth_select"
  ON public.external_signal_health;
CREATE POLICY "external_signal_health_auth_select"
  ON public.external_signal_health
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "external_signal_health_auth_insert"
  ON public.external_signal_health;
CREATE POLICY "external_signal_health_auth_insert"
  ON public.external_signal_health
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "external_signal_health_auth_update"
  ON public.external_signal_health;
CREATE POLICY "external_signal_health_auth_update"
  ON public.external_signal_health
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


-- ==============================================================================
-- 272_hypothesis_validation_runs.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 272_hypothesis_validation_runs.sql
-- ---------------------------------------------------------------------------
-- Wave 7C — hypothesis validation engine. Closes the discovery feedback loop.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 7 closes the forensic loop. Wave 7A
--     hunts for unknown-unknowns; Wave 7C designs and runs the test that
--     confirms or refutes each hypothesis. Validated discoveries feed
--     BACK into Wave 5/6 as new buckets — Wave 7D closes that loop.)
--   - bloom-wave4-5-6-master-plan.md (Wave 7C spec: two Sonnet calls per
--     run — test designer + result interpreter. Coordinator confirms.)
--   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. The validator
--     sees ANONYMISED rollups + cohort filter shapes only — never names
--     couples.)
--   - feedback_parallel_stream_safety.md (Wave 7C is on migration 272.
--     Wave 6D=273. Wave 8=271. We MAY add validation-tracking columns to
--     intel_discoveries, never restructure existing columns.)
--
-- Why this migration exists
-- -------------------------
-- Wave 7A produces hypotheses with a free-text `recommended_test` field
-- but no execution. Wave 7C is the engine that designs the actual test
-- (Sonnet 1: test designer outputs structured comparison logic), runs
-- it against the venue's anonymised cohort data, returns a result with
-- statistical confidence (Sonnet 2: result interpreter labels it as
-- validated / refuted / inconclusive / data_too_thin).
--
-- Storage shape:
--   * ALTER intel_discoveries — add validation_started_at,
--     validation_completed_at, validation_test_plan jsonb,
--     validation_runs_count int. Existing columns untouched.
--   * hypothesis_validation_runs — one row per validation attempt. We
--     preserve audit history so a coordinator can see "this hypothesis
--     was tested 3 times across 6 weeks; the result flipped from
--     inconclusive to validated when the cohort grew past n=20."
--   * hypothesis_validation_jobs — queue table. Mirrors
--     intel_discovery_jobs / intel_match_jobs.
--
-- Idempotent: every CREATE / ALTER / INDEX / POLICY uses IF NOT EXISTS
-- or DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — extend intel_discoveries with validation tracking columns
-- ============================================================================

ALTER TABLE public.intel_discoveries
  ADD COLUMN IF NOT EXISTS validation_started_at timestamptz;

ALTER TABLE public.intel_discoveries
  ADD COLUMN IF NOT EXISTS validation_completed_at timestamptz;

-- The test plan Sonnet (designer call) emitted on the most recent run.
-- Free-form jsonb because validation tests are themselves discovery-shaped:
-- common patterns are cohort_comparison + time_shift + channel_comparison
-- but Wave 7A may produce hypotheses whose tests don't fit any of those.
-- Standard shape (test executor expects this when present):
--   { test_kind, treatment_cohort_filter: {...}, control_cohort_filter: {...},
--     metric, direction_if_confirmed, minimum_n, statistical_test,
--     expected_lift_threshold_pct }
ALTER TABLE public.intel_discoveries
  ADD COLUMN IF NOT EXISTS validation_test_plan jsonb;

-- Counter so the dashboard can display "validated 3× over 6 weeks". Bumped
-- by each completed run; never decremented.
ALTER TABLE public.intel_discoveries
  ADD COLUMN IF NOT EXISTS validation_runs_count int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.intel_discoveries.validation_started_at IS
  'Wave 7C (mig 272). Set when Wave 7C starts a validation run; cleared '
  'when complete. NULL = no run in flight. Used to detect stuck runs '
  '(started > 5 min ago, no completed_at).';

COMMENT ON COLUMN public.intel_discoveries.validation_completed_at IS
  'Wave 7C (mig 272). Set when the most recent validation run finished '
  '(success or failure). Together with validation_runs_count, drives the '
  'dashboard "last validated X minutes ago" badge.';

COMMENT ON COLUMN public.intel_discoveries.validation_test_plan IS
  'Wave 7C (mig 272). Most recent test plan emitted by the Sonnet test '
  'designer. Standard shape (when test executor recognised the kind): '
  '{ test_kind, treatment_cohort_filter, control_cohort_filter, metric, '
  'direction_if_confirmed, minimum_n, statistical_test, '
  'expected_lift_threshold_pct }. Free-form jsonb because Wave 7A may '
  'discover hypotheses whose tests do not fit any pre-defined kind.';

COMMENT ON COLUMN public.intel_discoveries.validation_runs_count IS
  'Wave 7C (mig 272). Total completed validation runs. Bumped per '
  'hypothesis_validation_runs row (success or refute). Drives the '
  'dashboard "tested 3× over 6 weeks" badge.';

-- ============================================================================
-- STEP 2 — hypothesis_validation_runs (one row per validation attempt)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.hypothesis_validation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE so dropping a discovery removes its validation
  -- audit. The discovery is the primary entity; runs are derived.
  discovery_id uuid NOT NULL
    REFERENCES public.intel_discoveries(id) ON DELETE CASCADE,
  -- Denormalised venue_id so RLS + per-venue indexes don't require a
  -- join through intel_discoveries on every read.
  venue_id uuid NOT NULL
    REFERENCES public.venues(id) ON DELETE CASCADE,
  -- The structured test plan Sonnet (designer call) emitted. Standard
  -- shape (when test executor recognised the kind): see comment on
  -- intel_discoveries.validation_test_plan above. Free-form jsonb.
  test_plan jsonb NOT NULL,
  -- The actual numbers from the test executor. Standard shape:
  --   { metric_value_treatment, metric_value_control, lift_pct,
  --     n_treatment, n_control, p_value_approx, statistical_test_used,
  --     errors: [string] }
  test_result jsonb NOT NULL,
  -- Sonnet (interpreter call) categorical interpretation.
  interpretation text NOT NULL CHECK (interpretation IN (
    'validated',
    'refuted',
    'inconclusive',
    'data_too_thin'
  )),
  confidence_0_100 integer NOT NULL CHECK (
    confidence_0_100 >= 0 AND confidence_0_100 <= 100
  ),
  -- Sonnet's reasoning chain explaining why the test plan + numbers led
  -- to the interpretation it picked.
  reasoning text,
  -- Cost in cents (sum of designer + interpreter Sonnet calls). Numeric
  -- to keep cents-and-fractions precision; matches venue_intel /
  -- intel_discoveries.
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  -- Threaded into api_costs.prompt_version for regression audits.
  prompt_version text NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.hypothesis_validation_runs IS
  'owner:agent. Wave 7C hypothesis validation audit log. One row per '
  'validation attempt against an intel_discovery. Preserves history of '
  'multiple validation runs (e.g. inconclusive → validated as cohort '
  'grew). interpretation = validated | refuted | inconclusive | '
  'data_too_thin. test_plan + test_result are anonymised aggregate '
  'shapes; NEVER contain couple names. Migration 272.';

COMMENT ON COLUMN public.hypothesis_validation_runs.test_plan IS
  'Wave 7C (mig 272). The structured test plan Sonnet test designer '
  'emitted. Standard shape: { test_kind, treatment_cohort_filter, '
  'control_cohort_filter, metric, direction_if_confirmed, minimum_n, '
  'statistical_test, expected_lift_threshold_pct }. Free-form because '
  'Wave 7A may discover hypothesis types whose tests do not fit a '
  'pre-defined shape — that is the design.';

COMMENT ON COLUMN public.hypothesis_validation_runs.test_result IS
  'Wave 7C (mig 272). The actual numbers from the test executor. '
  'Standard shape: { metric_value_treatment, metric_value_control, '
  'lift_pct, n_treatment, n_control, p_value_approx, '
  'statistical_test_used, errors: [string] }. Aggregate ≠ disclose; '
  'NEVER contains per-couple data.';

COMMENT ON COLUMN public.hypothesis_validation_runs.interpretation IS
  'Wave 7C (mig 272). Sonnet interpreter categorical verdict. '
  'data_too_thin = not enough cohort data for the test (e.g. n_treatment '
  '< minimum_n). inconclusive = ran but result not statistically clear. '
  'validated = result confirms hypothesis direction at confidence. '
  'refuted = result contradicts hypothesis direction.';

-- Per-discovery audit-history scan: most recent run first.
CREATE INDEX IF NOT EXISTS idx_hypothesis_validation_runs_discovery
  ON public.hypothesis_validation_runs (discovery_id, run_at DESC);

COMMENT ON INDEX public.idx_hypothesis_validation_runs_discovery IS
  'Per-discovery audit history. Drives /api/admin/intel/discoveries/{id}/'
  'validation-result (most recent first) + the dashboard run-history '
  'panel.';

-- Per-venue verdict slice: drives the validated-discoveries feedback
-- loop into Wave 5/6 (Wave 7D reads this).
CREATE INDEX IF NOT EXISTS idx_hypothesis_validation_runs_venue_interpretation
  ON public.hypothesis_validation_runs (venue_id, interpretation);

COMMENT ON INDEX public.idx_hypothesis_validation_runs_venue_interpretation IS
  'Wave 7D feedback loop: pull venue-scoped validated runs to promote '
  'their hypotheses into Wave 5/6 buckets / correlations / attribution '
  'rules.';

-- ============================================================================
-- STEP 3 — hypothesis_validation_jobs (queue table)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.hypothesis_validation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL
    REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Discovery to validate. ON DELETE CASCADE so removing a discovery
  -- removes its queued validation job.
  discovery_id uuid NOT NULL
    REFERENCES public.intel_discoveries(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.hypothesis_validation_jobs IS
  'owner:agent. Wave 7C hypothesis-validation queue. Enqueue triggers: '
  '(a) new high-confidence discovery (confidence >= 70) when '
  'venue_config opts in (TODO — see enqueue helper); (b) drift_refresh '
  'from hypothesis_validation_sweep cron, weekly, for ''in_progress'' '
  'rows older than 7 days; (c) admin_backfill via /api/admin/intel/'
  'discoveries/{id}/validate. Worker drains 3 jobs per tick (two '
  'Sonnet calls each — pacing matters). Migration 272.';

COMMENT ON COLUMN public.hypothesis_validation_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text: high_confidence_discovery | '
  'drift_refresh | admin_backfill | manual_force.';

CREATE INDEX IF NOT EXISTS idx_hypothesis_validation_jobs_dequeue
  ON public.hypothesis_validation_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_hypothesis_validation_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=queued LIMIT 3.';

CREATE INDEX IF NOT EXISTS idx_hypothesis_validation_jobs_venue
  ON public.hypothesis_validation_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_hypothesis_validation_jobs_venue IS
  'Per-venue 24h dedupe lookup. Mirrors Wave 7A queue pattern.';

CREATE INDEX IF NOT EXISTS idx_hypothesis_validation_jobs_discovery
  ON public.hypothesis_validation_jobs (discovery_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_hypothesis_validation_jobs_discovery IS
  'Per-discovery dedupe: do not enqueue a second job for the same '
  'discovery while one is queued/running.';

-- ============================================================================
-- STEP 4 — RLS (mirrors intel_discoveries pattern, scoped on venue_id)
-- ============================================================================

ALTER TABLE public.hypothesis_validation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hypothesis_validation_runs_auth_select"
  ON public.hypothesis_validation_runs;
CREATE POLICY "hypothesis_validation_runs_auth_select"
  ON public.hypothesis_validation_runs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "hypothesis_validation_runs_auth_insert"
  ON public.hypothesis_validation_runs;
CREATE POLICY "hypothesis_validation_runs_auth_insert"
  ON public.hypothesis_validation_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "hypothesis_validation_runs_auth_update"
  ON public.hypothesis_validation_runs;
CREATE POLICY "hypothesis_validation_runs_auth_update"
  ON public.hypothesis_validation_runs
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

ALTER TABLE public.hypothesis_validation_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hypothesis_validation_jobs_auth_select"
  ON public.hypothesis_validation_jobs;
CREATE POLICY "hypothesis_validation_jobs_auth_select"
  ON public.hypothesis_validation_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "hypothesis_validation_jobs_auth_insert"
  ON public.hypothesis_validation_jobs;
CREATE POLICY "hypothesis_validation_jobs_auth_insert"
  ON public.hypothesis_validation_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "hypothesis_validation_jobs_auth_update"
  ON public.hypothesis_validation_jobs;
CREATE POLICY "hypothesis_validation_jobs_auth_update"
  ON public.hypothesis_validation_jobs
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


-- ==============================================================================
-- 273_marketing_loop.sql
-- ==============================================================================
-- ---------------------------------------------------------------------------
-- 273_marketing_loop.sql
-- ---------------------------------------------------------------------------
-- Wave 6D — closing the marketing loop.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 6 closes the forensic loop. 6A ingests
--     spend, 6B rolls up persona × channel × revenue, 6C produces the
--     reallocation recommendations, 6D flags under/over-performance, sets
--     up A/B scaffolds, delivers a weekly digest.)
--   - bloom-wave4-5-6-master-plan.md (Wave 6D spec)
--   - feedback_parallel_stream_safety.md (Wave 6D holds migration 273.
--     Wave 7C holds 272. Wave 8 holds 271. We don't write into anyone
--     else's lane and we don't touch their writer code.)
--
-- Why this migration exists
-- -------------------------
-- Wave 6C produces explicit reallocation recommendations the operator
-- decides on. Wave 6D is the around-the-recommendations layer:
--
--   * marketing_spend_flags — auto-detected red/green flags from the
--     rollup matrix. CAC>LTV cells, underperforming pause candidates,
--     overperforming scale candidates, persona drift, channel anomalies.
--     Surfaced as a triage panel; the system never auto-acts.
--
--   * marketing_ab_tests — lightweight A/B test scaffold for competing
--     creatives / channels / persona-targeting. Tracks which
--     attribution_events count as variant_a vs variant_b. Computes lift
--     when both arms have ≥ 30 events; refuses to conclude before that.
--
--   * marketing_digests — weekly digest history. One row per
--     (venue, week). Pulls top flags + top recs + week-over-week metric
--     changes + concluded A/B tests + validated discoveries (Wave 7C),
--     then asks Sonnet to author the headline + narrative.
--
--   * marketing_loop_jobs — sweep queue (mirror of the recommendation
--     queue from mig 269).
--
-- Doctrine: AUTO-FLAG, NEVER AUTO-EXECUTE. Every transition is operator-
-- decided. The migration shapes the data; the service layer enforces the
-- "no auto-spend" invariant.
--
-- Idempotent: every CREATE TABLE / CREATE INDEX / CREATE POLICY uses
-- IF NOT EXISTS or DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — marketing_spend_flags (one row per active flag)
-- ============================================================================
-- Re-detection updates last_confirmed_at on the existing row instead of
-- inserting a duplicate. The unique constraint on
-- (venue_id, flag_type, source_channel, target_persona) is the
-- identity of an "active flag" — same condition same row.

CREATE TABLE IF NOT EXISTS public.marketing_spend_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Flag taxonomy (drives icon + severity defaults on the dashboard).
  --   underperforming_pause_candidate — ROI < 50% of channel-blended avg
  --     AND spend > $500/mo for 14d (warning)
  --   overperforming_scale_candidate  — ROI > 200% of channel-blended avg
  --     AND n>=10 (info)
  --   cac_exceeds_ltv — CAC > 30% of avg booking value, n>=10, sustained
  --     14d (critical)
  --   persona_drift — couple_intel persona distribution shifts >15% in a
  --     30d window vs prior 30d (warning)
  --   channel_anomaly — channel CAC suddenly doubles week-over-week
  --     (warning)
  flag_type text NOT NULL
    CHECK (flag_type IN (
      'underperforming_pause_candidate',
      'overperforming_scale_candidate',
      'cac_exceeds_ltv',
      'persona_drift',
      'channel_anomaly'
    )),

  -- Short headline ("Knot × Heritage-Forward CAC > LTV"). Used as a
  -- card title; the dashboard truncates beyond ~80 chars.
  flag_title text NOT NULL,

  -- Full explanation paragraph. The "story" the operator reads first
  -- before drilling into cohort_data + recommended_action.
  flag_text text NOT NULL,

  -- Drives card visuals + sort order.
  --   info     — directional signal, no urgent action needed
  --   warning  — sustained underperformance / drift; review this week
  --   critical — CAC>LTV class — immediate review
  severity text NOT NULL
    CHECK (severity IN ('info', 'warning', 'critical')),

  -- Channel + persona scope. NULL when the flag is multi-channel or
  -- venue-wide (e.g. persona_drift is venue-wide, target_persona may
  -- be NULL on channel_anomaly).
  source_channel text,
  target_persona text,

  -- The rollup numbers that triggered the flag. Frozen at detection
  -- time so the operator can audit "why was this flagged on May 9?"
  -- even after the rollup has been recomputed. Schema is flag-type
  -- specific; the service layer is the authority. Common keys:
  --   roi_pct, cac_cents, conversion_pct, n_too_small, channel_avg_*,
  --   prior_window / current_window for drift flags.
  cohort_data jsonb NOT NULL,

  -- How many days the underlying condition has held. Drives the
  -- 14d-sustained gate for pause/cac_exceeds_ltv flags. Updated each
  -- detection sweep.
  duration_days int NOT NULL DEFAULT 0
    CHECK (duration_days >= 0),

  -- Revenue at stake (cents). Signed: positive when the flag points to
  -- recoverable upside (scale candidate), negative when the flag points
  -- to ongoing waste (pause candidate). Cents not dollars.
  estimated_impact_cents int,

  -- Imperative phrasing ("Consider pausing Knot × Heritage-Forward").
  -- The flag never auto-acts — this string is the operator's prompt.
  recommended_action text,

  -- Lifecycle:
  --   pending      — newly detected, awaiting coordinator triage
  --   acknowledged — coordinator has seen it (next: actioned / dismissed)
  --   actioned     — operator did something based on the flag
  --   dismissed    — operator decided no action needed
  --   resolved     — system auto-resolved (condition no longer holds for 7d)
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'acknowledged', 'actioned', 'dismissed', 'resolved')),

  -- Detection lifecycle timestamps.
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  -- Updated each sweep that re-confirms the flag still applies. Drives
  -- duration_days math.
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),

  -- Operator decision audit.
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES auth.users(id),
  acknowledgment_note text,
  resolved_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_spend_flags IS
  'owner:intelligence. Wave 6D auto-detected flags from the persona × '
  'channel rollup matrix. One row per (venue, flag_type, source_channel, '
  'target_persona) tuple — re-detection updates last_confirmed_at instead '
  'of inserting a duplicate. AUTO-FLAG NEVER AUTO-EXECUTE: operator '
  'decides acknowledge / action / dismiss; system auto-resolves only when '
  'the condition no longer holds for 7d. Migration 273.';

COMMENT ON COLUMN public.marketing_spend_flags.cohort_data IS
  'Frozen rollup numbers that triggered the flag. Lets the operator '
  'audit "why was this flagged" later even after the rollup has been '
  'recomputed. Schema is flag-type specific; the service layer is the '
  'authority.';

COMMENT ON COLUMN public.marketing_spend_flags.duration_days IS
  'How many days the underlying condition has held. Drives the '
  '14d-sustained gate for pause/cac_exceeds_ltv flags. Updated each '
  'detection sweep.';

COMMENT ON COLUMN public.marketing_spend_flags.estimated_impact_cents IS
  'Revenue at stake (cents). Signed — positive when the flag points to '
  'recoverable upside (scale candidate), negative when the flag points '
  'to ongoing waste (pause candidate). Cents not dollars.';

COMMENT ON COLUMN public.marketing_spend_flags.status IS
  'Lifecycle: pending → acknowledged → actioned/dismissed (operator '
  'decisions) OR pending → resolved (system auto-resolves when condition '
  'fails to re-confirm for 7d). Wave 6D never auto-progresses to '
  'actioned.';

-- One active flag per (venue, condition). The unique constraint includes
-- COALESCE'd nulls so a venue-wide flag (NULL channel, NULL persona)
-- still de-dupes against itself. Partial — only enforced for non-resolved
-- flags so the historical resolved trail stays intact.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketing_spend_flags_active
  ON public.marketing_spend_flags (
    venue_id,
    flag_type,
    COALESCE(source_channel, ''),
    COALESCE(target_persona, '')
  )
  WHERE status <> 'resolved';

COMMENT ON INDEX public.uniq_marketing_spend_flags_active IS
  'One active flag per (venue, flag_type, channel, persona). Partial — '
  'allows the historical resolved trail to keep multiple rows for the '
  'same condition over time. Re-detection updates last_confirmed_at on '
  'the active row instead of inserting a duplicate.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_flags_venue_status_severity
  ON public.marketing_spend_flags (venue_id, status, severity);

COMMENT ON INDEX public.idx_marketing_spend_flags_venue_status_severity IS
  'Hot-path: dashboard reads "pending flags for this venue, ordered by '
  'severity desc". Status + severity filters drive the triage view.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_flags_venue_last_confirmed
  ON public.marketing_spend_flags (venue_id, last_confirmed_at DESC);

COMMENT ON INDEX public.idx_marketing_spend_flags_venue_last_confirmed IS
  'Auto-resolve sweep: ORDER BY last_confirmed_at ASC WHERE status IN '
  '(pending, acknowledged) — finds flags whose condition has not been '
  're-confirmed recently and may need the 7d resolved transition.';

-- ============================================================================
-- STEP 2 — marketing_ab_tests (A/B test scaffold)
-- ============================================================================
-- Lightweight scaffold: tracks which attribution_events fall in
-- variant_a vs variant_b based on a coordinator-defined filter. Computes
-- lift_pct + decides winner when both arms have ≥ 30 events OR
-- coordinator forces conclusion. Refuses to auto-conclude with
-- insufficient data.

CREATE TABLE IF NOT EXISTS public.marketing_ab_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  test_name text NOT NULL,
  hypothesis text NOT NULL,

  -- Human-readable variant labels ("current Knot listing copy",
  -- "new Heritage-Forward Knot copy").
  variant_a_label text NOT NULL,
  variant_b_label text NOT NULL,

  -- Channel + persona scope. Channel mandatory (the test is always
  -- about a channel's performance). Persona optional — multi-persona
  -- tests are valid.
  channel text NOT NULL,
  target_persona text,

  -- Test window.
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,

  -- Which attribution_events count toward each arm. Coordinator
  -- assigns these explicitly (or via a filter the service layer
  -- expands to ids). Arrays — small enough at typical test volumes
  -- (≤ a few hundred events per arm) and removes a join through a
  -- separate junction table. Cap at 10000 ids per arm at the service
  -- layer.
  variant_a_attribution_event_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  variant_b_attribution_event_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],

  -- Conclusion (NULL until both arms reach the cohort threshold OR the
  -- coordinator force-concludes). Allowed values:
  --   variant_a    — A wins
  --   variant_b    — B wins
  --   inconclusive — concluded but no winner (ties or arms too thin)
  winner text
    CHECK (winner IS NULL OR winner IN ('variant_a', 'variant_b', 'inconclusive')),
  -- The lift the winning arm showed against the loser, signed pct.
  -- Positive = winner's metric exceeded loser's. Null until concluded.
  winner_decision_lift_pct numeric(7,2),
  winner_decided_at timestamptz,
  winner_decided_by uuid REFERENCES auth.users(id),

  -- Lifecycle:
  --   planning  — operator is still building the test; arms may be empty
  --   running   — test is live; assignVariantToAttributionEvent can append
  --   concluded — winner decided OR force-concluded; arms frozen
  --   abandoned — operator killed the test before conclusion
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('planning', 'running', 'concluded', 'abandoned')),

  notes text,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_ab_tests IS
  'owner:intelligence. Wave 6D A/B test scaffold for competing creatives / '
  'channels / persona-targeting. Lightweight: tracks variant arms as '
  'arrays of attribution_event ids; computes lift when both arms have '
  '>= 30 events. Refuses to auto-conclude with insufficient data. '
  'Migration 273.';

COMMENT ON COLUMN public.marketing_ab_tests.variant_a_attribution_event_ids IS
  'Attribution events counted toward variant A. Arrays cap at 10000 ids '
  'per arm at the service layer (typical test volume is < a few hundred '
  'per arm). Coordinator assigns explicitly or via a filter the service '
  'expands to ids.';

COMMENT ON COLUMN public.marketing_ab_tests.winner IS
  'Conclusion: variant_a | variant_b | inconclusive | NULL (still '
  'running). NULL until both arms reach the 30-event threshold OR '
  'coordinator force-concludes. inconclusive means "concluded but no '
  'winner" — ties or arms too thin even after force.';

COMMENT ON COLUMN public.marketing_ab_tests.status IS
  'Lifecycle: planning → running → concluded (or abandoned terminal). '
  'Wave 6D never auto-progresses planning→running; the operator '
  'explicitly starts the test.';

CREATE INDEX IF NOT EXISTS idx_marketing_ab_tests_venue_status
  ON public.marketing_ab_tests (venue_id, status, started_at DESC);

COMMENT ON INDEX public.idx_marketing_ab_tests_venue_status IS
  'Hot-path: dashboard reads "running tests for this venue, newest first". '
  'Status filter is the most common scope.';

-- ============================================================================
-- STEP 3 — marketing_digests (weekly digest history)
-- ============================================================================
-- One row per (venue, week). Re-running the digest builder with the same
-- (venue, week) updates digest_jsonb in place; it doesn't insert a
-- duplicate. The unique constraint on
-- (venue_id, digest_period_start, digest_period_end) enforces this.

CREATE TABLE IF NOT EXISTS public.marketing_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Inclusive start, inclusive end. Conventionally Monday-Sunday for
  -- weekly digests; the service layer rounds.
  digest_period_start date NOT NULL,
  digest_period_end date NOT NULL,

  -- Structured digest output.
  -- Required keys (service-layer authority):
  --   headline                  string  — punchy summary line
  --   this_week_in_3_sentences  string  — narrative paragraph
  --   top_flags                 array   — [{title, severity, recommended_action}]
  --   top_recommendations       array   — [{title, projected_impact_cents}]
  --   week_over_week            object  — {cac_change_pct, conversion_change_pct, roi_change_pct}
  --   ab_tests_concluded        array   — [{name, winner, lift_pct}]
  --   validated_discoveries     array   — [{title, summary}] (Wave 7C feed)
  --   refusal                   string|null
  digest_jsonb jsonb NOT NULL,

  -- Delivery channel + timestamp. NULL until delivered (dashboard-only
  -- path keeps NULL forever; the email/slack paths populate after
  -- delivery succeeds). Allowed values match the integration map.
  delivered_via text
    CHECK (delivered_via IS NULL
           OR delivered_via IN ('email', 'slack', 'dashboard_only')),
  delivered_at timestamptz,

  -- LLM cost (cents) attributable to this digest pass. numeric(10,4)
  -- matches api_costs.cost convention (sub-cent precision for tiny
  -- calls).
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,

  prompt_version text,

  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_digests IS
  'owner:intelligence. Wave 6D weekly digest history. One row per '
  '(venue, week). Re-running the builder updates digest_jsonb in place; '
  'unique constraint enforces no-duplicate. Read by '
  '/intel/marketing-roi/digest dashboard. Migration 273.';

COMMENT ON COLUMN public.marketing_digests.digest_jsonb IS
  'Structured digest output. Required keys: headline, '
  'this_week_in_3_sentences, top_flags, top_recommendations, '
  'week_over_week (cac/conversion/roi pct deltas), ab_tests_concluded, '
  'validated_discoveries, refusal. Service layer is the authority on '
  'shape.';

COMMENT ON COLUMN public.marketing_digests.delivered_via IS
  'Delivery channel: email | slack | dashboard_only | NULL (not yet '
  'delivered). dashboard_only is a terminal "viewed in UI" state used '
  'before email/slack channels are wired.';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketing_digests_period
  ON public.marketing_digests (venue_id, digest_period_start, digest_period_end);

COMMENT ON INDEX public.uniq_marketing_digests_period IS
  'One digest per (venue, week). Re-running the builder upserts on this '
  'index — re-runs replace digest_jsonb in place.';

CREATE INDEX IF NOT EXISTS idx_marketing_digests_venue_generated
  ON public.marketing_digests (venue_id, generated_at DESC);

COMMENT ON INDEX public.idx_marketing_digests_venue_generated IS
  'Hot-path: dashboard reads "latest digest for this venue" + "history '
  'dropdown of past digests, newest first".';

-- ============================================================================
-- STEP 4 — marketing_loop_jobs (sweep queue)
-- ============================================================================
-- Mirrors marketing_recommendation_jobs (mig 269) shape so the sweep
-- code can use the same atomic-claim pattern.

CREATE TABLE IF NOT EXISTS public.marketing_loop_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Which sweep claimed this. Both sweeps share the queue table so a
  -- single observation surface tells the story of the loop.
  --   flag_detect    — flag detector sweep (daily)
  --   digest_build   — digest builder sweep (weekly)
  job_kind text NOT NULL DEFAULT 'flag_detect'
    CHECK (job_kind IN ('flag_detect', 'digest_build')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text,
  -- For flag_detect runs: counts of flags created/confirmed/resolved.
  -- For digest_build runs: 1 if a digest row was written, 0 otherwise.
  results_jsonb jsonb,
  cost_cents numeric(10,4)
);

COMMENT ON TABLE public.marketing_loop_jobs IS
  'owner:intelligence. Wave 6D loop-job queue. Two sweeps share this '
  'queue: flag_detect (daily) + digest_build (weekly). Mirrors '
  'marketing_recommendation_jobs shape so sweeps use the same atomic-'
  'claim pattern. Migration 273.';

CREATE INDEX IF NOT EXISTS idx_marketing_loop_jobs_dequeue
  ON public.marketing_loop_jobs (job_kind, status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_marketing_loop_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=queued AND '
  'job_kind=$1 LIMIT 1. Partial index keeps the queue cheap to scan '
  'after historical done/failed rows accumulate.';

CREATE INDEX IF NOT EXISTS idx_marketing_loop_jobs_venue
  ON public.marketing_loop_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_marketing_loop_jobs_venue IS
  'Per-venue dedupe lookup: "is there already a queued/running job for '
  'this venue + kind in the last 24h?" Sweep uses this to avoid double-'
  'spending on signal bursts.';

-- ============================================================================
-- STEP 5 — RLS (mirror persona_channel_rollups + marketing_recommendations)
-- ============================================================================
-- Authenticated users see their own venue's rows. Service-role bypasses
-- RLS for the writer + sweep cron + admin endpoints. Authenticated
-- coordinators may UPDATE flags + ab_tests (acknowledge / dismiss /
-- conclude) — that's the operator-decision path. INSERT + DELETE are
-- service-role only for flags + digests; ab_tests permits
-- authenticated INSERT (operators create tests from the UI).

-- ---- marketing_spend_flags ----
ALTER TABLE public.marketing_spend_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_spend_flags_auth_select"
  ON public.marketing_spend_flags;
CREATE POLICY "marketing_spend_flags_auth_select"
  ON public.marketing_spend_flags
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_spend_flags_auth_insert"
  ON public.marketing_spend_flags;
CREATE POLICY "marketing_spend_flags_auth_insert"
  ON public.marketing_spend_flags
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_spend_flags_auth_update"
  ON public.marketing_spend_flags;
CREATE POLICY "marketing_spend_flags_auth_update"
  ON public.marketing_spend_flags
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

DROP POLICY IF EXISTS "marketing_spend_flags_auth_delete"
  ON public.marketing_spend_flags;
CREATE POLICY "marketing_spend_flags_auth_delete"
  ON public.marketing_spend_flags
  FOR DELETE
  TO authenticated
  USING (false);

-- ---- marketing_ab_tests ----
ALTER TABLE public.marketing_ab_tests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_ab_tests_auth_select"
  ON public.marketing_ab_tests;
CREATE POLICY "marketing_ab_tests_auth_select"
  ON public.marketing_ab_tests
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_ab_tests_auth_insert"
  ON public.marketing_ab_tests;
CREATE POLICY "marketing_ab_tests_auth_insert"
  ON public.marketing_ab_tests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_ab_tests_auth_update"
  ON public.marketing_ab_tests;
CREATE POLICY "marketing_ab_tests_auth_update"
  ON public.marketing_ab_tests
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

DROP POLICY IF EXISTS "marketing_ab_tests_auth_delete"
  ON public.marketing_ab_tests;
CREATE POLICY "marketing_ab_tests_auth_delete"
  ON public.marketing_ab_tests
  FOR DELETE
  TO authenticated
  USING (false);

-- ---- marketing_digests ----
ALTER TABLE public.marketing_digests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_digests_auth_select"
  ON public.marketing_digests;
CREATE POLICY "marketing_digests_auth_select"
  ON public.marketing_digests
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_digests_auth_insert"
  ON public.marketing_digests;
CREATE POLICY "marketing_digests_auth_insert"
  ON public.marketing_digests
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_digests_auth_update"
  ON public.marketing_digests;
CREATE POLICY "marketing_digests_auth_update"
  ON public.marketing_digests
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_digests_auth_delete"
  ON public.marketing_digests;
CREATE POLICY "marketing_digests_auth_delete"
  ON public.marketing_digests
  FOR DELETE
  TO authenticated
  USING (false);

-- ---- marketing_loop_jobs ----
ALTER TABLE public.marketing_loop_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_loop_jobs_auth_select"
  ON public.marketing_loop_jobs;
CREATE POLICY "marketing_loop_jobs_auth_select"
  ON public.marketing_loop_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_loop_jobs_auth_insert"
  ON public.marketing_loop_jobs;
CREATE POLICY "marketing_loop_jobs_auth_insert"
  ON public.marketing_loop_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_loop_jobs_auth_update"
  ON public.marketing_loop_jobs;
CREATE POLICY "marketing_loop_jobs_auth_update"
  ON public.marketing_loop_jobs
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_loop_jobs_auth_delete"
  ON public.marketing_loop_jobs;
CREATE POLICY "marketing_loop_jobs_auth_delete"
  ON public.marketing_loop_jobs
  FOR DELETE
  TO authenticated
  USING (false);

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ==============================================================================
-- 274_discovery_feedback.sql
-- ==============================================================================
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


-- ==============================================================================
-- 275_calendar_unique_non_partial.sql
-- ==============================================================================
-- ============================================================================
-- 275_calendar_unique_non_partial.sql
-- ============================================================================
-- Fix the external_calendar_refresh cron's 44/44 failure rate (caught
-- 2026-05-10 after Wave 8 health check fired the cron and surfaced
-- error 42P10: "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification").
--
-- Migration 169 created a PARTIAL unique index on
-- (geo_scope, title, start_date) WHERE deleted_at IS NULL. Postgres
-- supports partial unique indexes as ON CONFLICT targets ONLY when the
-- INSERT statement repeats the same WHERE predicate. The Supabase
-- PostgREST upsert API does not pass that predicate — so every upsert
-- against the calendar table fails with 42P10.
--
-- Fix: drop the partial index, recreate as a plain (non-partial) unique
-- index. Soft-deleted rows (deleted_at IS NOT NULL) are now part of the
-- uniqueness constraint — meaning the cron's ON CONFLICT updates the
-- existing row instead of inserting a duplicate. Writer logic in
-- calendar-writer.ts can choose to un-delete (set deleted_at = NULL) on
-- conflict if needed, but for the cron-populated US federal holidays
-- this is the right shape.
--
-- Idempotent: DROP IF EXISTS, CREATE IF NOT EXISTS.
-- ============================================================================

DROP INDEX IF EXISTS public.uq_ece_scope_title_start;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ece_scope_title_start
  ON public.external_calendar_events (geo_scope, title, start_date);

COMMENT ON INDEX public.uq_ece_scope_title_start IS
  '2026-05-10 — replaced the partial variant from migration 169. '
  'Partial unique indexes cannot be ON CONFLICT targets via PostgREST. '
  'Non-partial means soft-deleted rows participate in uniqueness; the '
  'cron writer should treat ON CONFLICT as un-delete-and-update rather '
  'than insert a duplicate.';

NOTIFY pgrst, 'reload schema';

