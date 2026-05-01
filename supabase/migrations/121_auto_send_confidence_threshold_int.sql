-- Migration 121: auto_send_rules.confidence_threshold → integer 0-100
--
-- Item 5 (strict confidence) per the Repair K self-review. The
-- audit caught that confidence flowed across two scales:
--   - brain output: integer 0-100 (e.g. 85 = 85%)
--   - auto_send_rules.confidence_threshold: float 0.0-1.0
--   - settings UI: stored 0.0-1.0, displayed 0-100
--
-- Repair K (commit 88d44ac) added a heuristic in
-- checkAutoSendEligible that accepts both scales. That's
-- pragmatic but it's a leaky abstraction — every code path that
-- thinks about confidence has to know "either could come in."
--
-- Strict fix: pick ONE scale (integer 0-100) and force everyone
-- to use it. Brain output is already on this scale; UI is already
-- on this scale; only the DB column differs. Migrate the column.
--
-- Migration steps (idempotent, safe to re-run):
--   1. Add a new int column `confidence_threshold_pct`.
--   2. Backfill from existing float column: ROUND(threshold * 100).
--   3. Drop old float column.
--   4. Rename new column to `confidence_threshold`.
--   5. Add CHECK (between 0 and 100) + DEFAULT 85.
--
-- After this migration, checkAutoSendEligible drops the heuristic
-- and compares integer-to-integer. Settings UI stops dividing by 100.

-- Guard: if the new int column already exists from a prior run,
-- skip the rename dance.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'auto_send_rules' AND column_name = 'confidence_threshold';

  -- Already integer? Migration is a no-op.
  IF col_type = 'integer' THEN
    RAISE NOTICE 'auto_send_rules.confidence_threshold is already integer; skipping';
    RETURN;
  END IF;

  -- Add the new column
  ALTER TABLE auto_send_rules
    ADD COLUMN IF NOT EXISTS confidence_threshold_pct integer;

  -- Backfill: 0.85 → 85, 0.95 → 95, etc. ROUND handles edge cases.
  -- Existing rules ship with 0.85 default per migration 002:117.
  UPDATE auto_send_rules
    SET confidence_threshold_pct = ROUND(confidence_threshold * 100)
    WHERE confidence_threshold_pct IS NULL;

  -- Drop old float column
  ALTER TABLE auto_send_rules
    DROP COLUMN confidence_threshold;

  -- Rename new column
  ALTER TABLE auto_send_rules
    RENAME COLUMN confidence_threshold_pct TO confidence_threshold;

  -- Lock down: NOT NULL, DEFAULT, CHECK
  ALTER TABLE auto_send_rules
    ALTER COLUMN confidence_threshold SET NOT NULL,
    ALTER COLUMN confidence_threshold SET DEFAULT 85;

  ALTER TABLE auto_send_rules
    DROP CONSTRAINT IF EXISTS auto_send_rules_confidence_threshold_check;
  ALTER TABLE auto_send_rules
    ADD CONSTRAINT auto_send_rules_confidence_threshold_check
      CHECK (confidence_threshold >= 0 AND confidence_threshold <= 100);
END $$;

COMMENT ON COLUMN auto_send_rules.confidence_threshold IS
  'Integer 0-100. Match brain output scale (inquiry-brain returns 75-95). '
  'Pre-migration this was float 0.0-1.0; checkAutoSendEligible had a '
  'heuristic to accept both scales. Now strict — one scale across '
  'brains + DB + UI. Default 85 (= "auto-send when at least 85% '
  'confident"). INV-7.3.';
