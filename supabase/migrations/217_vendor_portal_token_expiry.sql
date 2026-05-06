-- ============================================
-- 217_vendor_portal_token_expiry.sql
-- ============================================
--
-- Adds optional token expiry columns to vendor_recommendations and
-- booked_vendors so leaked / stale vendor portal links can be aged
-- out. Per 2026-05-06 audit Lens 8: "/api/public/vendor-portal token-
-- only, no rate limit, no expiry. portal_token is 16 random bytes hex
-- (entropy fine); revocation is by null-ing portal_token."
--
-- Schema decision: NULL expires_at = no expiry (backward-compatible
-- with every token issued before this migration). New tokens issued
-- via coordinator UI populate both columns. The /api/public/vendor-
-- portal route reads expires_at and rejects if it's set AND past.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================

ALTER TABLE public.vendor_recommendations
  ADD COLUMN IF NOT EXISTS portal_token_issued_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS portal_token_expires_at timestamptz NULL;

COMMENT ON COLUMN public.vendor_recommendations.portal_token_issued_at IS
  'When the current portal_token was issued. NULL on rows that predate '
  'migration 217 — those tokens never expire automatically. Coordinator '
  're-issue stamps both this and portal_token_expires_at.';

COMMENT ON COLUMN public.vendor_recommendations.portal_token_expires_at IS
  'Optional auto-expiry. NULL means token never expires. The /api/public/'
  'vendor-portal route rejects tokens whose expires_at is non-null and '
  'in the past. Default policy from coordinator UI: 12 months from issue.';

ALTER TABLE public.booked_vendors
  ADD COLUMN IF NOT EXISTS portal_token_issued_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS portal_token_expires_at timestamptz NULL;

COMMENT ON COLUMN public.booked_vendors.portal_token_issued_at IS
  'See vendor_recommendations.portal_token_issued_at.';

COMMENT ON COLUMN public.booked_vendors.portal_token_expires_at IS
  'See vendor_recommendations.portal_token_expires_at.';

-- Index supports the per-token lookup-with-expiry-check the route runs
-- on every request. Partial index (NOT NULL) keeps it small — the
-- common case is no-expiry rows we don't need to scan.
CREATE INDEX IF NOT EXISTS idx_vendor_recommendations_portal_token_expiry
  ON public.vendor_recommendations(portal_token_expires_at)
  WHERE portal_token_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_booked_vendors_portal_token_expiry
  ON public.booked_vendors(portal_token_expires_at)
  WHERE portal_token_expires_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';
