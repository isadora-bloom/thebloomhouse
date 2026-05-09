-- ---------------------------------------------------------------------------
-- 243_brand_assets_extended.sql  (Brand assets reuse + couple portal exposure)
-- ---------------------------------------------------------------------------
-- User feedback (Isadora, 2026-05-08):
--   "i like the idea of having a place to upload say 10 different photos
--    that sage could use to respond to emails if they fit (like one of
--    ceremony, one of the tent etc) and i think the original purpose was
--    to have a place i could upload watercolour images, floor plans etc
--    that could go on the couples portal so they could download things
--    for their favors, programs etc"
--
-- Today brand_assets exists (migration 024) but is orphaned: only the
-- coordinator Settings page reads/writes it, and the schema is just
-- (asset_type, label, url). No way to teach Sage which photo to attach
-- to which email, no way to expose a sketch to a couple.
--
-- This migration extends the table so a single asset row can power both
-- (a) Sage's email auto-attach matching and (b) the couple portal
-- Resources page download list. One source of truth, two consumers.
--
-- Columns added:
--   caption           — coordinator-written one-liner. Sage matching
--                       reads this when picking a photo for a reply.
--   category          — internal taxonomy distinct from asset_type
--                       (which is media-type). Lets Sage pick a
--                       'ceremony' photo for a ceremony-question email.
--   couple_facing     — whether the asset shows on the couple portal.
--   couple_category   — categorization shown to couples (favors,
--                       programs, decor, planning, other).
--   sage_eligible     — whether Sage may auto-attach this in emails.
--                       Defaults off so we never accidentally send a
--                       blueprint or contract draft to a prospect.
--   file_size_bytes
--   mime_type         — populated when the asset is uploaded via the
--                       new file-upload path. NULL on legacy URL-paste
--                       rows so the UI can render "external image" badges.
--
-- Idempotent — every ALTER guarded with IF NOT EXISTS. Multi-venue safe;
-- the venue_id FK is unchanged.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- STEP 1 — column additions
-- ---------------------------------------------------------------------------

ALTER TABLE public.brand_assets
  ADD COLUMN IF NOT EXISTS caption text,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS couple_facing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS couple_category text,
  ADD COLUMN IF NOT EXISTS sage_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS file_size_bytes integer,
  ADD COLUMN IF NOT EXISTS mime_type text;

COMMENT ON COLUMN public.brand_assets.caption IS
  'Coordinator-written one-liner describing what is shown. Used by Sage matching.';
COMMENT ON COLUMN public.brand_assets.category IS
  'Internal taxonomy for Sage matching (ceremony / tent / reception / detail / aerial / venue_exterior / staff / other). Distinct from asset_type which is media-type.';
COMMENT ON COLUMN public.brand_assets.couple_facing IS
  'Whether this asset shows up on the couple portal Resources page.';
COMMENT ON COLUMN public.brand_assets.couple_category IS
  'Categorization shown to couples (favors / programs / decor / planning / other).';
COMMENT ON COLUMN public.brand_assets.sage_eligible IS
  'Whether Sage can pick this asset for email auto-attach.';
COMMENT ON COLUMN public.brand_assets.file_size_bytes IS
  'Bytes — populated when uploaded via the new file-upload path; NULL for URL-only legacy rows.';
COMMENT ON COLUMN public.brand_assets.mime_type IS
  'MIME — populated when uploaded via the new file-upload path; NULL for URL-only legacy rows.';

-- ---------------------------------------------------------------------------
-- STEP 2 — CHECK constraints (allow NULL on both)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brand_assets_category_check'
  ) THEN
    ALTER TABLE public.brand_assets
      ADD CONSTRAINT brand_assets_category_check
      CHECK (category IS NULL OR category IN (
        'ceremony', 'tent', 'reception', 'detail',
        'aerial', 'venue_exterior', 'staff', 'other'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brand_assets_couple_category_check'
  ) THEN
    ALTER TABLE public.brand_assets
      ADD CONSTRAINT brand_assets_couple_category_check
      CHECK (couple_category IS NULL OR couple_category IN (
        'favors', 'programs', 'decor', 'planning', 'other'
      ));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- STEP 3 — indexes
-- ---------------------------------------------------------------------------
-- Couple portal Resources query: WHERE venue_id = $1 AND couple_facing = true.
-- Sage auto-attach query:        WHERE venue_id = $1 AND sage_eligible = true.
-- Two narrow composite indexes keep both fast as the table grows.

CREATE INDEX IF NOT EXISTS idx_brand_assets_venue_couple_facing
  ON public.brand_assets (venue_id, couple_facing)
  WHERE couple_facing = true;

CREATE INDEX IF NOT EXISTS idx_brand_assets_venue_sage_eligible
  ON public.brand_assets (venue_id, sage_eligible)
  WHERE sage_eligible = true;

-- ---------------------------------------------------------------------------
-- STEP 4 — couple portal RLS read policy
-- ---------------------------------------------------------------------------
-- Couple users (people.user_id = auth.uid()) can SELECT brand_assets
-- flagged couple_facing for their venue. Coordinator/super_admin keep
-- their existing wider policies from migration 024.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'brand_assets'
      AND policyname = 'couple_read_brand_assets'
  ) THEN
    DROP POLICY "couple_read_brand_assets" ON public.brand_assets;
  END IF;
END $$;

CREATE POLICY "couple_read_brand_assets" ON public.brand_assets
  FOR SELECT
  TO authenticated
  USING (
    couple_facing = true
    AND venue_id IN (
      SELECT w.venue_id FROM public.weddings w
      JOIN public.people p ON p.wedding_id = w.id
      WHERE p.user_id = auth.uid()
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
