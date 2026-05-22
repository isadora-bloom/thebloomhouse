-- ---------------------------------------------------------------------------
-- 367_people_partner_role_unique.sql
-- ---------------------------------------------------------------------------
-- Phase 1 / Batch 1 / prerequisite P2 — GAP B (PHASE-1-BATCH-1.md §2 P2,
-- CASCADE-CANONICAL-WRITER.md §3.2).
--
-- Confirmed gap (the TOCTOU race)
-- -------------------------------
-- `enrichExistingPartner2` (resolver.ts) is a query-then-insert dedup with
-- NO atomicity, and the `people` table has NO unique constraint on
-- (venue_id, wedding_id, role) — verified: 001_shared_tables.sql ships only
-- a NON-unique `idx_people_wedding_id`, and no later migration adds one.
-- Two concurrent inbound emails for the same wedding, both carrying a
-- partner2, can both see "no existing partner2" and both INSERT. The
-- TypeScript check is optimistic; nothing at the DB level enforces the
-- invariant. P2's GAP A fix makes the FIRST partner2 mint correctly
-- stamped, but only a DB constraint closes the concurrency window.
--
-- What this migration does
-- ------------------------
-- Creates a PARTIAL UNIQUE INDEX enforcing "at most one live person per
-- (venue, wedding, role)" — but ONLY for the two partner roles.
--
-- WHY the WHERE clause is scoped to role IN ('partner1','partner2'):
-- the `people.role` CHECK constraint (migration 241) admits
--   'partner1', 'partner2', 'guest', 'wedding_party', 'vendor',
--   'family', 'parent'
-- A blanket unique on (venue_id, wedding_id, role) would WRONGLY forbid a
-- wedding from having more than one guest / wedding_party member / vendor /
-- family member / parent — all of which are legitimately many-per-wedding.
-- Only partner1 and partner2 are one-per-wedding-per-role. The partial
-- predicate confines the constraint to exactly those.
--
-- `merged_into_id IS NULL` excludes tombstoned (merged-away) rows: a row
-- that was merged into another must not block a fresh mint of the same
-- role, and a historical merge must not retroactively violate the index.
--
-- ===========================================================================
-- PRE-EXISTING DUPLICATE HANDLING — READ THIS BEFORE APPLYING
-- ===========================================================================
-- A `CREATE UNIQUE INDEX` FAILS outright if the table already contains rows
-- that violate the uniqueness predicate. `CREATE INDEX CONCURRENTLY` cannot
-- be used here — it is not transaction-safe and a migration runs inside a
-- transaction.
--
-- Chosen approach: FAIL LOUD, ON PURPOSE — and tell the operator exactly
-- which weddings are duplicated.
--
-- We deliberately do NOT auto-dedup. Auto-merging partner rows is a
-- destructive, identity-affecting operation that belongs to the audited
-- `mergeWeddings` / merge-people cascade, NOT to a schema migration that
-- has no provenance trail and no coordinator review. If pre-existing
-- partner-role duplicates exist, that is a real data-integrity defect that
-- MUST be surfaced and resolved through the merge cascade first.
--
-- So: the DO block below scans for offending (venue_id, wedding_id, role)
-- groups and, if any are found, RAISES EXCEPTION with their ids. The
-- migration aborts with an actionable message instead of dying on an
-- opaque "could not create unique index" error. A clean database sails
-- straight past it and creates the index.
--
-- Operator remediation if this aborts:
--   1. Inspect the (venue_id, wedding_id, role) groups named in the error.
--   2. Resolve each through the merge cascade (merge-people / mergeWeddings)
--      so the surviving row is canonical and the rest carry merged_into_id.
--   3. Re-run this migration.
-- ===========================================================================

DO $$
DECLARE
  dup_count integer;
  dup_detail text;
BEGIN
  SELECT count(*), string_agg(
           format('venue=%s wedding=%s role=%s count=%s',
                  venue_id, wedding_id, role, n),
           ' | ')
    INTO dup_count, dup_detail
  FROM (
    SELECT venue_id, wedding_id, role, count(*) AS n
    FROM public.people
    WHERE merged_into_id IS NULL
      AND role IN ('partner1', 'partner2')
      AND wedding_id IS NOT NULL
    GROUP BY venue_id, wedding_id, role
    HAVING count(*) > 1
  ) dups;

  IF dup_count IS NOT NULL AND dup_count > 0 THEN
    RAISE EXCEPTION
      'Migration 367 aborted: % (venue_id, wedding_id, role) group(s) '
      'already violate the one-partner-per-role invariant. Resolve these '
      'through the merge cascade (merged_into_id) before applying. '
      'Offending groups: %',
      dup_count, dup_detail;
  END IF;
END $$;

-- Partial unique index — the DB-level guard for the partner2 dedup
-- invariant. Once this is live, the TOCTOU race in enrichExistingPartner2
-- can no longer mint a duplicate partner row: the loser of a concurrent
-- INSERT race fails with a unique-violation, which the caller handles as
-- "already exists" rather than silently double-writing.
--
-- NOTE: `wedding_id IS NOT NULL` is implied for any row that satisfies the
-- index (a NULL column value is never "equal" for unique purposes), but we
-- state it explicitly in the predicate so the index is not bloated with
-- the many wedding_id-NULL person rows that legitimately exist (orphan
-- people, person-only resolves from the SMS pre-classification path).
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_partner_role_unique
  ON public.people (venue_id, wedding_id, role)
  WHERE merged_into_id IS NULL
    AND wedding_id IS NOT NULL
    AND role IN ('partner1', 'partner2');

COMMENT ON INDEX public.idx_people_partner_role_unique IS
  'P2 GAP B (2026-05-22): enforces at most one live person per '
  '(venue_id, wedding_id, role) for role partner1/partner2 only — the '
  'DB-level guard closing the enrichExistingPartner2 query-then-insert '
  'TOCTOU race. Scoped to partner roles because guest/wedding_party/'
  'vendor/family/parent are legitimately many-per-wedding. Excludes '
  'tombstoned (merged_into_id NOT NULL) rows.';
