-- ---------------------------------------------------------------------------
-- 354_interactions_rfc2822_headers.sql
-- ---------------------------------------------------------------------------
-- Silent-field-drop sweep, email path. processIncomingEmail reads the
-- inbound email's RFC-2822 headers during classification (form-relay
-- detection, machine-generated detection) and then discards them —
-- cc / bcc / reply-to / List-Unsubscribe / DKIM never landed anywhere.
--
-- This adds one jsonb column. The pipeline now stores the full
-- header set on the interaction, so:
--   - cc / bcc recipients are recoverable (forwarded-group inquiries)
--   - reply-to is preserved
--   - DKIM / Authentication-Results survive for retroactive
--     reputation / bounce-class analysis
--   - a future classifier can re-read headers without a re-fetch
--
-- Same raw-preservation principle as raw_import_row (351/352) and the
-- couple-portal extra_fields (353): keep the whole thing in jsonb so
-- nothing the channel delivered is lost.
--
-- Rerun safety: ADD COLUMN IF NOT EXISTS.
-- ---------------------------------------------------------------------------

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS rfc2822_headers jsonb;

COMMENT ON COLUMN public.interactions.rfc2822_headers IS
  'Full RFC-2822 header set captured at email fetch time (lowercase-keyed). '
  'Preserves cc / bcc / reply-to / List-Unsubscribe / DKIM that were '
  'previously read once for classification and then dropped.';
