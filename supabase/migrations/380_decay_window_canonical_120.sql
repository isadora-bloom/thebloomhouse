-- ============================================================================
-- Migration 380 — D5: canonical decay window 90–120 days (default 120)
-- ============================================================================
-- Canonical Product Definition v1.0 §3.4 / CANONICAL-RECONCILIATION-SPECS.md D5
-- / CONSOLIDATION-PLAN-PHASED.md v2.1 §1.8.
--
-- The decay window becomes configurable 90–120 days, default 120 — replacing
-- the doctrine-era 180. The direction half of D5 ("only couple-side inbound
-- resets the clock") is ALREADY enforced structurally: couple_progression_events
-- is an inbound-only log (progression.ts `progressionEventTypeFor` returns null
-- for every outbound action; the event_type CHECK enumerates inbound-only
-- types), and couples.last_progression_at is bumped only by that writer. No
-- direction column is needed there — every row is inbound by construction.
-- Write-time direction on `touchpoints` lands with the D4 migration (381),
-- which touches the same write sites for zero_phase stamping.
--
-- Order of operations matters: clamp existing rows BEFORE adding the upper-
-- bound CHECK, or the ALTER fails validation on the doctrine-era 180 rows.
-- ============================================================================

-- 1. Clamp existing rows into the canonical band. Every row at the old
--    default 180 (and any other value above 120) clamps to 120; anything
--    below 90 (none expected — old CHECK floored at 90) clamps to 90.
UPDATE couples SET decay_window_days = 120 WHERE decay_window_days > 120;
UPDATE couples SET decay_window_days = 90  WHERE decay_window_days < 90;

-- 2. New default for future mints.
ALTER TABLE couples ALTER COLUMN decay_window_days SET DEFAULT 120;

-- 3. Replace the floor-only CHECK with the canonical band. The original
--    constraint from migration 346 is an inline column CHECK whose
--    auto-generated name is couples_decay_window_days_check.
ALTER TABLE couples DROP CONSTRAINT IF EXISTS couples_decay_window_days_check;
ALTER TABLE couples ADD CONSTRAINT couples_decay_window_days_check
  CHECK (decay_window_days BETWEEN 90 AND 120);

COMMENT ON COLUMN couples.decay_window_days IS
  'Per-venue tunable decay window, canonical band 90-120 days (default 120) per '
  'Canonical Product Definition v1.0 §3.4 (migration 380; was doctrine-era 180). '
  'Only couple-side INBOUND progression resets the clock — enforced structurally '
  'by the inbound-only couple_progression_events writer.';
