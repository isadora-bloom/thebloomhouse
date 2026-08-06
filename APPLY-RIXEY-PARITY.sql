-- ============================================================================
-- APPLY-RIXEY-PARITY.sql
-- Migrations from the Rixey→Bloom parity work (385-390), plus 382, which a
-- live schema check on 2026-08-06 found was also missing from prod. Run in the
-- Supabase SQL editor (or `supabase db push`) in order. Each block is also a
-- numbered migration file under supabase/migrations/; this file is the
-- convenience "paste it all" copy.
-- Safe to re-run: every statement is idempotent (IF EXISTS / IF NOT EXISTS).
--
-- 2026-08-06: the 389 block now carries the venue-isolation policy set it
-- shipped without. Do not paste a copy of this file taken before that date;
-- it creates couple_notifications with a venue_id column and no RLS.
--
-- Verified missing from prod (jsxxgwprxuqgcauzlxcb) on 2026-08-06 by probing
-- each column via PostgREST: 382 and 385-390 all absent.
-- ============================================================================

-- ---- 385: wedding_party save fixes -----------------------------------------
ALTER TABLE wedding_party
  ADD COLUMN IF NOT EXISTS blurb text;

ALTER TABLE wedding_party
  DROP CONSTRAINT IF EXISTS wedding_party_role_check;

COMMENT ON COLUMN wedding_party.blurb IS
  'Short blurb shown on the public wedding website (distinct from bio, the longer profile text).';

-- ---- 386: restore Rixey "worked here before?" vendor flag -------------------
-- (arrival_time / departure_time / instagram already exist from migration 032)
ALTER TABLE booked_vendors
  ADD COLUMN IF NOT EXISTS worked_here_before boolean;

COMMENT ON COLUMN booked_vendors.worked_here_before IS
  'Has this vendor worked at the venue before? true / null (unknown). Surfaced day-of so staff know who needs orienting.';

-- ---- 387: public wedding-site password protection --------------------------
ALTER TABLE wedding_website_settings
  ADD COLUMN IF NOT EXISTS site_password text;

COMMENT ON COLUMN wedding_website_settings.site_password IS
  'Optional shared password gating the public site. NULL/empty = open. Plaintext shared code, not a credential; compared server-side only, never sent to unauthenticated clients.';

-- ---- 388: make the website builder actually persist ------------------------
-- Builder wrote these columns but none existed, so every save was silently
-- rejected. url_slug is intentionally NOT added (builder maps it to slug).
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS partner1_name text;
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS partner2_name text;
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS venue_name text;
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS venue_address text;
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS wedding_date text;
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS sections jsonb DEFAULT '[]'::jsonb;

-- ---- 389: couple-facing notifications --------------------------------------
CREATE TABLE IF NOT EXISTS couple_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_couple_notifications_wedding
  ON couple_notifications (wedding_id, read, created_at DESC);

COMMENT ON TABLE couple_notifications IS
  'Couple-facing notification feed (per wedding). Backs the bell in the couple top bar. type e.g. new_message / planning_reminder; link is a relative couple-portal path.';

-- 389 venue isolation (gap G17). Without this the table ships with a venue_id
-- column and no RLS at all. Canonical policy set, copied from the prod-proven
-- 377/383 pattern. The service_role policy is the one that keeps the bell
-- working: every read/write goes through the service key.
ALTER TABLE public.couple_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple_notifications_select" ON public.couple_notifications;
CREATE POLICY "couple_notifications_select" ON public.couple_notifications
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

DROP POLICY IF EXISTS "couple_notifications_modify" ON public.couple_notifications;
CREATE POLICY "couple_notifications_modify" ON public.couple_notifications
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

DROP POLICY IF EXISTS "couple_notifications_service" ON public.couple_notifications;
CREATE POLICY "couple_notifications_service" ON public.couple_notifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_couple_notifications" ON public.couple_notifications;
CREATE POLICY "demo_anon_select_couple_notifications" ON public.couple_notifications
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ---- 390: restore wedding-details family + contract + logistics fields -----
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS partner1_parents text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS partner1_parents_met boolean;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS partner2_parents text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS partner2_parents_met boolean;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_checkin text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_checkout text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_max_rehearsal integer;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_max_wedding integer;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_overnights integer;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_rehearsal_hours text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_wedding_hours text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS dog_sitter_name text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS dog_sitter_time text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS high_chairs text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS wedding_party_count text;

-- ---- 382: seating table notes ----------------------------------------------
-- NOT part of the parity work. Folded in on 2026-08-06 because a live schema
-- check found it missing from prod too, and it is one more paste otherwise.
-- Canonical source is still supabase/migrations/382_seating_table_notes.sql.
ALTER TABLE seating_tables
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE seating_tables
  DROP CONSTRAINT IF EXISTS seating_tables_table_type_check;

ALTER TABLE seating_tables
  ADD CONSTRAINT seating_tables_table_type_check
  CHECK (table_type IN ('round', 'rectangle', 'rectangular', 'head', 'sweetheart', 'farm', 'cocktail'));
