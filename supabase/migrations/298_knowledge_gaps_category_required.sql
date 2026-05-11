-- ---------------------------------------------------------------------------
-- 298_knowledge_gaps_category_required.sql  (F22)
-- ---------------------------------------------------------------------------
-- The Wave 19 detector validator requires `category` ∈ {pricing, availability,
-- logistics, policy, vendor, ceremony, catering, inclusions, other}, but the
-- manual-capture API route (/api/admin/knowledge-gaps/capture) allows rows
-- with NULL category. Result: the /agent/knowledge-gaps page filters by
-- category and 447 legacy rows show as "uncategorized" with no path forward.
--
-- This migration:
--   1. Tags every NULL-category row with 'other' so the UI can render them.
--      A separate Haiku backfill (Stream 4) will re-categorize 'other' rows
--      against real content over the next cron tick.
--   2. Adds the CHECK constraint to prevent future NULL writes.
-- ---------------------------------------------------------------------------

-- Step 1: coerce ALL non-conforming values to 'other'. The original
-- knowledge_gaps schema (mig 009) had `category text` with NO check,
-- so historical rows carry whatever string the pre-Wave-19 writers
-- chose ('general', 'misc', 'follow_up', null, …). Coercing to 'other'
-- means the new CHECK can land without violation; the Haiku re-
-- categoriser (knowledge-gaps/category-backfill.ts) will upgrade
-- 'other' rows to real categories on the next cron tick.
UPDATE knowledge_gaps
SET category = 'other'
WHERE category IS NULL
   OR category NOT IN (
     'pricing',
     'availability',
     'logistics',
     'policy',
     'vendor',
     'ceremony',
     'catering',
     'inclusions',
     'other'
   );

-- Step 2: enforce CHECK + NOT NULL going forward.
ALTER TABLE knowledge_gaps
  ALTER COLUMN category SET NOT NULL;

ALTER TABLE knowledge_gaps DROP CONSTRAINT IF EXISTS knowledge_gaps_category_check;
ALTER TABLE knowledge_gaps
  ADD CONSTRAINT knowledge_gaps_category_check
  CHECK (category IN (
    'pricing',
    'availability',
    'logistics',
    'policy',
    'vendor',
    'ceremony',
    'catering',
    'inclusions',
    'other'
  ));

-- Index for the UI filter (open + by category).
CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_venue_status_category
  ON knowledge_gaps (venue_id, status, category)
  WHERE status = 'open';

NOTIFY pgrst, 'reload schema';
