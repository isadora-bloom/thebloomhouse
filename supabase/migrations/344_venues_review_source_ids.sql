-- ---------------------------------------------------------------------------
-- 344_venues_review_source_ids.sql
-- ---------------------------------------------------------------------------
-- TIER 7e (2026-05-14). Adds the per-source external identifiers needed
-- to pull reviews from the platforms that have any kind of public
-- accessor:
--
--   google_place_id    — Google Places Details API (free, returns up to
--                        5 most-recent / most-relevant reviews per call).
--                        This is the only source with a true public API
--                        for reviews. Operator looks up the venue's Place
--                        ID via the Place ID Finder tool and pastes it in.
--   the_knot_url       — best-effort scraping target. Stored so the
--                        future scraper has a home. Documented as scrape-
--                        risk; default ingestion remains paste.
--   wedding_wire_url   — same as above.
--   zola_url           — same.
--   yelp_business_id   — Yelp Fusion API can fetch up to 3 review excerpts
--                        per business but the full review text requires a
--                        deeper Yelp agreement. Stored for the future
--                        ingestion path.
--   facebook_page_id   — Graph API can return reviews if the venue's
--                        Page has been linked to a Bloom app — out of
--                        scope here, but the column reserves the slot.
--
-- All columns nullable. The Google Places cron skips any venue with no
-- google_place_id set, so this migration is non-breaking.

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS google_place_id text,
  ADD COLUMN IF NOT EXISTS the_knot_url text,
  ADD COLUMN IF NOT EXISTS wedding_wire_url text,
  ADD COLUMN IF NOT EXISTS zola_url text,
  ADD COLUMN IF NOT EXISTS yelp_business_id text,
  ADD COLUMN IF NOT EXISTS facebook_page_id text;

COMMENT ON COLUMN public.venues.google_place_id IS
  'Google Place ID for review polling via Places Details API. Set in '
  'venue settings; cron weather_history_refresh of reviews uses this. '
  'TIER 7e (2026-05-14).';
