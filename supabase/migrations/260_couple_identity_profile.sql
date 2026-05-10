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
