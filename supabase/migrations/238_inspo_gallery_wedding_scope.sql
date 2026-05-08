-- ============================================================================
-- 238_inspo_gallery_wedding_scope.sql
-- 2026-05-08. Privacy bug fix: inspo_gallery was cross-couple visible.
--
-- Bug: mig 226 line 218-221 set the couple_read policy on inspo_gallery
-- to filter by venue_id (assuming venue-curated content). But the only
-- writer is the couple-side /couple/[slug]/inspo page (couples upload
-- their own inspiration), and the read showed ALL inspo at the venue.
-- Result: every couple at a venue saw every other couple's inspiration
-- uploads.
--
-- Fix: tighten couple_read to wedding-scoped only. Since there is no
-- venue-side admin upload path today, every row carries wedding_id, so
-- a strict wedding-scoped policy correctly silos each couple's
-- inspiration board.
--
-- If a future venue-side admin upload path lands (with wedding_id=NULL
-- meaning "venue-curated, all couples"), this policy needs the
-- `OR wedding_id IS NULL` carve-out. Documented inline.
-- ============================================================================

DROP POLICY IF EXISTS "couple_read" ON public.inspo_gallery;
CREATE POLICY "couple_read" ON public.inspo_gallery
  FOR SELECT TO authenticated
  USING (wedding_id = public.couple_user_wedding_id());

COMMENT ON POLICY "couple_read" ON public.inspo_gallery IS
  '2026-05-08 fix: wedding-scoped not venue-scoped. Each couple sees only their own inspiration uploads. If venue-curated upload path lands later (wedding_id=NULL signals shared), extend with OR wedding_id IS NULL.';
