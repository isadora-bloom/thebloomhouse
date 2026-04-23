-- Migration 086: normalize weddings.source + widen CHECK to canonical enum.
--
-- The old CHECK (migration 001) allowed only eight values:
--   the_knot, weddingwire, google, instagram, referral, website, walk_in, other
--
-- Real writers emit many more:
--   'direct' (email-pipeline fallback)
--   'wedding_wire' (form-relay-parsers — differs from CHECK's 'weddingwire')
--   'here_comes_the_guide', 'zola', 'venue_calculator' (form-relay-parsers)
--   'theknot' (onboarding seed typo)
--   'csv_import', arbitrary snake_cased strings (brain-dump imports)
--   free-form AI-emitted strings (classifier extractedData.source)
--
-- Result: inserts failed the CHECK, three of four e2e scenarios couldn't
-- progress past wedding creation.
--
-- This migration:
--   1. Normalizes existing data to canonical form (wedding_wire → weddingwire,
--      theknot → the_knot, free-form → 'other' catch-all).
--   2. Drops the old CHECK.
--   3. Adds a new CHECK with the full canonical list. The canonical list
--      MUST match CANONICAL_SOURCES in src/lib/services/normalize-source.ts.
--
-- Same treatment is applied to wedding_touchpoints.source (no existing
-- CHECK but writers go through the same normalizer now) and to
-- auto_send_rules.source (also unconstrained, but onboarding seeds it with
-- 'theknot' which never matches incoming 'the_knot' — updated inline).
--
-- Probe directives for scripts/apply-migrations.mjs:
-- @probe: insert_accepts weddings.source=zola
-- @probe: insert_accepts weddings.source=venue_calculator
-- @probe: insert_accepts weddings.source=direct

BEGIN;

-- 0. Drop the old narrow CHECK BEFORE normalizing. The UPDATEs below move
-- rows from one allowed value to another (e.g. 'weddingwire' -> 'wedding_wire')
-- which the old CHECK would reject mid-flight. The new CHECK is added after
-- all data is canonical.
ALTER TABLE weddings DROP CONSTRAINT IF EXISTS weddings_source_check;

-- 1. Normalize existing weddings.source data.
UPDATE weddings SET source = 'the_knot'
  WHERE lower(source) IN ('theknot', 'the knot', 'the-knot', 'knot', 'the_knot_com');

UPDATE weddings SET source = 'wedding_wire'
  WHERE lower(source) IN ('weddingwire', 'wedding wire', 'ww', 'weddingwire_com');

UPDATE weddings SET source = 'here_comes_the_guide'
  WHERE lower(source) IN ('here comes the guide', 'here-comes-the-guide', 'hctg', 'herecomestheguide');

UPDATE weddings SET source = 'venue_calculator'
  WHERE lower(source) IN ('calculator', 'pricing_calculator', 'interactive_calculator', 'pricing calculator');

UPDATE weddings SET source = 'google'
  WHERE lower(source) IN ('google_search', 'google search', 'google_analytics');

UPDATE weddings SET source = 'google_ads'
  WHERE lower(source) IN ('googleads', 'adwords', 'google ads');

UPDATE weddings SET source = 'google_business'
  WHERE lower(source) IN ('google_my_business', 'gmb', 'google my business');

UPDATE weddings SET source = 'instagram'
  WHERE lower(source) IN ('ig', 'insta');

UPDATE weddings SET source = 'facebook'
  WHERE lower(source) IN ('fb', 'meta');

UPDATE weddings SET source = 'direct'
  WHERE lower(source) IN ('direct_email', 'email', 'phone', 'call', 'direct email');

UPDATE weddings SET source = 'vendor_referral'
  WHERE lower(source) IN ('vendor', 'vendor referral', 'vendor-referral');

UPDATE weddings SET source = 'walk_in'
  WHERE lower(source) IN ('walkin', 'walk in', 'walk-in');

UPDATE weddings SET source = 'csv_import'
  WHERE lower(source) IN ('csv', 'import', 'manual', 'bulk_import');

-- 2. Anything still not canonical becomes 'other' — last-resort catch so
-- the CHECK can be applied cleanly. Better than losing the rows.
UPDATE weddings SET source = 'other'
  WHERE source IS NOT NULL
    AND source NOT IN (
      'the_knot', 'wedding_wire', 'here_comes_the_guide', 'zola', 'honeybook',
      'google', 'google_ads', 'google_business',
      'instagram', 'facebook', 'pinterest', 'tiktok',
      'venue_calculator', 'website', 'direct', 'referral',
      'walk_in', 'csv_import', 'vendor_referral', 'other'
    );

-- 3. Add the canonical CHECK now that every row matches the new enum.
ALTER TABLE weddings ADD CONSTRAINT weddings_source_check CHECK (
  source IS NULL OR source IN (
    'the_knot', 'wedding_wire', 'here_comes_the_guide', 'zola', 'honeybook',
    'google', 'google_ads', 'google_business',
    'instagram', 'facebook', 'pinterest', 'tiktok',
    'venue_calculator', 'website', 'direct', 'referral',
    'walk_in', 'csv_import', 'vendor_referral', 'other'
  )
);

-- 4. Normalize auto_send_rules.source. Onboarding seed used 'theknot' which
-- never matched incoming 'the_knot' — auto-send rules silently never fired.
UPDATE auto_send_rules SET source = 'the_knot'
  WHERE lower(source) IN ('theknot', 'the knot', 'knot');

UPDATE auto_send_rules SET source = 'wedding_wire'
  WHERE lower(source) IN ('weddingwire', 'wedding wire', 'ww');

UPDATE auto_send_rules SET source = 'venue_calculator'
  WHERE lower(source) IN ('calculator', 'pricing_calculator');

-- 5. wedding_touchpoints.source has no CHECK but same write-path drift.
-- Normalize existing rows so intel charts group consistently.
UPDATE wedding_touchpoints SET source = 'the_knot'
  WHERE lower(source) IN ('theknot', 'knot');
UPDATE wedding_touchpoints SET source = 'wedding_wire'
  WHERE lower(source) IN ('weddingwire', 'ww');
UPDATE wedding_touchpoints SET source = 'venue_calculator'
  WHERE lower(source) IN ('calculator', 'pricing_calculator');

COMMIT;

NOTIFY pgrst, 'reload schema';
