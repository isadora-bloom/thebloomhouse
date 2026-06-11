-- ============================================================================
-- Migration 381 — D4: Point-Zero (mid-funnel) + write-time touchpoint direction
-- ============================================================================
-- Canonical Product Definition v1.0 §3.3 / CANONICAL-RECONCILIATION-SPECS.md
-- D4 (+ the touchpoint half of D5's direction discipline) /
-- CONSOLIDATION-PLAN-PHASED.md v2.1 §1.8.
--
-- Point-Zero is the first event at which a couple is known by BOTH a name AND
-- a reachable identifier (email/phone — direct or relay; a handle alone does
-- not qualify). It is NOT the booked wedding (the Tier-8 redefinition is
-- retired) and NOT first contact. Set once, immutable after first set.
--
-- The writer stamping lives in src/lib/services/identity/point-zero.ts,
-- called from linkSignal (forwards-linker) — the single live chokepoint.
--
-- BACKFILL DELIBERATELY OMITTED for point_zero/zero_phase: the Phase-2
-- wipe+reimport replays every origin signal chronologically through
-- linkSignal, which stamps these correctly by construction. Backfilling the
-- interim spine (wiped weeks from now) would be wasted motion; no read
-- surface consumes these columns until Phase 3.3 signal-typing. Direction
-- gets a best-effort backfill below (explicit raw_payload + outbound action
-- list only — remaining rows stay NULL rather than guessed).
--
-- Known follow-ups (Phase 3, recorded here so they aren't relearned):
--   - candidate-match resolution + merge_couples reassign touchpoints between
--     couples without re-deriving zero_phase against the surviving couple's
--     point_zero_at. Phase-3.3 adds the re-stamp pass when attribution starts
--     reading zero_phase. Post-Phase-2 data is correct by construction.
-- ============================================================================

-- 1. Point-Zero on couples. Set once by the writer; the partial unique index
--    on point_zero_touchpoint_id is not needed (1:1 by construction).
ALTER TABLE couples ADD COLUMN IF NOT EXISTS point_zero_at timestamptz;
ALTER TABLE couples ADD COLUMN IF NOT EXISTS point_zero_touchpoint_id uuid
  REFERENCES touchpoints(id) ON DELETE SET NULL;

COMMENT ON COLUMN couples.point_zero_at IS
  'D4 (Canonical v1.0 §3.3, migration 381): the first event at which this couple was '
  'known by BOTH a name AND a reachable identifier (email/phone, direct or relay). '
  'Mid-funnel — NOT booking, NOT first contact. Set once by the forwards-linker; '
  'immutable after first set.';
COMMENT ON COLUMN couples.point_zero_touchpoint_id IS
  'The touchpoint that established point_zero_at (migration 381).';

-- 2. zero_phase + direction on touchpoints, stamped at write time by the
--    forwards-linker. NULL = written before this migration (or via a path
--    not yet stamping — pre-Phase-2 interim only).
ALTER TABLE touchpoints ADD COLUMN IF NOT EXISTS zero_phase text
  CHECK (zero_phase IN ('pre_zero', 'post_zero'));
ALTER TABLE touchpoints ADD COLUMN IF NOT EXISTS direction text
  CHECK (direction IN ('inbound', 'outbound'));

COMMENT ON COLUMN touchpoints.zero_phase IS
  'D4 (migration 381): this touchpoint''s position relative to the couple''s '
  'point_zero_at. pre_zero signals are DISCOVERY (acquisition credit); post_zero '
  'are RECONFIRMATION (no acquisition credit). Phase-3.3 attribution reads this.';
COMMENT ON COLUMN touchpoints.direction IS
  'D5 direction discipline (migration 381): inbound = couple-side, outbound = '
  'venue-side. Stamped at write time by the forwards-linker; read-time inference '
  'is banned (Canonical v1.0 §5).';

-- 3. Best-effort direction backfill — explicit signals only, no guessing.
UPDATE touchpoints
  SET direction = lower(raw_payload->>'direction')
  WHERE direction IS NULL
    AND lower(raw_payload->>'direction') IN ('inbound', 'outbound');
UPDATE touchpoints
  SET direction = 'outbound'
  WHERE direction IS NULL
    AND lower(action_type) IN ('venue_sent', 'outbound', 'auto_send', 'sms_outbound');

-- 4. Read-path index for Phase-3.3 attribution (pre-zero discovery scans).
CREATE INDEX IF NOT EXISTS ix_touchpoints_couple_zero_phase
  ON touchpoints (couple_id, zero_phase, occurred_at)
  WHERE couple_id IS NOT NULL;
