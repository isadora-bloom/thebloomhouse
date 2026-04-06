-- ============================================
-- 018: CEREMONY ORDER & BEAUTY SCHEDULE FIXES
-- Fix ceremony_order column mismatches (code uses 'section', DB had 'side' with wrong CHECK)
-- Add duration column to makeup_schedule for time estimation
-- ============================================

-- 1) ceremony_order: Add 'section' column for processional/family_escort/recessional
ALTER TABLE ceremony_order ADD COLUMN IF NOT EXISTS section text;

-- 2) ceremony_order: Drop restrictive CHECK on 'role' — code sends free-text roles
ALTER TABLE ceremony_order DROP CONSTRAINT IF EXISTS ceremony_order_role_check;

-- 3) ceremony_order: Drop restrictive CHECK on 'side' — code sends 'center' and others
ALTER TABLE ceremony_order DROP CONSTRAINT IF EXISTS ceremony_order_side_check;

-- 4) makeup_schedule: Add duration column (minutes per service)
ALTER TABLE makeup_schedule ADD COLUMN IF NOT EXISTS duration integer DEFAULT 45;

-- 5) makeup_schedule: Add hair_duration and makeup_duration for per-service durations
ALTER TABLE makeup_schedule ADD COLUMN IF NOT EXISTS hair_duration integer DEFAULT 45;
ALTER TABLE makeup_schedule ADD COLUMN IF NOT EXISTS makeup_duration integer DEFAULT 45;
