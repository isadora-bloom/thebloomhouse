
-- ============================================================================
-- ▶ 227_auto_send_shadow_mode.sql
-- ============================================================================
-- ============================================================================
-- 227: AUTO-SEND SHADOW MODE (Tier-B #67A)
--
-- Lets a venue's auto-send rule observe its OWN behaviour for a probationary
-- period before going live. While shadow_mode=true, checkAutoSendEligible
-- runs the full decision chain BUT records the result in
-- auto_send_shadow_decisions instead of firing. The coordinator reviews
-- the log and promotes the rule to live with one click once they've
-- watched N consecutive correct calls.
--
-- Defaults:
--   - New rules: shadow_mode = true, enabled = true. The combination
--     means "the rule is configured but it's only watching, not firing."
--   - Existing rows: shadow_mode = false (preserves current behaviour).
--   - When enabled = false, shadow_mode is irrelevant (rule is fully off).
--
-- Promotion is a single UPDATE: shadow_mode = false. No data migration.
-- ============================================================================

ALTER TABLE public.auto_send_rules
  ADD COLUMN IF NOT EXISTS shadow_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shadow_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS graduated_at timestamptz,
  ADD COLUMN IF NOT EXISTS graduated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.auto_send_rules.shadow_mode IS
  'When true, the eligibility decision is computed and logged to auto_send_shadow_decisions but the draft is NOT actually sent. Coordinator promotes to live by setting shadow_mode=false. Default false on existing rows so legacy behaviour is preserved; new rules default true via application code (so onboarding gets a probationary period).';

COMMENT ON COLUMN public.auto_send_rules.shadow_started_at IS
  'Timestamp when shadow_mode was last set true. Used by the review UI to age the shadow log ("watching for 3 days").';

COMMENT ON COLUMN public.auto_send_rules.graduated_at IS
  'Timestamp when shadow_mode was set false (promoted to live). NULL for rules that never shadowed.';

COMMENT ON COLUMN public.auto_send_rules.graduated_by IS
  'user_profiles.id of the coordinator who promoted the rule. NULL for legacy auto-graduated rules or service-role flips.';

-- ============================================================================
-- auto_send_shadow_decisions: log of eligibility decisions while shadow
--
-- One row per call to checkAutoSendEligible while the matching rule is in
-- shadow_mode. Captures the decision the rule WOULD have made so the
-- coordinator can review accuracy before promoting.
--
-- Includes the full decision-input snapshot so retro analysis is possible
-- ("the rule said eligible at confidence 0.78; was that right?"). Inputs
-- are intentionally denormalised — joining back to the source draft would
-- be cleaner but couples might be deleted before review.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.auto_send_shadow_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.auto_send_rules(id) ON DELETE SET NULL,
  draft_id uuid REFERENCES public.drafts(id) ON DELETE SET NULL,
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  thread_id text,

  -- Decision snapshot
  context_type text NOT NULL,
  source text,
  confidence_score numeric NOT NULL,
  injection_suspected boolean NOT NULL DEFAULT false,
  would_have_sent boolean NOT NULL,
  reason text NOT NULL,

  -- Coordinator review
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  review_verdict text CHECK (review_verdict IS NULL OR review_verdict IN ('correct', 'wrong_send', 'wrong_block')),
  review_note text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_decisions_venue_created
  ON public.auto_send_shadow_decisions(venue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_decisions_rule
  ON public.auto_send_shadow_decisions(rule_id);
CREATE INDEX IF NOT EXISTS idx_shadow_decisions_unreviewed
  ON public.auto_send_shadow_decisions(venue_id, reviewed_at)
  WHERE reviewed_at IS NULL;

COMMENT ON TABLE public.auto_send_shadow_decisions IS
  'Log of auto-send eligibility decisions made while the matching auto_send_rule was in shadow_mode. Coordinator reviews and approves/rejects each decision via /agent/auto-send-shadow before promoting the rule. INV: writes only when shadow_mode=true.';

COMMENT ON COLUMN public.auto_send_shadow_decisions.would_have_sent IS
  'TRUE if the eligibility chain decided the draft was eligible to auto-send. FALSE if any gate (cost-ceiling, direction, injection, rule-disabled, threshold, thread-cap, daily-cap, require-new-contact) blocked. The reason column carries the specific gate that fired.';

COMMENT ON COLUMN public.auto_send_shadow_decisions.review_verdict IS
  'correct=coordinator agrees with the decision. wrong_send=rule said eligible but the coordinator would not have sent. wrong_block=rule said ineligible but the coordinator wishes it had sent. Drives the "ready to graduate" heuristic.';

-- ============================================================================
-- RLS — venue-scoped reads/writes for coordinators; service-role inserts.
-- ============================================================================

ALTER TABLE public.auto_send_shadow_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_isolation" ON public.auto_send_shadow_decisions;
CREATE POLICY "venue_isolation" ON public.auto_send_shadow_decisions
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "super_admin_bypass" ON public.auto_send_shadow_decisions;
CREATE POLICY "super_admin_bypass" ON public.auto_send_shadow_decisions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 229_intel_acknowledgments.sql
-- ============================================================================
-- ============================================================================
-- 229: INTEL_ACKNOWLEDGMENTS (Tier-B #64A)
--
-- Generic suppression table for intel "insight" surfaces that don't have
-- their own backing row (anomaly_alerts already carries an acknowledged
-- flag and isn't covered here). Many intel pages — forecasts, capacity,
-- sources/parity, market-pulse, source-quality scorecards — render
-- coordinator-facing cards like "Tour cancellation rate is 34% this
-- month" with no way to mark them as seen. The card re-appears next
-- week / next page-view; coordinator reads it again and does nothing.
--
-- Mechanics:
--   - Each renderable insight has a stable (kind, key) pair. kind is
--     the surface name ("forecasts.q3_dropoff" or "market_pulse.cpi_spike"),
--     key is whatever uniquely identifies THIS instance ("2026-08" for a
--     month-bucket, or the hash of the underlying input window).
--   - When a coordinator clicks "Got it" the row inserts (or updates).
--   - Render paths LEFT JOIN this table and filter out rows where
--     suppress_until > NOW().
--   - Default suppress window: 7 days. Coordinator can extend per-row
--     via the API later.
--
-- Out of scope:
--   - Per-venue defaults for the suppress window (could ship if 7d
--     turns out to be the wrong shape; defer until coordinator feedback).
--   - "Wrong" verdict tracking. Today this is binary (seen/unseen);
--     accuracy feedback lives separately in shadow-decisions for now.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intel_acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  insight_kind text NOT NULL,
  insight_key text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  suppress_until timestamptz NOT NULL DEFAULT now() + interval '7 days',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, insight_kind, insight_key)
);

CREATE INDEX IF NOT EXISTS idx_intel_acks_venue_active
  ON public.intel_acknowledgments(venue_id, suppress_until DESC);

COMMENT ON TABLE public.intel_acknowledgments IS
  'Coordinator suppression of display-only intel insights (forecasts, capacity, sources/parity, market-pulse, source-quality, etc). Keyed on a (venue_id, insight_kind, insight_key) tuple. Render paths filter out rows where suppress_until > NOW(). Tier-B #64A.';

COMMENT ON COLUMN public.intel_acknowledgments.insight_kind IS
  'Surface identifier, e.g. "forecasts.q3_dropoff" or "market_pulse.cpi_spike". Stable across deployments; treat as an enum without a CHECK constraint so adding new surfaces does not require a migration.';

COMMENT ON COLUMN public.intel_acknowledgments.insight_key IS
  'Per-instance identifier within the kind. Examples: "2026-08" for a month-bucket, FNV-1a hash of input data for content-bound insights, or a row id when the insight maps 1:1 to another table. Together with kind makes a stable suppression target.';

COMMENT ON COLUMN public.intel_acknowledgments.suppress_until IS
  'Insight is hidden from rendering until this timestamp passes. Default 7 days from acknowledgment. Coordinator can clear (DELETE) or extend via the API.';

-- ============================================================================
-- RLS — venue-scoped reads/writes for coordinators; service-role bypass.
-- ============================================================================

ALTER TABLE public.intel_acknowledgments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_isolation" ON public.intel_acknowledgments;
CREATE POLICY "venue_isolation" ON public.intel_acknowledgments
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "super_admin_bypass" ON public.intel_acknowledgments;
CREATE POLICY "super_admin_bypass" ON public.intel_acknowledgments
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 230_interactions_portal_chat_type.sql
-- ============================================================================
-- ============================================================================
-- 230: INTERACTIONS — portal_chat type (Tier-B #58C)
--
-- The agent inbox reads from `interactions`. In-portal couple messages
-- have lived in a separate `messages` table since mig 004 — coordinators
-- never saw them in their main inbox. Tier-B audit #58 flagged this as
-- a real coordinator pain.
--
-- Option C (selected by user): mirror in-portal couple messages into
-- `interactions` with a new type='portal_chat'. This keeps the existing
-- inbox surface unchanged (filtering, categorization, threads, escalation
-- detection all keep working) and adds a clear channel pill so
-- coordinators know which messages are from the portal vs Gmail.
--
-- The `messages` table stays as the source of truth for the couple-side
-- thread view; interactions is the read-only mirror for the coordinator
-- inbox. Coordinator replies STILL flow through the portal Messages UI
-- (a small server-side endpoint mirrors them back into messages so the
-- couple sees the response). Gmail is never involved for portal_chat.
-- ============================================================================

ALTER TABLE public.interactions DROP CONSTRAINT IF EXISTS interactions_type_check;
ALTER TABLE public.interactions
  ADD CONSTRAINT interactions_type_check
  CHECK (type IN ('email', 'call', 'voicemail', 'sms', 'meeting', 'web_form', 'portal_chat'));

COMMENT ON CONSTRAINT interactions_type_check ON public.interactions IS
  'Allowed interaction kinds. portal_chat added 2026-05-08 by migration 230 (Tier-B #58C) for in-portal couple messages mirrored from the messages table for agent-inbox visibility.';

NOTIFY pgrst, 'reload schema';
