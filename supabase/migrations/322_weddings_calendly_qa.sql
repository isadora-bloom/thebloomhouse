-- ---------------------------------------------------------------------------
-- 322_weddings_calendly_qa.sql
-- ---------------------------------------------------------------------------
-- Class fix for the form-bleed name-leak bug. See NAME-LEAK-TRACE-2026-05-12.md.
--
-- Background
-- ----------
-- Tour-scheduler (src/lib/services/crm-import/tour-scheduler.ts:910-917)
-- composes weddings.notes from Calendly Q&A as a free-text block of
-- `key:value` lines. Example notes value:
--
--   partner2_email:foo@bar.com
--
--   package_interest:Whole Weekend
--
--   pricing_calculator:$12,500 estimate
--
--   unknown_q_a:
--     [Final Walkthrough] What time? : Saturday 2pm
--
-- The values are Capitalized phrases ("Whole Weekend", "Final Walkthrough").
-- Downstream, name-upgrade.ts:317 ran a capitalized-pair regex over
-- weddings.notes harvesting those phrases as candidate names and writing
-- them to people.first_name / people.last_name, bypassing the
-- name_evidence chokepoint.
--
-- name-upgrade.ts has been patched in the same change to:
--   (a) skip any line matching `^\w+:` before running the regex
--   (b) blacklist form-bleed tokens at the regex output
--
-- This migration is the STRUCTURAL half: give Calendly Q&A its own
-- jsonb column so future writes don't stuff the data into notes in the
-- first place.
--
-- Design decision: notes-untouched
-- --------------------------------
-- We DO NOT rewrite weddings.notes during this migration. The new
-- calendly_qa column is the structured surface going forward; notes
-- stays as-is to preserve the audit trail of what was historically
-- written. The name-upgrade regex now skips `key:value` lines so the
-- two columns coexisting is safe.
--
-- A future migration MAY drop the key:value lines from notes once
-- the operator has confirmed the migration of every Q&A consumer to
-- read calendly_qa. Not in scope here.
--
-- Backfill
-- --------
-- For every wedding with notes containing `key:value` lines we know
-- about (partner2_email, package_interest, pricing_calculator,
-- unknown_q_a), parse those lines into a jsonb object and stamp
-- calendly_qa. Unknown keys also captured under their own key so the
-- column is a faithful structured projection of what was in notes.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Backfill UPDATE only touches
-- rows where calendly_qa is still NULL, so re-running won't overwrite
-- subsequent writer output. No BEGIN/COMMIT (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — add calendly_qa column
-- ============================================================================

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS calendly_qa jsonb;

COMMENT ON COLUMN public.weddings.calendly_qa IS
  'Structured Calendly / form Q&A payload. Replaces the historical practice '
  'of stuffing key:value lines into weddings.notes (which leaked Capitalized '
  'values like "Whole Weekend" into people.first_name via the name-upgrade '
  'regex). Shape: { partner2_email?, package_interest?, pricing_calculator?, '
  'unknown_q_a?, plus any future Calendly question key }. Written by '
  'tour-scheduler.ts and crm-import/index.ts at wedding insert time. The '
  'name-upgrade pipeline (src/lib/services/identity/name-upgrade.ts) does '
  'NOT scan this column for name candidates — Q&A values are form-bleed by '
  'definition, never names. See 322_weddings_calendly_qa.sql and '
  'NAME-LEAK-TRACE-2026-05-12.md.';

-- ============================================================================
-- STEP 2 — backfill from existing notes
-- ============================================================================
-- Parse the historical notes blob into the new structured column for any
-- wedding that has notes but no calendly_qa yet. We use jsonb_object_agg
-- over regexp_matches to capture every `key:value` line; the value runs
-- to end-of-line or end-of-blob. Multi-line `unknown_q_a` blocks (which
-- in tour-scheduler.ts:916 use `\n  ` indented continuation) get captured
-- only up to the next newline — losing the continuation is acceptable for
-- backfill since notes itself stays untouched as the audit source.

WITH parsed AS (
  SELECT
    w.id AS wedding_id,
    jsonb_object_agg(m[1], m[2]) AS qa
  FROM public.weddings w
  CROSS JOIN LATERAL regexp_matches(
    COALESCE(w.notes, ''),
    '^([a-z][a-z0-9_]*):([^\n]+)$',
    'gm'
  ) AS m
  WHERE w.notes IS NOT NULL
    AND w.notes <> ''
    AND w.calendly_qa IS NULL
  GROUP BY w.id
)
UPDATE public.weddings w
SET calendly_qa = p.qa
FROM parsed p
WHERE w.id = p.wedding_id
  AND w.calendly_qa IS NULL;
