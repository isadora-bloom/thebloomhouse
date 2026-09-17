-- 418_portal_calm
--
-- Isadora, 17 Sep 2026, after the portal market comparison
-- (audits/2026-09-17-portal-market-comparison.md): the portal must not
-- pressure people. Five pieces, each a venue-by-venue choice:
--
--   1. Sections switch on and off per venue, and can be released on a
--      date, so a couple isn't shown thirty-two sections on day one.
--   2. A soft close: N days before the wedding, couple edits stop and
--      become requests to the venue. Off unless the venue sets it.
--   3. "Where things stand": the few things a venue is actually waiting
--      on from the couple, with a date. couple_asks.
--   4. Live notes from the venue to the couple, always current.
--   5. A timeline item can be hidden from one person (a surprise).
--
-- Idempotent. No BEGIN/COMMIT (migration convention).

-- 1. Section release dates ----------------------------------------------
ALTER TABLE public.portal_section_config
  ADD COLUMN IF NOT EXISTS release_at timestamptz;
COMMENT ON COLUMN public.portal_section_config.release_at IS
  'When the couple first sees this section. NULL = as soon as it is on. The venue side always sees it.';

-- 2. Soft close ----------------------------------------------------------
ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS portal_changes_close_days integer
    CHECK (portal_changes_close_days IS NULL OR portal_changes_close_days BETWEEN 0 AND 120),
  ADD COLUMN IF NOT EXISTS portal_close_message text;
COMMENT ON COLUMN public.venue_config.portal_changes_close_days IS
  'Couple edits close this many days before the wedding. NULL = never. After the close the couple still sees everything and can message the venue; saves are refused with portal_closed (see enforce_portal_close).';

CREATE OR REPLACE FUNCTION public.portal_is_closed(p_wedding_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.weddings w
      JOIN public.venue_config vc ON vc.venue_id = w.venue_id
     WHERE w.id = p_wedding_id
       AND vc.portal_changes_close_days IS NOT NULL
       AND w.wedding_date IS NOT NULL
       AND (w.wedding_date - vc.portal_changes_close_days) <= CURRENT_DATE
  )
$fn$;
REVOKE ALL ON FUNCTION public.portal_is_closed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.portal_is_closed(uuid) TO authenticated, service_role;

-- Fires only for a signed-in couple (couple_user_wedding_id() is NULL for
-- staff and for the service key). PT423 comes back from PostgREST as 423.
CREATE OR REPLACE FUNCTION public.enforce_portal_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_couple_wedding uuid;
  v_row_wedding uuid;
BEGIN
  IF current_setting('bloom.freeze_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_couple_wedding := public.couple_user_wedding_id();
  IF v_couple_wedding IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_row_wedding := CASE WHEN TG_OP = 'DELETE' THEN OLD.wedding_id ELSE NEW.wedding_id END;
  IF v_row_wedding IS NOT NULL AND public.portal_is_closed(v_row_wedding) THEN
    RAISE EXCEPTION 'portal_closed: changes have closed ahead of the wedding; message the venue and they will make it for you'
      USING ERRCODE = 'PT423', HINT = TG_TABLE_NAME;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$fn$;

DO $do$
DECLARE
  t text;
  -- Things a couple should still be able to do after the close: talk,
  -- read, share photos, answer feedback, tick a section done.
  exempt text[] := ARRAY[
    'messages', 'couple_notifications', 'sage_conversations', 'day_of_media',
    'photo_library', 'inspo_gallery', 'rsvp_responses', 'couple_invites',
    'event_feedback', 'event_feedback_vendors', 'section_finalisations',
    'wedding_website_settings', 'couple_asks', 'venue_notes_to_couple',
    'user_profiles', 'weddings'
  ];
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN pg_tables p ON p.schemaname = 'public' AND p.tablename = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'wedding_id'
       AND c.table_name <> ALL (exempt)
       AND c.table_name NOT LIKE '\_%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_portal_close ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_portal_close BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.enforce_portal_close()', t);
  END LOOP;
END
$do$;

-- 3. Where things stand: what the venue is waiting on -------------------
CREATE TABLE IF NOT EXISTS public.couple_asks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  title text NOT NULL,
  detail text,
  -- Which portal section answers it, so the ask can link there.
  section_key text,
  due_date date,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  done_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_couple_asks_wedding ON public.couple_asks(wedding_id, done_at);
CREATE INDEX IF NOT EXISTS idx_couple_asks_venue ON public.couple_asks(venue_id);
ALTER TABLE public.couple_asks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS couple_asks_staff ON public.couple_asks;
CREATE POLICY couple_asks_staff ON public.couple_asks FOR ALL
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin())
  WITH CHECK (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());
DROP POLICY IF EXISTS couple_asks_couple_read ON public.couple_asks;
CREATE POLICY couple_asks_couple_read ON public.couple_asks FOR SELECT
  USING (wedding_id = public.couple_user_wedding_id());
DROP POLICY IF EXISTS couple_asks_couple_done ON public.couple_asks;
CREATE POLICY couple_asks_couple_done ON public.couple_asks FOR UPDATE
  USING (wedding_id = public.couple_user_wedding_id())
  WITH CHECK (wedding_id = public.couple_user_wedding_id());

-- 4. Notes from the venue, live -----------------------------------------
CREATE TABLE IF NOT EXISTS public.venue_notes_to_couple (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  published boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_venue_notes_to_couple_wedding ON public.venue_notes_to_couple(wedding_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_venue_notes_to_couple_venue ON public.venue_notes_to_couple(venue_id);
ALTER TABLE public.venue_notes_to_couple ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS venue_notes_staff ON public.venue_notes_to_couple;
CREATE POLICY venue_notes_staff ON public.venue_notes_to_couple FOR ALL
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin())
  WITH CHECK (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());
DROP POLICY IF EXISTS venue_notes_couple_read ON public.venue_notes_to_couple;
CREATE POLICY venue_notes_couple_read ON public.venue_notes_to_couple FOR SELECT
  USING (published AND wedding_id = public.couple_user_wedding_id());
DROP TRIGGER IF EXISTS venue_notes_to_couple_touch ON public.venue_notes_to_couple;
CREATE TRIGGER venue_notes_to_couple_touch BEFORE UPDATE ON public.venue_notes_to_couple
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 5. Hide a timeline item from one person -------------------------------
ALTER TABLE public.timeline
  ADD COLUMN IF NOT EXISTS hidden_from uuid[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN public.timeline.hidden_from IS
  'user_profiles ids who must not see this item (a surprise). Restrictive policy timeline_hidden_from enforces it; the service key still sees everything.';
DROP POLICY IF EXISTS timeline_hidden_from ON public.timeline;
CREATE POLICY timeline_hidden_from ON public.timeline AS RESTRICTIVE FOR SELECT
  USING (NOT (auth.uid() = ANY (hidden_from)));
