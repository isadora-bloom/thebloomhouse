-- ---------------------------------------------------------------------------
-- 312_operator_override_columns.sql  (Pattern 10)
-- ---------------------------------------------------------------------------
-- Operator override channel for the four most-leveraged auto-derived fields:
--   1. weddings.heat_score         (recalculateHeatScore in heat-mapping.ts)
--   2. weddings.persona_label      (cohort matching in intel layer)
--   3. weddings first-touch flag   (lives on attribution_events.is_first_touch;
--                                   we stamp wedding-scoped audit cols here
--                                   so the demote/promote write through to a
--                                   single attribution row is auditable)
--   4. interactions.author_class   (293_interactions_author_class.sql)
--
-- For each field we record WHO overrode it and WHEN. The auto-derive layer
-- must consult the *_overridden_at column and short-circuit if non-null.
-- For heat_score we additionally store the override value itself so the
-- recalculation can early-return without losing the operator's number.
-- For persona_label the value column IS the override value (no separate
-- column needed today; persona_label was previously read from a derived
-- cohort row, not stored on weddings).
--
-- Idempotent. No BEGIN/COMMIT (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- weddings: heat_score override channel ----------------------------------
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS heat_score_overridden_by uuid
    REFERENCES public.user_profiles(id) ON DELETE SET NULL;

ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS heat_score_overridden_at timestamptz;

ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS heat_score_override_value integer;

ALTER TABLE weddings DROP CONSTRAINT IF EXISTS weddings_heat_score_override_value_range;
ALTER TABLE weddings
  ADD CONSTRAINT weddings_heat_score_override_value_range
  CHECK (heat_score_override_value IS NULL
         OR (heat_score_override_value >= 0 AND heat_score_override_value <= 100));

COMMENT ON COLUMN weddings.heat_score_overridden_by IS
  'user_profiles.id of the coordinator who set the heat_score override. Auto-derive layer (recalculateHeatScore in heat-mapping.ts) MUST early-return when heat_score_overridden_at IS NOT NULL and write nothing to heat_score / temperature_tier.';
COMMENT ON COLUMN weddings.heat_score_overridden_at IS
  'Timestamp the heat_score override was set. Presence of a non-null value is the sentinel recalculateHeatScore checks before writing.';
COMMENT ON COLUMN weddings.heat_score_override_value IS
  'The operator-supplied heat score (0-100). When non-null, this value is the canonical heat score and recalculateHeatScore returns it without writing weddings.heat_score. Range check enforced via weddings_heat_score_override_value_range.';

-- weddings: persona_label override channel --------------------------------
-- persona_label was previously derived on read (cohort matching from intel);
-- this is the first time we store it on weddings. The default null means
-- "fall through to the derived value"; a non-null persona_label is the
-- operator's locked label.
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS persona_label text;

ALTER TABLE weddings DROP CONSTRAINT IF EXISTS weddings_persona_label_length;
ALTER TABLE weddings
  ADD CONSTRAINT weddings_persona_label_length
  CHECK (persona_label IS NULL OR char_length(persona_label) <= 60);

ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS persona_label_overridden_by uuid
    REFERENCES public.user_profiles(id) ON DELETE SET NULL;

ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS persona_label_overridden_at timestamptz;

COMMENT ON COLUMN weddings.persona_label IS
  'Operator override for the couple''s persona label. NULL means use the derived cohort label (intel layer). When non-null, treat this as the canonical label across all surfaces (lead detail, intel rollups, sequence routing). Max 60 chars.';
COMMENT ON COLUMN weddings.persona_label_overridden_by IS
  'user_profiles.id of the coordinator who set persona_label. Cleared when the override is reverted.';
COMMENT ON COLUMN weddings.persona_label_overridden_at IS
  'Timestamp persona_label was set by an operator. Sentinel for any cohort-label writer: if non-null, do not overwrite persona_label.';

-- weddings: first-touch override channel ---------------------------------
-- First-touch lives on attribution_events.is_first_touch (one row=true per
-- wedding, set by the trigger from migration 119). The override here is
-- a wedding-scoped audit pair; the actual is_first_touch promotion/demotion
-- is performed by the API route and the auto-derive trigger
-- (recompute_attribution_buckets) must skip recomputation when
-- first_touch_overridden_at IS NOT NULL.
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS first_touch_overridden_by uuid
    REFERENCES public.user_profiles(id) ON DELETE SET NULL;

ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS first_touch_overridden_at timestamptz;

COMMENT ON COLUMN weddings.first_touch_overridden_by IS
  'user_profiles.id of the coordinator who locked first-touch attribution. attribution_events.is_first_touch was promoted/demoted by the override route; this column captures audit.';
COMMENT ON COLUMN weddings.first_touch_overridden_at IS
  'Timestamp first-touch was locked. The recompute_attribution_buckets trigger (migration 119) should treat this as a do-not-recompute sentinel for is_first_touch on this wedding.';

-- interactions: author_class override channel ----------------------------
-- author_class is auto-derived by the classifier from migration 293. The
-- override layer mirrors the wedding-side pattern: when overridden_at is
-- non-null, the AI re-classifier must not overwrite the value.
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS author_class_overridden_by uuid
    REFERENCES public.user_profiles(id) ON DELETE SET NULL;

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS author_class_overridden_at timestamptz;

COMMENT ON COLUMN interactions.author_class_overridden_by IS
  'user_profiles.id of the coordinator who set the author_class override. The author-class classifier (migration 293 / Wave 27) MUST skip re-classification when author_class_overridden_at IS NOT NULL.';
COMMENT ON COLUMN interactions.author_class_overridden_at IS
  'Timestamp the author_class override was set. Sentinel for the AI classifier and any heuristic write path: presence means leave author_class untouched.';

-- Partial indexes for "find rows with active overrides" ------------------
-- These are heavily selective in practice (most weddings/interactions have
-- no override). Used by /admin/overrides views + invariant checks.
CREATE INDEX IF NOT EXISTS idx_weddings_heat_score_overridden
  ON weddings (heat_score_overridden_at DESC)
  WHERE heat_score_overridden_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_weddings_persona_label_overridden
  ON weddings (persona_label_overridden_at DESC)
  WHERE persona_label_overridden_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_weddings_first_touch_overridden
  ON weddings (first_touch_overridden_at DESC)
  WHERE first_touch_overridden_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_author_class_overridden
  ON interactions (author_class_overridden_at DESC)
  WHERE author_class_overridden_at IS NOT NULL;
