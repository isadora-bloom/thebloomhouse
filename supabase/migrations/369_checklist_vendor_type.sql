-- ============================================================================
-- 369: CHECKLIST_ITEMS (vendor_type)
--
-- R1#2 feedback (2026-03-29). The original couple-portal review asked for
-- each checklist item to be able to link to a vendor category, so that
-- clicking "Book photographer" jumps the couple to their Photographer
-- card in the Vendors section.
--
-- Free-text rather than an enum or FK because:
--   1. The Vendors page's preset list (photographer, videographer,
--      caterer, florist, dj, band, officiant, cake, hair, makeup,
--      coordinator, rentals, transportation) is itself shaped as a
--      const array in TypeScript today, not a DB table. A check
--      constraint would couple this column to a list that gets edited
--      in code.
--   2. R2#1 will let couples add custom vendor categories. A free-text
--      column accommodates "florist (boutonnières)" without needing
--      another migration.
--   3. Null means "no vendor link" — the most common case.
--
-- Renderer treats the value as a key into the Vendors page (deep-link
-- via `?vendor=<vendor_type>`). Unknown values silently degrade to no
-- link.
-- ============================================================================

ALTER TABLE public.checklist_items
  ADD COLUMN IF NOT EXISTS vendor_type text;

COMMENT ON COLUMN public.checklist_items.vendor_type IS
  'Optional vendor category this task relates to. Matches the keys used by the Vendors page (e.g. "photographer", "florist"). Nullable. Used to deep-link the checklist row into the Vendors section.';

NOTIFY pgrst, 'reload schema';
