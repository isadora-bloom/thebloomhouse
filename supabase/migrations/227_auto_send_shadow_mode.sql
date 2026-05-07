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
