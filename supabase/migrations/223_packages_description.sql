-- ============================================================================
-- 223: PACKAGES (couple-facing description)
--
-- Tier-B audit #54 (Package contents per couple). The packages catalog
-- table (mig 178) tracks name + price_cents + season metadata, but has
-- no field for "what's actually included in this package": the prose
-- a coordinator would write to a couple to remind them what they booked.
--
-- Distinction from existing fields:
--   - `name`        = short tier label ("Spring", "Premium", "All-Inclusive")
--   - `notes`       = INTERNAL coordinator notes (not couple-facing)
--   - `source_text` = provenance trace ("from form column X")
--   - `description` = COUPLE-FACING prose listing what's included.
--                     Surfaced on the couple dashboard package card and
--                     /booking page. Free text; multi-paragraph okay.
--
-- Nullable; venues that haven't filled this in render the card as
-- name-only ("You booked: Spring Package") with a note that the details
-- live in their contract. No backfill.
-- ============================================================================

ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN public.packages.description IS
  'Couple-facing prose describing what is included in this package / upgrade / discount / fee. Multi-paragraph free text. Distinct from `notes` (internal coordinator notes) and `source_text` (provenance trace). Surfaced on the couple dashboard package card and /booking page. Nullable; venues without a description render the card as name-only.';

NOTIFY pgrst, 'reload schema';
