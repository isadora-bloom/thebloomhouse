-- 413: venue_config token columns are not readable by authenticated either
--
-- Migration 411 STEP 4c revoked the three token columns (gmail_tokens,
-- calendly_tokens, omi_webhook_token) from anon and regranted the rest by
-- name. It left authenticated with table-level SELECT, so a logged-in browser
-- could still read its own venue's Gmail refresh token, Calendly token and
-- OMI webhook token. Found by scripts/check-live-policies.mjs after 411
-- ran on production (2026-09-15). Same shape as 411: revoke all, regrant the
-- non-secret columns by name. The service role is unaffected.
--
-- Code side (same commit): src/app/(platform)/settings/page.tsx no longer
-- does select('*') on this table.

DO $venue_config_auth_cols$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'venue_config'
     AND column_name NOT IN ('gmail_tokens', 'calendly_tokens', 'omi_webhook_token')
     AND column_name !~ '(token|secret|password|api_key)';

  IF v_cols IS NULL THEN
    RAISE WARNING '413: venue_config has no grantable columns, skipping';
    RETURN;
  END IF;

  EXECUTE 'REVOKE SELECT ON public.venue_config FROM authenticated';
  EXECUTE format('GRANT SELECT (%s) ON public.venue_config TO authenticated', v_cols);
END
$venue_config_auth_cols$;

COMMENT ON COLUMN public.venue_config.gmail_tokens IS
  'Service role only since 413 (2026-09-15). Never selected by anon or authenticated.';
