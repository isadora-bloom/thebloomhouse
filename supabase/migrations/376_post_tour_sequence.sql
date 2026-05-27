-- ============================================================================
-- Migration 376 — Post-tour nurture sequence (3-email, T+24h / T+3d / T+7d)
-- ============================================================================
--
-- Anchor docs (~/.claude memory/):
--   - bloom-constitution.md (Sage drafts go to coordinator approval;
--     auto-send is gated by auto_send_rules; voice-shape only on
--     sensitive themes)
--   - bloom-may19-d6-ship.md (couple-keyed nurture surfaces respect the
--     identity-first doctrine — one row per wedding / couple, not per
--     interaction)
--   - bloom-auto-send-cap-audit.md (per-thread + daily caps enforced by
--     checkAutoSendEligible; this sequence falls through that gate same
--     as the inquiry follow-up cron)
--
-- WHY THIS EXISTS
-- ---------------
-- Operator-reported gap (2026-05-27): 12 couples toured at Rixey in the
-- last two weeks with NO automated follow-up email. Calendly fires a
-- `tour_completed` notification, Bloom logs the tour in tours/
-- engagement_events, but no downstream sequence nurtures the lead until
-- a coordinator manually reaches out. The platform already has:
--   * tour_outcome_classifier — stamps tours.outcome='completed'
--   * generatePostTourFollowUp (post_tour_followup_jobs queue) — a
--     ONE-shot Sage draft on stage transition to tour_completed
--
-- What was missing is a multi-email sequence with state tracking and
-- pause logic — the same shape as follow_up_sequences.ts (inquiry
-- nurture) but anchored on a different trigger (tour completion).
--
-- This migration adds the state table; the runner lives at
-- src/lib/services/email/post-tour-sequence.ts and piggybacks on the
-- existing hourly `follow_up_sequences` cron (vercel.json at the Pro
-- 40-cron cap — no new entry).
--
-- WHAT THIS TABLE TRACKS
-- ----------------------
-- One row per wedding that has a completed tour. The runner upserts on
-- first observation; cron ticks advance through the 3 emails:
--
--   email_1 (T+24h)  "Thanks for visiting" — warm, personalised, 1
--                     specific reference. Reuses generatePostTourFollowUp.
--   email_2 (T+3d)   "Any questions after your visit?" — soft check-in.
--   email_3 (T+7d)   "Just thinking of you — is a date shaping up?" —
--                     nurture with a clean off-ramp.
--
-- Pause / completion:
--   - inbound reply by couple after tour_completed_at → paused
--   - wedding flips to booked / lost → paused + sequence_completed_at set
--   - all 3 emails sent → sequence_completed_at set
--   - coordinator-driven manual override → paused_at + paused_reason
--
-- The runner respects auto_send_rules same as the inquiry follow-up cron:
-- drafts default to status='pending' for coordinator review unless the
-- venue has auto-send enabled for context='client' / source=<detected>
-- AND the per-thread cap + daily limit + cost-ceiling pause allow it.
--
-- Idempotent: every CREATE uses IF NOT EXISTS. RLS permissive (matches
-- 225/226/246/261/278/281 doctrine — venue scope owned upstream by
-- membership context; service-role bypass for cron writes).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 1 — post_tour_sequence table
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.post_tour_sequence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  tour_id uuid REFERENCES public.tours(id) ON DELETE SET NULL,

  -- Anchor: when the tour was completed. The runner uses the tour's
  -- scheduled_at (since tours has no separate completed_at column —
  -- the outcome stamp is on `tours.outcome='completed'` + `updated_at`,
  -- and scheduled_at is the truth of "when did the couple actually walk
  -- the venue"). Captured at upsert time so re-classifications later
  -- don't move the clock.
  tour_completed_at timestamptz NOT NULL,

  -- Per-step send markers. NULL until the cron generates the draft for
  -- that step. We stamp on DRAFT INSERT (not on actual auto-send-fire)
  -- so a re-run of the cron does not double-draft. The auto_send path
  -- carries its own queue + 5-min cancel window downstream; whether a
  -- given draft eventually fires or stays pending for coordinator review
  -- is a separate concern.
  email_1_sent_at timestamptz,
  email_2_sent_at timestamptz,
  email_3_sent_at timestamptz,

  -- Draft FK back-pointers (NULL until the matching email_N is drafted).
  -- Lets the coordinator UI surface "which draft did this sequence
  -- generate" without needing a sibling join on follow_up_step.
  email_1_draft_id uuid REFERENCES public.drafts(id) ON DELETE SET NULL,
  email_2_draft_id uuid REFERENCES public.drafts(id) ON DELETE SET NULL,
  email_3_draft_id uuid REFERENCES public.drafts(id) ON DELETE SET NULL,

  -- Pause state. Set when:
  --   - inbound interaction lands on the wedding after tour_completed_at
  --     (couple replied — humans take over)
  --   - coordinator hits a manual override
  -- The runner skips paused rows. Coordinator resume is a one-line UPDATE.
  paused_at timestamptz,
  paused_reason text,

  -- Terminal state. Set when:
  --   - email_3 sent (sequence ran its full course)
  --   - wedding flipped to booked / lost / cancelled (no need to nurture)
  --   - coordinator explicitly closed
  sequence_completed_at timestamptz,
  completed_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.post_tour_sequence IS
  'Migration 376 (2026-05-27). State per wedding for the 3-email '
  'post-tour nurture sequence (T+24h / T+3d / T+7d). Runner lives at '
  'src/lib/services/email/post-tour-sequence.ts; folded into the '
  'hourly follow_up_sequences cron. Reuses generatePostTourFollowUp '
  '(post-tour-sage.ts) for email_1; lighter inline prompts for emails '
  '2 and 3. Falls into checkAutoSendEligible like every other follow-up.';

-- One sequence per wedding. If a wedding had a previous tour cycle and
-- now has a re-tour, the cron skips re-upsert (sequence_completed_at
-- IS NOT NULL → terminal) UNLESS we add an explicit reopen path later.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_post_tour_sequence_wedding
  ON public.post_tour_sequence (wedding_id);

-- Cron-drain index: every hourly tick scans for active (non-paused,
-- non-completed) rows whose tour_completed_at is in the last 14 days.
CREATE INDEX IF NOT EXISTS idx_post_tour_sequence_active_drain
  ON public.post_tour_sequence (venue_id, tour_completed_at)
  WHERE paused_at IS NULL
    AND sequence_completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_post_tour_sequence_tour
  ON public.post_tour_sequence (tour_id)
  WHERE tour_id IS NOT NULL;

-- Maintain updated_at on every row mutation. Reuse the existing
-- handle_updated_at() function if present (mig 002+); fall back to an
-- inline trigger body otherwise.
CREATE OR REPLACE FUNCTION public.post_tour_sequence_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_post_tour_sequence_updated_at
  ON public.post_tour_sequence;
CREATE TRIGGER trg_post_tour_sequence_updated_at
  BEFORE UPDATE ON public.post_tour_sequence
  FOR EACH ROW
  EXECUTE FUNCTION public.post_tour_sequence_set_updated_at();

-- ----------------------------------------------------------------------------
-- STEP 2 — RLS
-- ----------------------------------------------------------------------------
-- Permissive read for any authenticated user (sequence state is
-- coordinator-visible context; venue scope owned by membership upstream).
-- Inserts + updates go through the service-role cron + a future
-- coordinator UI; both run as service role or via authenticated routes
-- with venue scope already validated.

ALTER TABLE public.post_tour_sequence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_post_tour_sequence"
  ON public.post_tour_sequence;
CREATE POLICY "auth_select_post_tour_sequence"
  ON public.post_tour_sequence
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_post_tour_sequence"
  ON public.post_tour_sequence;
CREATE POLICY "auth_insert_post_tour_sequence"
  ON public.post_tour_sequence
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_post_tour_sequence"
  ON public.post_tour_sequence;
CREATE POLICY "auth_update_post_tour_sequence"
  ON public.post_tour_sequence
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- STEP 3 — refresh REST schema cache
-- ----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

COMMIT;
