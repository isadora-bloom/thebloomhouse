-- ============================================================================
-- Migration 098: Couple-facing staffing calculator fields
-- ============================================================================
--
-- CONTEXT
-- The couple-side staffing calculator (src/app/_couple-pages/staffing/page.tsx)
-- previously persisted its full state as a JSON blob in `notes` with a
-- sentinel role of '_calculator'. That worked for one row per wedding but
-- made it impossible to query the recommendation totals from anywhere else
-- (admin views, summary cards, exports) without parsing JSON in the client.
--
-- This migration adds first-class columns mirroring the rixey-portal shape
-- (server/index.js -> /api/staffing) so the calculator's outputs are
-- queryable directly:
--
--   friday_bartenders, friday_extra_hands, friday_total
--   saturday_bartenders, saturday_extra_hands, saturday_total
--   total_staff, total_cost
--   answers          jsonb — full questionnaire snapshot for round-tripping
--
-- All adds are additive and idempotent: ADD COLUMN IF NOT EXISTS, no UPDATE
-- against existing rows. The original 009 columns (role, person_name,
-- count, hourly_rate, hours, tip_amount, notes) remain untouched, so the
-- venue-side per-person assignment workflow keeps working unchanged.
--
-- The calculator row continues to use role='_calculator' as a sentinel and
-- one row per wedding_id; a partial unique index enforces that invariant
-- without affecting non-calculator assignment rows.
-- ============================================================================

ALTER TABLE staffing_assignments
  ADD COLUMN IF NOT EXISTS friday_bartenders integer,
  ADD COLUMN IF NOT EXISTS friday_extra_hands integer,
  ADD COLUMN IF NOT EXISTS friday_total integer,
  ADD COLUMN IF NOT EXISTS saturday_bartenders integer,
  ADD COLUMN IF NOT EXISTS saturday_extra_hands integer,
  ADD COLUMN IF NOT EXISTS saturday_total integer,
  ADD COLUMN IF NOT EXISTS total_staff integer,
  ADD COLUMN IF NOT EXISTS total_cost numeric,
  ADD COLUMN IF NOT EXISTS answers jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

COMMENT ON COLUMN staffing_assignments.answers IS
  'Full questionnaire snapshot from the couple-facing staffing calculator. Only populated when role = ''_calculator''.';

-- One calculator row per wedding. Per-person assignment rows
-- (role IN bartender|server|...) are unaffected because the index is
-- partial on role = '_calculator'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staffing_assignments_calculator_one_per_wedding
  ON staffing_assignments (wedding_id)
  WHERE role = '_calculator';

CREATE INDEX IF NOT EXISTS idx_staffing_assignments_wedding
  ON staffing_assignments (wedding_id);

NOTIFY pgrst, 'reload schema';
