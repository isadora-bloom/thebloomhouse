-- ---------------------------------------------------------------------------
-- 377_knot_visitor_activity.sql
-- ---------------------------------------------------------------------------
-- Knot visitor-activity CSV ingestion + verification-visit signal type.
-- Operator-shared 2026-05-27 (the Doug L. canary case: 13 Knot actions
-- including a Message in April with no email anywhere in the operator's
-- pipeline — the relayed Message likely lives only inside the Knot
-- dashboard inbox).
--
-- WHY THIS EXISTS
-- ---------------
-- The Knot exports a CSV called `<Venue>-visitor-activities (N).csv`
-- with columns:
--   Action Taken, Visitor Name, Date of Visit, City, State
--
-- Action values include:
--   Storefront View, Storefront Save, Message, Click to Website,
--   Click to Social
--
-- For Rixey's last 12 months: 697 distinct visitors, 361 messagers,
-- ~104 save-but-never-message, ~54 click-to-website. Bloom today only
-- sees the messagers (because Knot only forwards Message actions as
-- relay emails — and even then only some of them). Saves, views, and
-- website clicks are invisible.
--
-- The bigger insight: The Knot is not just a lead SOURCE, it is a
-- VERIFICATION LAYER. Couples find Rixey on Google / IG / referral,
-- then verify by viewing the Knot profile multiple times before
-- committing. ~70% of Knot messagers viewed the profile first.
-- Couples ALREADY in Bloom's pipeline (calculator submitters,
-- post-tour leads) come back and view Knot to verify — that is a
-- heat signal Bloom currently has no visibility into. This migration
-- adds the storage; the importer (knot-visitor-activity.ts) and
-- matcher (knot-visitor-match.ts) add the live signal.
--
-- WHAT THIS DOES
-- --------------
-- 1. Creates `knot_visitor_activity` — one row per CSV row.
--    Idempotent on `row_fingerprint` (sha256 of normalised row) so
--    weekly re-uploads of the rolling-12-month export are no-ops.
-- 2. Backreferences to `couples` + `people` once the matcher binds
--    a row to a known identity (post-import sweep — most rows arrive
--    unbound because Knot exposes only "Doug L." not "Doug Lopez").
-- 3. Standard venue-scoped RLS + demo-anon read.
--
-- Does NOT extend `touchpoints.channel` CHECK (the column has no CHECK
-- constraint per mig 346 — it is free text; the channel value 'knot'
-- has been valid since day one). Does NOT extend `engagement_events
-- .event_type` CHECK (also free text per mig 002). The new event types
-- emitted by the verification-visit signal writer (knot_verification_
-- visit, knot_profile_viewed, knot_profile_saved, knot_website_clicked)
-- are simply new string values that the existing column accepts.
--
-- Multi-venue safe — venue-scoped throughout. Idempotent on rerun:
-- IF NOT EXISTS guards on every CREATE; IF EXISTS guards on every DROP.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.knot_visitor_activity (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id              uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Identity backreferences. NULL on first insert; populated by the
  -- matcher sweep (knot-visitor-match.ts) when a row binds to a known
  -- person/couple. The post-bind cascade emits a verification-visit
  -- engagement_event when the bound couple is mid-pipeline.
  person_id             uuid REFERENCES public.people(id) ON DELETE SET NULL,
  couple_id             uuid REFERENCES public.couples(id) ON DELETE SET NULL,

  -- Raw CSV fields (preserved verbatim for operator forensics +
  -- re-matching when a fuller identity later arrives).
  visitor_name          text NOT NULL,
  visitor_first_name    text,
  visitor_last_initial  text,
  city                  text,
  state                 text,

  -- Canonicalised action enum. Knot's free-text "Action Taken" maps to
  -- one of these five values via the importer's classifier; any
  -- unrecognised value lands as 'other' (preserving raw verbatim above).
  action_taken          text NOT NULL CHECK (action_taken IN (
    'storefront_view',
    'storefront_save',
    'message',
    'click_to_website',
    'click_to_social',
    'other'
  )),
  action_at             timestamptz NOT NULL,

  -- Groups all rows from one CSV upload — operator can see "the import
  -- from 2026-05-27 03:00 brought in N rows, M matched, K became ghosts".
  import_batch_id       uuid,

  -- Idempotency key for re-upload safety. sha256 of:
  --   `${venue_id}|${visitor_name}|${action_taken}|${action_at_iso}|${city}|${state}`
  -- Computed by the importer (server-side, never trust client). UNIQUE
  -- per venue so two venues can theoretically generate the same hash
  -- without collision (defensive — venue_id is already in the digest
  -- so this is belt + suspenders).
  row_fingerprint       text NOT NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (venue_id, row_fingerprint)
);

COMMENT ON TABLE public.knot_visitor_activity IS
  'owner:agent. One row per Knot visitor-activity CSV row (Storefront View / Save / Message / Click to Website / Click to Social). Idempotent on row_fingerprint so weekly re-uploads short-circuit. person_id/couple_id populated by the post-import matcher sweep (knot-visitor-match.ts). The verification-visit signal writer reads this table to detect couples already in pipeline who came back to view Knot — a heat signal Bloom did not have visibility into before. See migration 377 header for the operator-shared canary case (Doug L. 2026-05-27).';

COMMENT ON COLUMN public.knot_visitor_activity.visitor_last_initial IS
  'Single letter only. Knot redacts the last name to first initial in their CSV export ("Doug L." not "Doug Lopez"). Stored as initial so the matcher can pattern-match against the people table (last_name LIKE ''L%'') without treating it as a full surname.';

COMMENT ON COLUMN public.knot_visitor_activity.row_fingerprint IS
  'sha256(venue_id|visitor_name|action_taken|action_at|city|state). Idempotency key for recurring CSV re-uploads — Knot exports are 12-month rolling windows, operators re-upload weekly with ~95% overlap. UNIQUE(venue_id, row_fingerprint) is the dedup chokepoint.';

-- ---------------------------------------------------------------------------
-- Indexes — supports the live read patterns:
--   (venue_id, person_id) → "every Knot action for this person"
--      (used by getVisitorJourneyMetrics + verification-visit detection)
--   (venue_id, couple_id) → "every Knot action for this couple"
--   (venue_id, action_at DESC) → "recent Knot activity at this venue"
--      (used by the operator-visible dashboard)
--   (venue_id, import_batch_id) → "rows from this specific upload"
--      (used by the matcher sweep to scope to one batch).
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_knot_visitor_activity_venue_person
  ON public.knot_visitor_activity (venue_id, person_id)
  WHERE person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knot_visitor_activity_venue_couple
  ON public.knot_visitor_activity (venue_id, couple_id)
  WHERE couple_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knot_visitor_activity_venue_time
  ON public.knot_visitor_activity (venue_id, action_at DESC);

CREATE INDEX IF NOT EXISTS idx_knot_visitor_activity_batch
  ON public.knot_visitor_activity (venue_id, import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- Last-initial matching support — `WHERE first_name ILIKE 'doug%' AND
-- last_name ILIKE 'l%'` plus venue-scoped narrowing. The first-name +
-- last-initial composite is the canonical matcher shape, so an
-- expression index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_knot_visitor_activity_name_lookup
  ON public.knot_visitor_activity (venue_id, lower(visitor_first_name), lower(visitor_last_initial))
  WHERE visitor_first_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- updated_at trigger — match the convention used by `couples` /
-- `weddings` / similar venue-scoped tables.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.knot_visitor_activity_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_knot_visitor_activity_updated_at ON public.knot_visitor_activity;
CREATE TRIGGER trg_knot_visitor_activity_updated_at
  BEFORE UPDATE ON public.knot_visitor_activity
  FOR EACH ROW
  EXECUTE FUNCTION public.knot_visitor_activity_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — venue-scoped read/write, super_admin bypass, demo anon read.
-- Mirrors the wedding_touchpoints + couples shape (mig 079 + mig 346).
-- ---------------------------------------------------------------------------

ALTER TABLE public.knot_visitor_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kva_select" ON public.knot_visitor_activity;
CREATE POLICY "kva_select" ON public.knot_visitor_activity
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "kva_modify" ON public.knot_visitor_activity;
CREATE POLICY "kva_modify" ON public.knot_visitor_activity
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "kva_service" ON public.knot_visitor_activity;
CREATE POLICY "kva_service" ON public.knot_visitor_activity
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_kva" ON public.knot_visitor_activity;
CREATE POLICY "demo_anon_select_kva" ON public.knot_visitor_activity
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

NOTIFY pgrst, 'reload schema';
