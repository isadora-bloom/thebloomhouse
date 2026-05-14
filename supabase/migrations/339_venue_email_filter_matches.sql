-- ---------------------------------------------------------------------------
-- 339_venue_email_filter_matches.sql
-- ---------------------------------------------------------------------------
-- Anchor: Round 2 audit TIER 5e+ (2026-05-14). The TIER 5e audit wrap
-- could only count no_draft hits (because those persist via interactions).
-- ignore-filter hits never touched the DB — the pipeline bails before
-- the classifier writes anything. That made the audit dishonest about
-- the most aggressive filter class.
--
-- This migration adds a thin filter-match log so every filter decision
-- is recorded, regardless of action. The audit endpoint then has real
-- numbers for ignore + no_draft + gmail_label rules.
--
-- Why a separate table (not a column on interactions):
--   1. ignore filters short-circuit before the interaction insert, so
--      there is no row to decorate. A dedicated log row is the only
--      place these decisions can live.
--   2. Filter rules can fire on emails we never want to persist as
--      interactions (newsletters, transactional, bounces). Logging
--      them in interactions would pollute the inbox lifecycle counts
--      that already filter direction='inbound'.
--   3. The log is operator-audit-only. It does NOT feed the brain or
--      attribution. Keep the surfaces clean.
--
-- Retention: 90 days. Long enough for "is this rule pulling weight"
-- + "what hit this morning before I changed the rule" questions.
-- A purge cron trims rows older than 90 days. No PII beyond the
-- sender address — message subjects + bodies are NOT logged.

CREATE TABLE IF NOT EXISTS public.venue_email_filter_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  filter_id uuid NOT NULL REFERENCES public.venue_email_filters(id) ON DELETE CASCADE,
  -- Denormalised at write time so the row survives a filter delete + we can
  -- still answer "what did this domain trigger" after a rule rotation.
  pattern text NOT NULL,
  pattern_type text NOT NULL CHECK (pattern_type IN ('sender_exact', 'sender_domain', 'gmail_label')),
  action text NOT NULL CHECK (action IN ('ignore', 'no_draft')),
  from_email text NOT NULL,
  -- gmail_label rules log the matched label so the operator can see
  -- "this rule caught 4 promotional emails this week from CATEGORY_PROMOTIONS".
  matched_label text,
  matched_at timestamptz NOT NULL DEFAULT now()
);

-- Audit endpoint sorts by matched_at DESC + filters by venue + date range.
CREATE INDEX IF NOT EXISTS venue_email_filter_matches_venue_at_idx
  ON public.venue_email_filter_matches (venue_id, matched_at DESC);

-- Per-rule counts use this.
CREATE INDEX IF NOT EXISTS venue_email_filter_matches_filter_at_idx
  ON public.venue_email_filter_matches (filter_id, matched_at DESC);

-- Domain rollups use this (e.g. "show me everything we filtered from
-- mailchimp.com last week").
CREATE INDEX IF NOT EXISTS venue_email_filter_matches_from_idx
  ON public.venue_email_filter_matches (venue_id, from_email);

-- RLS: operators of the venue can read their own matches. No write from
-- the client — only the service role (pipeline) ever inserts here.
ALTER TABLE public.venue_email_filter_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS venue_email_filter_matches_select_own
  ON public.venue_email_filter_matches;
CREATE POLICY venue_email_filter_matches_select_own
  ON public.venue_email_filter_matches
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS venue_email_filter_matches_super_admin
  ON public.venue_email_filter_matches;
CREATE POLICY venue_email_filter_matches_super_admin
  ON public.venue_email_filter_matches
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMENT ON TABLE public.venue_email_filter_matches IS
  'Audit log for every venue_email_filters decision. TIER 5e+ (2026-05-14). '
  'ignore-rule hits never persist as interactions, so this is the only '
  'place to count them. 90-day retention; purged by nightly cron.';
