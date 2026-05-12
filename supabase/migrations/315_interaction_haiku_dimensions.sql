-- ---------------------------------------------------------------------------
-- 311_interaction_haiku_dimensions.sql
-- ---------------------------------------------------------------------------
-- Pattern 5 (BLOOM-PATTERNS-ZOOM-OUT.md) — replace inline brain heuristics
-- for sentiment / urgency / family-mentioned with a Haiku classifier on
-- the source-of-truth row. Today every brain prompt that wants to "respond
-- appropriately when the couple sounds frustrated" or "lift urgency when
-- they ask about availability this weekend" has to re-infer from raw body
-- text. That's tokens burned, latency added, and inconsistency baked in
-- (router-brain, inquiry-brain and client-brain each judge the same body
-- differently). Lift the judgment up to a single Haiku call on the
-- interaction row; every downstream consumer reads the cached dimension.
--
-- Doctrine anchors
--   - bloom-may9-llm-vs-template.md (every Sage/AI/smart label backed by
--     callAI; this is the structured-classify shape)
--   - feedback_self_reported_sources_not_truth.md (sibling pattern —
--     store the signal as evidence on the row, not derived per-read)
--   - bloom-constitution.md (forensic record; every dimension that
--     downstream consumers act on lives on the interaction row)
--
-- Columns added
--   - sentiment text — bounded 4-way enum. Nullable until classified.
--   - urgency text — bounded 3-way enum. Nullable until classified.
--   - family_mentioned boolean DEFAULT false — non-partner human role
--     mention on this body (mom, dad, MOH, planner, vendor contact).
--     Default false so unclassified rows behave like "no signal" — a
--     consumer can distinguish "no" from "not yet known" via
--     haiku_classified_at IS NULL.
--   - haiku_classified_at timestamptz — pending marker. NULL = the
--     classifier has not run. Used by the cron drain to find work and
--     by the fire-and-forget path to short-circuit re-classification.
--
-- Index strategy
--   Partial index on (venue_id, created_at) WHERE haiku_classified_at IS
--   NULL AND direction = 'inbound' — the cron drain is the only consumer
--   of pending rows, and it scans per-venue ordered by recency. Outbound
--   rows never enter the queue so the predicate keeps the index tight.
--
-- NO backfill in this migration. Historical inbound rows are populated
-- by the cron drain (see src/app/api/cron/route.ts case
-- 'inbound_haiku_drain'). Migrations may not BEGIN/COMMIT and a multi-
-- thousand-row UPDATE here would exceed the exec_sql timeout regardless.
-- ---------------------------------------------------------------------------

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS sentiment text
  CHECK (sentiment IN ('positive', 'neutral', 'concerned', 'frustrated'));

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS urgency text
  CHECK (urgency IN ('low', 'medium', 'high'));

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS family_mentioned boolean DEFAULT false;

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS haiku_classified_at timestamptz;

COMMENT ON COLUMN interactions.sentiment IS
  'Haiku-classified emotional tenor of this inbound body. One of positive | neutral | concerned | frustrated. NULL until the classifier in src/lib/services/intel/inbound-haiku-classifier.ts has run. Brain prompts (inquiry / client / sage) surface the latest inbound value so drafts respond appropriately. Mig 311.';

COMMENT ON COLUMN interactions.urgency IS
  'Haiku-classified urgency tier of this inbound body. One of low | medium | high. NULL until the classifier has run. Brain prompts surface the latest inbound value so drafts match cadence. Mig 311.';

COMMENT ON COLUMN interactions.family_mentioned IS
  'Was a non-partner human role (mom, dad, mother-in-law, sibling, MOH, planner, family friend, vendor contact) referenced in this body. Excludes the two partners themselves. Defaults to false so unclassified rows behave as no-signal; pair with haiku_classified_at IS NULL to distinguish "no" from "not yet known". Mig 311.';

COMMENT ON COLUMN interactions.haiku_classified_at IS
  'Timestamp the inbound-haiku-classifier successfully wrote sentiment / urgency / family_mentioned for this row. NULL = pending (cron drain will pick it up). Pair with direction = inbound in the partial idx_interactions_haiku_pending index. Mig 311.';

CREATE INDEX IF NOT EXISTS idx_interactions_haiku_pending
  ON interactions (venue_id, created_at)
  WHERE haiku_classified_at IS NULL AND direction = 'inbound';
