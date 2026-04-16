-- ============================================
-- 052: CONSOLIDATE BUDGET TABLES
-- BUG-06 fix: Two budget tables have been living side by side.
--   - `budget` (migration 004) — older, with columns
--       estimated_cost, actual_cost, paid_amount, vendor_id
--   - `budget_items` (migration 017) — newer canonical table, with columns
--       budgeted, committed, paid, vendor_name, payment_source,
--       payment_due_date, sort_order
-- Couples write to `budget_items` (via /couple/[slug]/budget) but the
-- platform portal pages were still reading from `budget`, so data never
-- surfaced to coordinators.
--
-- This migration:
--   1. Copies any data sitting in `budget` into `budget_items` with the
--      column names mapped across. Safe to re-run — ON CONFLICT guards
--      against duplicate primary keys.
--   2. Marks the old `budget` table as deprecated (via COMMENT). We do
--      NOT drop it, because other systems (seed.sql, the agent Python
--      service, or downstream analytics) may still reference it.
--
-- A VIEW aliasing `budget` over `budget_items` is NOT possible here
-- without dropping the physical table first, and we have been instructed
-- not to drop it. The code fix in `src/app/(platform)/portal/weddings/[id]/`
-- redirects the remaining readers to `budget_items` instead, which is the
-- canonical source going forward.
-- ============================================

-- Step 1: Copy rows from legacy `budget` into `budget_items`.
-- Column mapping:
--   estimated_cost -> budgeted
--   actual_cost    -> committed
--   paid_amount    -> paid
--   vendor_id      -> (NOT copied — `budget_items` uses `vendor_name` text,
--                      not a FK. Keep it NULL rather than stringify a uuid.)
-- `category` is NOT NULL in budget_items, so we COALESCE to 'uncategorized'.
-- `item_name` is NOT NULL in both so it carries across as-is.
-- `ON CONFLICT (id) DO NOTHING` makes this idempotent: re-running the
-- migration won't duplicate rows, and if a row was already ported it stays.
INSERT INTO budget_items (
  id,
  venue_id,
  wedding_id,
  category,
  item_name,
  budgeted,
  committed,
  paid,
  notes,
  created_at,
  updated_at
)
SELECT
  b.id,
  b.venue_id,
  b.wedding_id,
  COALESCE(b.category, 'uncategorized'),
  b.item_name,
  b.estimated_cost,
  b.actual_cost,
  b.paid_amount,
  b.notes,
  b.created_at,
  b.updated_at
FROM budget b
WHERE EXISTS (SELECT 1 FROM weddings w WHERE w.id = b.wedding_id)
ON CONFLICT (id) DO NOTHING;

-- Step 2: Mark legacy table as deprecated. We intentionally keep the
-- table around so any lingering external reader doesn't break; all app
-- code has been repointed at `budget_items`.
COMMENT ON TABLE budget IS
  'owner:portal [DEPRECATED 2026-04-16 BUG-06]: use budget_items instead. '
  'Data copied forward in migration 052. Do not read/write from app code.';
