-- ============================================
-- 021: SEATING TABLE FIXES
-- Drop restrictive table_type CHECK, add sort_order column
-- ============================================

-- Drop the old CHECK constraint that only allowed 'round', 'rectangle', 'head'
ALTER TABLE seating_tables DROP CONSTRAINT IF EXISTS seating_tables_table_type_check;

-- Add sort_order column for ordering tables in the list view
ALTER TABLE seating_tables ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;
