-- ============================================
-- 010: VENDOR PORTAL TOKENS
-- Adds self-service vendor portal columns to vendor_recommendations
-- Depends on: 004_portal_tables.sql
-- ============================================

ALTER TABLE vendor_recommendations
  ADD COLUMN IF NOT EXISTS portal_token text UNIQUE,
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS instagram_url text,
  ADD COLUMN IF NOT EXISTS facebook_url text,
  ADD COLUMN IF NOT EXISTS pricing_info text,
  ADD COLUMN IF NOT EXISTS special_offer text,
  ADD COLUMN IF NOT EXISTS offer_expires_at date,
  ADD COLUMN IF NOT EXISTS portfolio_photos text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_updated_by_vendor timestamptz;

CREATE INDEX IF NOT EXISTS idx_vendor_recommendations_portal_token ON vendor_recommendations(portal_token);
