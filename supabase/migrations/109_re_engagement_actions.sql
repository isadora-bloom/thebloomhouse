-- ---------------------------------------------------------------------------
-- 109_re_engagement_actions.sql
-- ---------------------------------------------------------------------------
-- Phase D Tier 2 / D2.1 (2026-04-30). Re-engagement queue: when a
-- candidate identity engaged deeply on a platform (funnel_depth >= 3)
-- but never inquired, the coordinator can draft an AI-generated
-- re-engagement message and send it via the platform's DM tool
-- (Knot, Instagram, Pinterest, Google Business, etc.) or via email
-- when the candidate has a known address.
--
-- Each row tracks one re-engagement attempt. The drafter generates
-- the text; coordinator reviews/edits before sending; channel
-- captures whether it was sent through email (auto) or copy-pasted
-- to the platform manually. Conversion attribution: if a matching
-- wedding inquires within 60 days of sent_at, link
-- conversion_wedding_id back so the action can be marked successful.
--
-- The 60-day window is locked (matches the user-confirmed scope).
-- Generic drafts only (no surveillance phrasing — couple knows they
-- used the platform, but specific signal counts never quoted).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.re_engagement_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  candidate_identity_id uuid NOT NULL REFERENCES public.candidate_identities(id) ON DELETE CASCADE,

  -- Platform the message is drafted for. Drives tone/format.
  platform text NOT NULL,

  -- AI draft body. Coordinator can edit before sending; final
  -- sent_text captures what actually went out.
  draft_text text NOT NULL,
  sent_text text,
  drafted_by_model text,
  drafted_at timestamptz NOT NULL DEFAULT now(),

  -- Sent state. NULL means drafted but not yet sent.
  sent_at timestamptz,
  sent_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  -- channel = how the message was delivered:
  --   'manual_paste' — coordinator copied to the platform (Knot DM,
  --      IG DM, Pinterest message, etc). Most common.
  --   'email' — venue had the candidate's email and one-click sent.
  --   'discarded' — coordinator decided not to send.
  channel text CHECK (channel IS NULL OR channel IN ('manual_paste', 'email', 'discarded')),

  -- 60-day conversion attribution. Set when a wedding tied to this
  -- candidate's identity inquires within 60 days of sent_at. NULL
  -- when no conversion or window not yet expired.
  conversion_wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  conversion_detected_at timestamptz,
  -- Inquiry channel that closed the conversion. Captures whether
  -- email landed it (1-touch confirmation) or it took platform DMs
  -- + email + tour. Free text; no constraint.
  conversion_inquiry_channel text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.re_engagement_actions IS
  'Phase D Tier 2 (2026-04-30). One row per re-engagement attempt against a high-funnel non-converting candidate. Tracks the AI draft, the actual sent text, the channel (manual paste vs email vs discarded), and the 60-day conversion window outcome.';

COMMENT ON COLUMN public.re_engagement_actions.channel IS
  'How the message was delivered: manual_paste (coordinator copied to Knot/IG/Pinterest DM), email (one-click sent through venue Gmail), discarded (drafted but coordinator chose not to send). NULL when sent_at is also NULL (drafted, not yet decided).';

COMMENT ON COLUMN public.re_engagement_actions.conversion_wedding_id IS
  '60-day conversion attribution. Set when a wedding tied to this candidate inquires within 60 days of sent_at. NULL means no conversion yet or conversion window not yet expired.';

-- Queue lookup for /intel/reengagement.
CREATE INDEX IF NOT EXISTS idx_re_engagement_venue_drafted
  ON public.re_engagement_actions (venue_id, drafted_at DESC);

-- Conversion-window scan (nightly job): find sent rows whose 60-day
-- window is still open and check for new wedding matches.
CREATE INDEX IF NOT EXISTS idx_re_engagement_window_open
  ON public.re_engagement_actions (venue_id, sent_at)
  WHERE sent_at IS NOT NULL AND conversion_wedding_id IS NULL;

-- Per-candidate lookup for the cohort panel: "has this candidate
-- already been re-engaged?"
CREATE INDEX IF NOT EXISTS idx_re_engagement_candidate
  ON public.re_engagement_actions (candidate_identity_id, drafted_at DESC);

ALTER TABLE public.re_engagement_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "re_engagement_select" ON public.re_engagement_actions;
CREATE POLICY "re_engagement_select" ON public.re_engagement_actions
  FOR SELECT TO authenticated
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

DROP POLICY IF EXISTS "re_engagement_update" ON public.re_engagement_actions;
CREATE POLICY "re_engagement_update" ON public.re_engagement_actions
  FOR UPDATE TO authenticated
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

DROP POLICY IF EXISTS "demo_anon_select" ON public.re_engagement_actions;
CREATE POLICY "demo_anon_select" ON public.re_engagement_actions
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

CREATE OR REPLACE FUNCTION public.re_engagement_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_re_engagement_updated_at ON public.re_engagement_actions;
CREATE TRIGGER trg_re_engagement_updated_at
  BEFORE UPDATE ON public.re_engagement_actions
  FOR EACH ROW
  EXECUTE FUNCTION public.re_engagement_touch_updated_at();

NOTIFY pgrst, 'reload schema';
