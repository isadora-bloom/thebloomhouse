-- ---------------------------------------------------------------------------
-- 194_people_alias_emails.sql  (T5-Rixey-EEE: Bug 1 — Sarah×Sarah×Sarah)
-- ---------------------------------------------------------------------------
-- Background — see audits/2026-05-T5-rixey-eee/people-merge-aliases.md.
--
-- Stream KK (migration 177) reconciles WEDDINGS — duplicate weddings
-- that share an email get merged into a single canonical wedding via
-- weddings.merged_into_id. KK does NOT collapse PEOPLE rows within a
-- single wedding, so when one human appears under multiple email
-- addresses (Knot proxy + real Gmail; Knot proxy + WW proxy + real
-- Gmail), each address creates a fresh `people` row attached to the
-- same wedding.
--
-- Outcome on the live site: lead-detail headlines render
-- "Sarah & Sarah & Sarah" because there are three people rows, each
-- contributing a "first_name" to the join. Hit Sarah Rohrschneider's
-- wedding (RM-0027) on 2026-05-02:
--
--   1. Sarah Rohrschneider (partner1) — sarah.rohrschneider.1.772357@member.theknot.com
--   2. Sarah Rohrschneider (partner1) — s.rohrschneider@gmail.com
--   3. Sarah Olkowski        (partner2) — olkowskiee1@gmail.com
--
-- Rows 1 and 2 are the same human. Row 1's address is The Knot's
-- proxy alias (member.theknot.com), Row 2 is her real Gmail. When she
-- replied to a Knot inquiry from her own address, the email-pipeline
-- created a fresh `people` row instead of appending the address to
-- the existing one — because we have no notion of an alias.
--
-- Root fix (this migration): add `people.alias_emails text[]` so the
-- canonical row carries the proxy/aliased addresses as a non-canonical
-- attribute. The merge service (people-merge-aliases.ts) detects
-- candidate aliases by name + alias-domain pattern and collapses them.
--
-- Conservative gate, per the constitution forensic rule: the alias
-- merge ONLY fires when name+name+alias-pattern align. Anything
-- ambiguous queues for coordinator review (the existing
-- /onboarding/identity-reconciliation Tier 2 surface). Two real
-- different people are MUCH worse to merge than to leave dup'd.
--
-- Migration is idempotent — `ADD COLUMN IF NOT EXISTS` + a separate
-- index. Backfill of the canonical alias_emails values happens in the
-- service code (people-merge-aliases.ts mergePeopleAliasesForVenue),
-- not in this SQL — that way the merge logic is unit-testable and
-- the DB stays untouched until a coordinator runs the cron.
-- ---------------------------------------------------------------------------

BEGIN;

-- alias_emails: the secondary addresses this canonical person has been
-- contacted under. We keep them as a denormalised array on the people
-- row so the email-pipeline can match incoming mail (Knot proxy
-- replies the human never sees) to the canonical person via a single
-- index lookup, rather than walking a separate aliases table.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'people'
      AND column_name = 'alias_emails'
  ) THEN
    ALTER TABLE public.people
      ADD COLUMN alias_emails text[] NOT NULL DEFAULT '{}';
  END IF;
END $$;

COMMENT ON COLUMN public.people.alias_emails IS
  'EEE (2026-05-02). Secondary email addresses for this person, captured during the alias-merge collapse (people-merge-aliases.ts). Populated when a duplicate `people` row with a known platform-alias address (member.theknot.com / notifications.honeybook.com / etc.) is folded into the canonical row holding the real address. Empty array on rows that have not been merge-processed.';

-- GIN index so an inbound email like "sarah.rohrschneider.1.772357@member.theknot.com"
-- can hit the canonical Sarah row in O(log n) on a per-venue email-
-- pipeline lookup. Partial index on non-empty arrays keeps the index
-- size proportional to the merged-row population, not total people.

CREATE INDEX IF NOT EXISTS idx_people_alias_emails_gin
  ON public.people USING GIN (alias_emails)
  WHERE array_length(alias_emails, 1) > 0;

COMMIT;
