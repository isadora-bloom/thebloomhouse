-- 388: make the website builder actually persist
--
-- The builder (website/page.tsx) saves by spreading its whole settings object
-- into an upsert. Its fields include partner1_name, partner2_name, venue_name,
-- venue_address, wedding_date and sections — none of which were columns on
-- wedding_website_settings. PostgREST rejected every upsert (unknown column) and
-- writeOrLog swallowed the error, so the builder silently saved nothing for real
-- couples. Add the missing columns so the builder's existing model persists.
--
-- Note on slug: the builder's `url_slug` is NOT added as a column. The public
-- site is looked up by `slug` (getPublishedWebsite), so a second slug column
-- would disconnect the builder from the live site. The builder code maps
-- url_slug <-> the existing slug column instead.
--
-- wedding_date is text here (not date): the builder binds it to a string input
-- and can submit ''; a date column would reject the empty string. The canonical
-- date still lives on weddings.wedding_date — this is a denormalised display copy.

ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS partner1_name text;
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS partner2_name text;
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS venue_name text;
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS venue_address text;
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS wedding_date text;
ALTER TABLE wedding_website_settings ADD COLUMN IF NOT EXISTS sections jsonb DEFAULT '[]'::jsonb;
