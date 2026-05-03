-- ---------------------------------------------------------------------------
-- 188_on_conflict_index_fixes.sql  (T5-Rixey-XX)
-- ---------------------------------------------------------------------------
-- Stream RR's CI guard (scripts/check-on-conflict-constraints.mjs) flagged
-- 9 EXISTING ON CONFLICT / unique-constraint mismatches besides the
-- source_attribution one Stream NN closed in migration 180. Each is the
-- same bug class: a `.upsert({ ..., onConflict: '<cols>' })` writer with
-- no matching unique index, so PostgREST returns
--   "no unique or exclusion constraint matching the ON CONFLICT spec"
-- (or — worse — silently no-ops on rows containing NULL in the named
--  columns when a partial / functional index exists).
--
-- This migration closes the four schema gaps. The remaining five sites
-- are caller-side fixes (wedding_config x3 + fred_indicators x1 + dead
-- code removal) handled in the same commit.
--
-- Idempotent: every CREATE UNIQUE INDEX uses IF NOT EXISTS.
--
-- Per-table rationale below.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- bar_planning — couple-portal bar planner notes (one row per wedding).
-- Writer: src/app/_couple-pages/bar/page.tsx upserts a single
-- {venue_id, wedding_id, guest_count, event_duration_hours,
--  notes_calculator, notes_list, notes_recipes} blob; reader uses
-- .eq('wedding_id', X).maybeSingle(). Schema in migration 009.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_bar_planning_wedding_id
  ON public.bar_planning (wedding_id);

COMMENT ON INDEX public.uq_bar_planning_wedding_id IS
  'One row per wedding. Matches ON CONFLICT in couple-portal bar planner '
  '(src/app/_couple-pages/bar/page.tsx). Per T5-Rixey-XX / RR finding.';

-- ---------------------------------------------------------------------------
-- timeline — DEFERRED. Demo data has duplicate wedding_id rows
-- (ab000000-...001 has 13 rows; 44444444-...0109 has 7) because the
-- table is used in TWO modes by different surfaces:
--   1. couple-portal timeline writer: one row per wedding with
--      config_json blob (via ON CONFLICT(wedding_id))
--   2. portal/weddings/[id] reader: per-event rows with
--      time/title/sort_order
-- Adding UNIQUE(wedding_id) breaks mode 2. Out of scope for XX.
-- The mixed-schema cleanup is its own stream — until then the writer's
-- ON CONFLICT silent-no-ops on dup rows; flagged in CI guard skip list.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- wedding_website_settings — couple-portal wedding-website settings
-- (one row per wedding).
-- Writer: src/app/_couple-pages/website/page.tsx upserts a single
-- settings blob keyed by wedding_id; reader at api/public/wedding-website
-- uses .maybeSingle(). Schema in migration 009 has UNIQUE on slug only.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_wedding_website_settings_wedding_id
  ON public.wedding_website_settings (wedding_id);

COMMENT ON INDEX public.uq_wedding_website_settings_wedding_id IS
  'One row per wedding. Matches ON CONFLICT in couple-portal website '
  'editor (src/app/_couple-pages/website/page.tsx). Per T5-Rixey-XX / '
  'RR finding.';

-- ---------------------------------------------------------------------------
-- packages — venue catalog of packages / upgrades / discounts / fees.
-- Writer: src/app/api/onboarding/extract-packages/route.ts confirms
-- proposed rows by upserting on
-- (venue_id, kind, name, season, guest_count_min, guest_count_max).
-- Schema in migration 178 declares
--   UNIQUE (venue_id, kind, name, season, guest_count_min, guest_count_max)
-- HOWEVER three of those columns (season, guest_count_min, guest_count_max)
-- are nullable, and PostgreSQL's default unique semantics treat NULL
-- as not-equal — so two rows with NULL season would NOT collide AND
-- the ON CONFLICT path would silently no-op (insert a duplicate that
-- bypasses the index). The migration's own comment promised "the
-- COALESCE-based partial index below" but never created it.
--
-- Fix: replace with an explicit NULLS NOT DISTINCT unique index so
-- coordinator re-running confirm doesn't double-insert when any of the
-- guest-band / season fields are NULL. Postgres 15+ supports this
-- syntax natively (Supabase is on PG 15+).
--
-- We additionally drop the inline UNIQUE constraint added in migration
-- 178 because it has the wrong NULL semantics for this writer. The
-- ALTER is inside DO so it stays idempotent (constraint name is
-- auto-generated; we look it up).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  con_name text;
BEGIN
  -- Drop the legacy NULLS-DISTINCT inline constraint if present.
  -- Inline UNIQUE in CREATE TABLE generates a constraint named
  -- 'packages_venue_id_kind_name_season_guest_count_min_guest_count_max_key'
  -- (Postgres truncates to 63 chars).
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.packages'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) LIKE
      'UNIQUE (venue_id, kind, name, season, guest_count_min, guest_count_max)%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.packages DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_packages_venue_kind_name_season_guests
  ON public.packages (venue_id, kind, name, season, guest_count_min, guest_count_max)
  NULLS NOT DISTINCT;

COMMENT ON INDEX public.uq_packages_venue_kind_name_season_guests IS
  'Soft uniqueness for venue catalog. NULLS NOT DISTINCT so a NULL '
  'season / guest band collides with another NULL season / guest band — '
  'matches ON CONFLICT semantics in onboarding extract-packages confirm '
  'path (src/app/api/onboarding/extract-packages/route.ts). Per '
  'T5-Rixey-XX / RR finding. Replaces the migration-178 inline UNIQUE '
  'whose default NULLS DISTINCT semantics broke the upsert.';

-- ---------------------------------------------------------------------------
-- fred_indicators — public macroeconomic series (CPI, mortgage, etc.).
-- Writer: src/lib/services/external-context/fred-fetch.ts upserts
-- one row per (series_id, region, observation_date). Migration 138
-- created
--   UNIQUE INDEX uq_fred_indicators_series_region_date
--     ON fred_indicators (series_id, COALESCE(region, ''), observation_date)
-- which is a FUNCTIONAL index — Postgres ON CONFLICT cannot match it
-- without specifying the same expression list (Supabase's REST upsert
-- only supports plain column names).
--
-- Fix: add a plain unique index on (series_id, region, observation_date)
-- so ON CONFLICT can resolve. Caller updated in same commit to pass
-- region as '' (empty string) instead of NULL — keeps semantics
-- aligned with the existing COALESCE index AND avoids the NULL-not-
-- equal-NULL problem in the new plain index.
--
-- The legacy COALESCE index is left in place as a backstop — it
-- continues to enforce uniqueness even if a future writer regresses to
-- passing NULL.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_fred_indicators_series_region_date_plain
  ON public.fred_indicators (series_id, region, observation_date);

COMMENT ON INDEX public.uq_fred_indicators_series_region_date_plain IS
  'Plain (non-functional) unique index so ON CONFLICT in fred-fetch '
  'writer can resolve. Caller passes region as empty string '''' rather '
  'than NULL so this index actually constrains. Legacy COALESCE-based '
  'index uq_fred_indicators_series_region_date kept as backstop. Per '
  'T5-Rixey-XX / RR finding.';

COMMIT;

NOTIFY pgrst, 'reload schema';
