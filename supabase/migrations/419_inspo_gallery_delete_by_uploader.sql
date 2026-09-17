-- 419_inspo_gallery_delete_by_uploader
--
-- A couple's inspiration board had no notion of who pinned what, so
-- either partner could clear the other's. The Rixey portal restricts a
-- delete to the uploader or the venue; found while verifying the
-- September parity audit, 2026-09-17.
--
-- Two halves, and the client half is the smaller one. `uploaded_by` has
-- existed on this table since migration 004 and was never written, so
-- there was nothing for a policy to check even if one had tried. The
-- couple page now stamps it (see src/app/_couple-pages/inspo/page.tsx).
--
-- The live DELETE policy was `venue_scope_delete`, which allows any
-- authenticated user whose user_profiles.venue_id matches the row. That
-- is right for venue staff and far too broad for a couple: it does not
-- even check the wedding, so a couple user could delete another couple's
-- pin at the same venue given its id, despite not being able to read it.
-- Permissive policies union, so a stricter policy alongside would have
-- changed nothing. This replaces it.
--
-- Legacy rows keep their old behaviour on purpose. All 102 rows in
-- production have uploaded_by NULL, and a policy without the carve-out
-- would strand every one of them with no way for the couple to remove
-- it. Unauthored rows stay deletable by the couple who owns the wedding.
--
-- Prod today has zero user_profiles rows with role='couple', so nothing
-- is currently relying on the loose version. That will stop being true
-- the week the anonymised road test starts, which is why this goes in
-- now.
--
-- Idempotent: DROP ... IF EXISTS then CREATE.

DROP POLICY IF EXISTS "venue_scope_delete" ON public.inspo_gallery;

CREATE POLICY "venue_scope_delete" ON public.inspo_gallery
  FOR DELETE TO authenticated
  USING (
    venue_id = (SELECT user_profiles.venue_id FROM public.user_profiles WHERE user_profiles.id = auth.uid())
    AND (
      -- Venue staff: couple_user_wedding_id() is NULL for them, and the
      -- venue match above is the whole of their scope, as before.
      public.couple_user_wedding_id() IS NULL
      OR (
        -- A couple user: their own wedding, and their own pin (or one
        -- from before authorship was recorded).
        wedding_id = public.couple_user_wedding_id()
        AND (uploaded_by IS NULL OR uploaded_by = auth.uid())
      )
    )
  );

COMMENT ON POLICY "venue_scope_delete" ON public.inspo_gallery IS
  '2026-09-17: was venue-wide for every authenticated user, so one couple could delete another couple''s pin and either partner could delete the other''s. Venue staff keep venue scope; a couple user is held to their own wedding and their own upload. uploaded_by IS NULL is the carve-out for rows saved before authorship was recorded.';

COMMENT ON COLUMN public.inspo_gallery.uploaded_by IS
  'Auth user who pinned the image. NULL for rows saved before 2026-09-17 and in demo mode, where there is no auth user. Read by the delete policy above.';
