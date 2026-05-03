-- Migration 197 (Stream HHH, Bug 14): cultural_moments.influence_weight
-- explicit range CHECK + coordinator-facing comment.
--
-- Background
-- ----------
-- Migration 139 already encoded a CHECK on influence_weight (-100 to
-- 100) but it was attached to the column-default clause, which:
--   - is anonymously named (hard to drop / replace)
--   - rejects NULL implicitly via the column being non-NULL by default
--     of 0, but NULL is technically allowed at the column level
--
-- This migration:
--   1. Backfills any existing out-of-range rows to the nearest bound
--      (so the CHECK doesn't fail on apply for legacy / hand-edited
--      rows). Stream HHH spec: "if any existing cultural_moments rows
--      have influence_weight outside -100 to +100, FIX THEM first
--      then add the CHECK".
--   2. Drops the legacy anonymous CHECK if present.
--   3. Adds the new named CHECK that explicitly allows NULL.
--   4. Refreshes the column comment so the coordinator-facing
--      semantics live next to the schema.
--
-- The renamed constraint exists so future migrations can DROP it by
-- name without the discover-and-drop-by-DO-block dance migration 144
-- needed for the insight_type CHECK.
--
-- Idempotent: safe to re-apply.

-- 1. Backfill out-of-range rows. ABS > 100 indicates a bug somewhere
--    in the writer path that landed an obviously wrong value. Clamp
--    to the legal range so the CHECK applies cleanly. Loud LOG so
--    we notice in the migration output if this fires.
DO $$
DECLARE
  fixed_count integer := 0;
BEGIN
  UPDATE public.cultural_moments
     SET influence_weight = GREATEST(-100, LEAST(100, influence_weight))
   WHERE influence_weight IS NOT NULL
     AND (influence_weight < -100 OR influence_weight > 100);
  GET DIAGNOSTICS fixed_count = ROW_COUNT;
  IF fixed_count > 0 THEN
    RAISE NOTICE 'Migration 197: clamped % cultural_moments.influence_weight rows into [-100, 100].', fixed_count;
  END IF;
END $$;

-- 2. Drop the legacy anonymous CHECK (column-default clause from
--    migration 139). Discover by definition since the name is
--    Postgres-assigned.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname
    INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'public.cultural_moments'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%influence_weight%>=%-100%'
     AND conname <> 'cultural_moments_influence_weight_range'
   LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.cultural_moments DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

-- 3. Add the new named CHECK. Explicit NULL handling so the intent
--    is obvious to future readers (PostgreSQL CHECKs already accept
--    NULL via UNKNOWN, but spelling it out documents the policy).
ALTER TABLE public.cultural_moments
  DROP CONSTRAINT IF EXISTS cultural_moments_influence_weight_range;

ALTER TABLE public.cultural_moments
  ADD CONSTRAINT cultural_moments_influence_weight_range
  CHECK (influence_weight IS NULL OR (influence_weight >= -100 AND influence_weight <= 100));

-- 4. Refresh the column comment with coordinator-facing semantics.
COMMENT ON COLUMN public.cultural_moments.influence_weight IS
  'Impact score: -100 to +100. Positive = lifts wedding inquiries; '
  'negative = drags them down. Coordinator-facing on '
  '/intel/cultural-moments. Per Stream HHH Bug 14 (T5-Rixey-HHH).';

-- =====================================================================
-- Stream HHH Bug 21: backfill confidence on correlation insight rows
-- whose confidence column is NULL or 0 but data_points carries an r.
--
-- Per spec: "Compute confidence from data_points->>'r' (Pearson r →
-- confidence ≈ 1 - (1-|r|)/2 OR use the engine's actual confidence
-- formula)."
--
-- The engine formula in src/lib/services/insights/confidence.ts is
-- sqrt(tanh(N/30) * |r|) with a hard ceiling at sample<5 and a floor
-- at sample>=100 + |r|>=0.5. We don't have N here without joining to
-- the underlying correlation row, so use the simpler analytical
-- approximation from the spec: confidence ≈ 1 - (1 - |r|)/2 = (1 + |r|) / 2.
-- That gives r=1 → 1.0, r=0.7 → 0.85, r=0 → 0.5 — close enough to
-- the engine formula's high-r regime (which is where the missing-
-- confidence bug bites: high-r rows that should display a badge).
--
-- Idempotent: only updates rows where confidence is currently
-- NULL or 0 AND a numeric r exists in data_points.
-- =====================================================================
DO $$
DECLARE
  fixed_count integer := 0;
BEGIN
  UPDATE public.intelligence_insights
     SET confidence = LEAST(1.0, GREATEST(0.0,
           (1.0 + ABS((data_points->>'r')::numeric)) / 2.0
         ))
   WHERE insight_type IN ('correlation', 'correlation_narration')
     AND (confidence IS NULL OR confidence = 0)
     AND data_points ? 'r'
     AND (data_points->>'r') ~ '^-?[0-9]+(\.[0-9]+)?$';
  GET DIAGNOSTICS fixed_count = ROW_COUNT;
  IF fixed_count > 0 THEN
    RAISE NOTICE 'Migration 197: backfilled confidence on % correlation insight rows from data_points.r.', fixed_count;
  END IF;
END $$;
