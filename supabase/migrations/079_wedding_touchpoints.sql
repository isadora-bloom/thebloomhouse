-- ---------------------------------------------------------------------------
-- 079_wedding_touchpoints.sql
-- ---------------------------------------------------------------------------
-- Phase 3 Task 35: multi-touch journey capture.
--
-- Today weddings.source is last-touch-only — a single enum value captured
-- at inquiry time. That breaks attribution the moment a couple finds
-- you on Instagram, visits your website, and then submits through The
-- Knot: the spend per The Knot inquiry looks right, but the Instagram
-- + website touch that led them there gets zero credit.
--
-- wedding_touchpoints records every observed touch in sequence. Primary
-- writers:
--   - email-pipeline.ts on new_inquiry classification (source='email',
--     medium=<classified source>)
--   - Calendly webhook on invitee.created (source='calendly')
--   - Future: UTM-carrying invite links, website analytics ingest
--
-- Schema intentionally minimal. touch_type is a low-cardinality enum so
-- queries stay fast; campaign/medium are free text. occurred_at captures
-- the real-world time (classifier time, webhook time, import date) —
-- not created_at which is always now() on insert.
--
-- Multi-venue: scoped by venue_id. A touchpoint at Rixey never affects
-- Oakwood's attribution. Coordinator intent wins: if a coordinator
-- explicitly overrides wedding.source in the UI, the last-touch column
-- on weddings stays as the display source; touchpoints remain the audit
-- trail.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wedding_touchpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE CASCADE,
  source text,
  medium text,
  campaign text,
  touch_type text NOT NULL DEFAULT 'other'
    CHECK (touch_type IN (
      'inquiry', 'email_reply', 'tour_booked', 'tour_conducted',
      'website_visit', 'ad_click', 'referral', 'calendly_booked',
      'other'
    )),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wedding_touchpoints IS
  'owner:intel. One row per observed interaction between a couple and the venue, in chronological order. Replaces the implicit last-touch attribution on weddings.source for multi-touch analysis. Writers: email-pipeline (inquiry/reply), Calendly webhook (tour_booked), and future UTM/website-analytics imports.';

CREATE INDEX IF NOT EXISTS idx_wedding_touchpoints_venue_wedding
  ON public.wedding_touchpoints (venue_id, wedding_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_wedding_touchpoints_source
  ON public.wedding_touchpoints (venue_id, source, occurred_at);

-- RLS — venue-scoped read/write, super_admin bypass, demo anon read.
ALTER TABLE public.wedding_touchpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS venue_scope_select ON public.wedding_touchpoints;
CREATE POLICY venue_scope_select ON public.wedding_touchpoints
  FOR SELECT TO authenticated
  USING (venue_id IN (
    SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
  ));

DROP POLICY IF EXISTS venue_scope_insert ON public.wedding_touchpoints;
CREATE POLICY venue_scope_insert ON public.wedding_touchpoints
  FOR INSERT TO authenticated
  WITH CHECK (venue_id IN (
    SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
  ));

DROP POLICY IF EXISTS venue_scope_update ON public.wedding_touchpoints;
CREATE POLICY venue_scope_update ON public.wedding_touchpoints
  FOR UPDATE TO authenticated
  USING (venue_id IN (
    SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
  ))
  WITH CHECK (venue_id IN (
    SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
  ));

DROP POLICY IF EXISTS venue_scope_delete ON public.wedding_touchpoints;
CREATE POLICY venue_scope_delete ON public.wedding_touchpoints
  FOR DELETE TO authenticated
  USING (venue_id IN (
    SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
  ));

DROP POLICY IF EXISTS super_admin_all ON public.wedding_touchpoints;
CREATE POLICY super_admin_all ON public.wedding_touchpoints
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS demo_anon_select ON public.wedding_touchpoints;
CREATE POLICY demo_anon_select ON public.wedding_touchpoints
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ---------------------------------------------------------------------------
-- Backfill — one touchpoint per existing wedding from the source +
-- inquiry_date columns. Idempotent: only insert where no touchpoint
-- exists yet for the (wedding, touch_type='inquiry') pair.
-- ---------------------------------------------------------------------------
INSERT INTO public.wedding_touchpoints
  (venue_id, wedding_id, source, touch_type, occurred_at)
SELECT
  w.venue_id,
  w.id,
  w.source,
  'inquiry',
  COALESCE(w.inquiry_date, w.created_at)
FROM public.weddings w
WHERE w.source IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.wedding_touchpoints wt
    WHERE wt.wedding_id = w.id AND wt.touch_type = 'inquiry'
  );

NOTIFY pgrst, 'reload schema';
