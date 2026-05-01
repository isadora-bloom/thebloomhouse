-- Migration 123: Drop weddings.source CHECK constraint (Phase 1 of LIMB-16.2.4-A)
--
-- Per Playbook 16.2.4-A: marketing channels are per-venue, NO hardcoded
-- channel list. Pre-migration weddings.source was locked to a 20-value
-- enum via CHECK constraint (migration 086). Adding 'Local NoVa Bridal
-- Magazine' or any other long-tail channel required:
--   1. Edit normalize-source.ts CANONICAL_SOURCES
--   2. Update ALIAS_TO_CANONICAL
--   3. Write a new migration to drop & recreate the CHECK constraint
--   4. Redeploy
--
-- Direct violation of LIMB-16.2.4-A doctrine.
--
-- Phase 1 (this migration): drop the CHECK so new channels are no longer
-- enum-locked at the DB level. normalize-source.ts continues to provide
-- the recommended canonical mapping; it normalises raw input on write
-- but no longer rejects unknown values.
--
-- Phase 2 (future): introduce a per-venue marketing_channels table with
-- its own admin UI. weddings.source becomes a soft FK to marketing_channels;
-- venues can add their own channels first-class. Per Playbook 16.2.4-A.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS handles re-run.

ALTER TABLE weddings
  DROP CONSTRAINT IF EXISTS weddings_source_check;

COMMENT ON COLUMN weddings.source IS
  'Canonical source key for the inquiry channel. Examples: '
  '''the_knot'', ''wedding_wire'', ''instagram'', ''direct'', '
  '''referral'', ''venue_calculator''. Per Playbook 16.2.4-A this '
  'is NOT enum-locked at the DB level (migration 123 dropped the '
  'CHECK) — venues can add long-tail channels (regional magazines, '
  'bridal expos, etc.) without a code change. normalize-source.ts '
  'provides the recommended canonical mapping for incoming raw '
  'values but does not reject unknown values. Phase 2 will add a '
  'per-venue marketing_channels table.';
