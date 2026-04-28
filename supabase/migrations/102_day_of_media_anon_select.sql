-- ---------------------------------------------------------------------------
-- 102_day_of_media_anon_select.sql
-- ---------------------------------------------------------------------------
-- Couple-side validation pass on the rixey-port batch (097-100)
-- caught a real RLS gap: the couple's day-of-memories page reads
-- day_of_media via the anon supabase client (couples authenticate
-- via slug + wedding_id from their URL, not a user_profiles row that
-- auth.uid() could match against). Migration 097 added only
-- authenticated venue_isolation, so couples 403 when listing their
-- own photos in production. Storage-side policies are already
-- correct — both authenticated and anon SELECT on the
-- 'day-of-media' bucket. The fix is a matching anon SELECT on the
-- table.
--
-- Pattern matches photo_library / inspo_gallery / borrow_catalog
-- etc. (see migration 028) — those couple-readable tables all have
-- anon SELECT policies because the couple-portal routes use the
-- anon client. We do NOT add anon INSERT/UPDATE/DELETE: only
-- coordinators upload day-of media; couples are read-only.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "anon_select_day_of_media" ON public.day_of_media;
CREATE POLICY "anon_select_day_of_media" ON public.day_of_media
  FOR SELECT TO anon USING (true);

NOTIFY pgrst, 'reload schema';
