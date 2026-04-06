-- ============================================
-- 020: SYNC FIXES
-- Fix CHECK constraints, add table_assignment text column,
-- allow side='both' in wedding_party
-- ============================================

-- Allow 'both' in wedding_party side
ALTER TABLE wedding_party DROP CONSTRAINT IF EXISTS wedding_party_side_check;

-- Add table_assignment text to guest_list (for simple name-based assignment)
ALTER TABLE guest_list ADD COLUMN IF NOT EXISTS table_assignment text;

-- Drop strict role checks on ceremony_order (already done in 018 but be safe)
ALTER TABLE ceremony_order DROP CONSTRAINT IF EXISTS ceremony_order_role_check;
ALTER TABLE ceremony_order DROP CONSTRAINT IF EXISTS ceremony_order_side_check;
