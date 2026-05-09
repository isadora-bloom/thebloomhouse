-- ---------------------------------------------------------------------------
-- 244_auto_attach_photos.sql  (Sage email auto-attach opt-in toggle)
-- ---------------------------------------------------------------------------
-- Pairs with migration 243 (brand_assets.sage_eligible / category / caption /
-- mime_type) and the matchAssetsForEmail service. When the venue flips this
-- toggle on, the email pipeline calls the asset matcher at the send boundary
-- to optionally attach 0-2 venue photos to the outbound reply.
--
-- Default OFF: coordinators must opt in. Even with the column flipped on,
-- the matcher only attaches when at least one brand_assets row is marked
-- sage_eligible AND the AI matcher decides a photo would clearly add value.
-- "Empty list is the right answer most of the time" is enforced at the
-- prompt layer too.
--
-- Surfaced in /settings as a single toggle near other automation toggles
-- (separate from the brand-assets section the migration 243 sibling owns).

ALTER TABLE venue_config
  ADD COLUMN IF NOT EXISTS auto_attach_photos boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN venue_config.auto_attach_photos IS
  'When true, the email-send path runs matchAssetsForEmail before each '
  'outbound reply (autonomous + coordinator-approved). Off by default. '
  'Source: migration 244 / Sage email auto-attach.';
