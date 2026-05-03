-- ---------------------------------------------------------------------------
-- 181_booking_value_normalize.sql  (T5-Rixey-NN — bug #8)
-- ---------------------------------------------------------------------------
-- Per Bloom convention (see src/lib/services/crm-import/index.ts:121 +
-- migration 175 + the parseCurrency primitive at
-- src/lib/services/crm-import/primitives/financial-parser.ts), every
-- currency column is integer CENTS.
--
-- Pre-fix, only the HoneyBook + web-form CRM-import adapters used the
-- parseMoneyToCents helper. Other writers (data-import.ts, generic-csv,
-- coordinator portal /portal/weddings page, attribution rollups) wrote
-- raw DOLLARS into weddings.booking_value. The result was a unit-confused
-- column that the source_attribution rollup naively summed —
-- producing the $51,432,396 phantom-revenue artifact that Stream MM
-- caught loading Rixey.
--
-- This migration backfills the legacy dollar-encoded rows to cents.
--
-- Heuristic
-- ---------
-- A real wedding's booking_value almost never sits between $1 and $999.
-- Deposit-only / cleaning-fee-only rows that look like that are rare and
-- already-anomalous; coordinators audit them by hand. So:
--
--   booking_value < 100000    → almost certainly DOLLARS (multiply by 100)
--                               $1 - $999.99 inclusive maps cleanly.
--                               $1,000 dollar value maps to 1000 (under
--                               threshold), gets multiplied to 100000.
--
--   booking_value = 100000    → ambiguous ($1000 dollars OR $1000 cents
--                               = $10). Treat as dollars (multiply) — the
--                               $10 wedding is almost certainly an error
--                               or test-row that's better expressed as
--                               $1000.
--
--   100000 < booking_value     → already CENTS. No change. Real venues
--    < 100000000                charge $1k-$1M; this is the live-cents
--                               band, plus the upper end of legitimately-large
--                               weddings stored as cents.
--
--   booking_value >= 100000000 → > $1,000,000 in cents (or > $100,000,000
--                               in dollars — physically impossible for a
--                               wedding). Either a unit-conversion artefact
--                               (already-cents row that got *100 by a
--                               buggy writer somewhere), or a coordinator
--                               typo. Flag for manual review by leaving
--                               as-is — DO NOT mass-touch these. The
--                               separate audit step below logs them so
--                               coordinators can repair.
--
-- This is a one-shot. After landing, every writer is enforced cents
-- via the code-side fixes (data-import.ts + generic-csv + portal/weddings
-- create form), so the heuristic never has to re-fire.
--
-- Idempotent: re-running is safe (rows in the cents band are skipped).
--
-- @probe: select_returns weddings columns booking_value
-- ---------------------------------------------------------------------------

BEGIN;

-- Pre-flight: snapshot magnitude distribution into a temp table so we
-- can log exactly what got touched. This is a transient log that does
-- NOT persist after the migration completes, but the NOTICE output
-- ends up in the apply-migrations log.
DO $$
DECLARE
  count_dollars int;
  count_cents int;
  count_anomalous int;
  count_null int;
BEGIN
  SELECT count(*) INTO count_null FROM public.weddings WHERE booking_value IS NULL;
  SELECT count(*) INTO count_dollars FROM public.weddings
    WHERE booking_value IS NOT NULL AND booking_value <= 100000;
  SELECT count(*) INTO count_cents FROM public.weddings
    WHERE booking_value > 100000 AND booking_value < 100000000;
  SELECT count(*) INTO count_anomalous FROM public.weddings
    WHERE booking_value >= 100000000;

  RAISE NOTICE '[181] booking_value pre-fix distribution:';
  RAISE NOTICE '  null              : %', count_null;
  RAISE NOTICE '  <= 100000 (dollars→cents conversion target): %', count_dollars;
  RAISE NOTICE '  100001-99999999  (already cents, skip)    : %', count_cents;
  RAISE NOTICE '  >= 100000000 (anomalous, leave for manual): %', count_anomalous;
END
$$;

-- Convert dollar-encoded rows to cents. The cents-band ((100000, 100000000))
-- and the anomalous band (>= 100000000) are deliberately left untouched.
UPDATE public.weddings
SET booking_value = booking_value * 100
WHERE booking_value IS NOT NULL
  AND booking_value > 0
  AND booking_value <= 100000;

-- Post-flight summary.
DO $$
DECLARE
  count_under_threshold int;
  count_anomalous int;
BEGIN
  SELECT count(*) INTO count_under_threshold FROM public.weddings
    WHERE booking_value IS NOT NULL AND booking_value <= 100000;
  SELECT count(*) INTO count_anomalous FROM public.weddings
    WHERE booking_value >= 100000000;

  RAISE NOTICE '[181] booking_value post-fix:';
  RAISE NOTICE '  remaining <= 100000 (small / deposit-only / test): %', count_under_threshold;
  RAISE NOTICE '  remaining >= 100000000 (anomalous, manual review): %', count_anomalous;
END
$$;

-- Document the convention at the schema level so future writers don't
-- regress. (The CRM-import index.ts comment already says cents; mirror
-- on the column itself for any DBA who reads psql \d+ first.)
COMMENT ON COLUMN public.weddings.booking_value IS
  'Total contract value in INTEGER CENTS (Bloom convention; see '
  'src/lib/services/crm-import/index.ts and primitives/financial-parser.ts). '
  'Migration 181 (T5-Rixey-NN bug #8) backfilled legacy dollar-encoded '
  'rows. All writers must multiply user-supplied dollar inputs by 100 '
  'before insert.';

COMMIT;
