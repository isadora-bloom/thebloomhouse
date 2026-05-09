-- ---------------------------------------------------------------------------
-- 247_identity_merge_columns.sql
-- ---------------------------------------------------------------------------
-- Identity-resolver soft-merge tombstones for `people`.
--
-- Why this exists
-- ---------------
-- The Reem Ibrahim case (2026-05-08) surfaced the fact that we had three
-- entry paths (Knot relay email, calculator submission, contract-request)
-- each minting an independent `weddings` + `people` row for the same
-- couple. The new src/lib/services/identity/resolver.ts is the single
-- chokepoint that every entry path now goes through; when it discovers
-- that a candidate identity matches an existing person it merges them
-- via mergeWeddings() in the same module.
--
-- `weddings.merged_into_id` already exists (migration 177). This file
-- adds the symmetric column on `people` plus the supporting indexes so
-- the resolver can soft-tombstone duplicate person rows without losing
-- the FK chain.
--
-- Constitution invariant: a row with merged_into_id IS NOT NULL is a
-- tombstone. Active queries filter `merged_into_id IS NULL`. Readers
-- that hit a tombstone follow the pointer (resolveCanonical helper in
-- the resolver). Hard-deletes are never used; the audit trail must
-- stay intact.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — people.merged_into_id soft-merge pointer
-- ============================================================================

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS merged_into_id uuid
    REFERENCES public.people(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.people.merged_into_id IS
  'Identity-resolver loser → winner pointer (Reem-bug fix, migration 247). '
  'NULL = active row. NOT NULL = duplicate person consolidated into the '
  'referenced canonical row. Forensic record preserved per Constitution; '
  'the resolver soft-tombstones rather than hard-deletes so any stragglers '
  'pointing at this id (interactions, contacts, engagement_events, etc.) '
  'still resolve cleanly via resolveCanonical(). Set by '
  'src/lib/services/identity/resolver.ts.';

-- ============================================================================
-- STEP 2 — also re-assert the weddings.merged_into_id index on a partial
-- ============================================================================
-- Migration 177 already created idx_weddings_merged_into. This block stays
-- idempotent so the file can re-run without surprises.

CREATE INDEX IF NOT EXISTS idx_weddings_merged_into
  ON public.weddings (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_people_merged_into
  ON public.people (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

COMMENT ON INDEX public.idx_people_merged_into IS
  'Reverse-pointer lookup: given a canonical person, find every tombstone '
  'that points at it. Used by /admin/identity audit + the resolveCanonical '
  'helper that walks chains of merges. Migration 247.';

-- ============================================================================
-- STEP 3 — partial active-set index on people
-- ============================================================================
-- Mirrors idx_weddings_active. Every coordinator surface that lists people
-- (leads page, inbox sender column, /intel/matching) filters tombstones.

CREATE INDEX IF NOT EXISTS idx_people_active_venue
  ON public.people (venue_id, merged_into_id)
  WHERE merged_into_id IS NULL;

COMMENT ON INDEX public.idx_people_active_venue IS
  'Active-set partial index for people. Coordinator surfaces filter on '
  '(venue_id, merged_into_id IS NULL). Migration 247.';

-- ============================================================================
-- STEP 4 — extend weddings.source_provenance enum for resolver-created rows
-- ============================================================================
-- The new resolver creates wedding rows from non-pipeline entry points
-- (calculator submission, calendly form, brain-dump client_note). Migration
-- 178 capped source_provenance at a fixed enum; we add 'identity_resolver'
-- so downstream filters can distinguish the resolver path from a
-- pipeline-or-import write.

ALTER TABLE public.weddings
  DROP CONSTRAINT IF EXISTS weddings_source_provenance_check;

ALTER TABLE public.weddings
  ADD CONSTRAINT weddings_source_provenance_check
    CHECK (source_provenance IS NULL OR source_provenance IN (
      'pipeline',
      'crm_import',
      'web_form_import',
      'brain_dump',
      'manual_form',
      'manual_csv',
      'identity_resolution_merge',
      'identity_resolver'
    ));

NOTIFY pgrst, 'reload schema';
