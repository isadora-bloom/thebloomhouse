-- ---------------------------------------------------------------------------
-- 356_tangential_storefront_signal_types.sql
-- ---------------------------------------------------------------------------
-- Universal-importer follow-up (2026-05-15).
--
-- The storefront-activity adapter (The Knot / WeddingWire funnel
-- exports) and the site-visitors adapter (website pixel exports) both
-- write to tangential_signals. The storefront adapter records the
-- discovery funnel as discrete signal types so the views -> saves ->
-- messages rollup can group by signal_type without re-parsing the
-- action string.
--
-- The original tangential_signals.signal_type CHECK (migration 085)
-- only allowed: instagram_engagement, instagram_follow, website_visit,
-- review, mention, analytics_entry, referral, other. The new adapters
-- need the storefront funnel values too.
--
-- This migration drops the old CHECK and recreates it with the
-- storefront funnel values added. Existing rows are unaffected - every
-- previously-allowed value is still allowed.
--
-- New values:
--   storefront_view     - couple viewed the venue's marketplace page
--   storefront_save     - couple saved the venue
--   storefront_message  - couple sent a message via the storefront
--                         (a real inquiry - strongest funnel signal)
--   storefront_click    - couple clicked through to the venue's site
--   storefront_call     - couple called the venue from the storefront
-- ---------------------------------------------------------------------------

ALTER TABLE public.tangential_signals
  DROP CONSTRAINT IF EXISTS tangential_signals_signal_type_check;

ALTER TABLE public.tangential_signals
  ADD CONSTRAINT tangential_signals_signal_type_check
  CHECK (signal_type IN (
    -- Pre-existing values (migration 085).
    'instagram_engagement',
    'instagram_follow',
    'website_visit',
    'review',
    'mention',
    'analytics_entry',
    'referral',
    'other',
    -- Storefront-activity funnel values (migration 356).
    'storefront_view',
    'storefront_save',
    'storefront_message',
    'storefront_click',
    'storefront_call'
  ));

COMMENT ON COLUMN public.tangential_signals.signal_type IS
  'Kind of tangential signal. Migration 356 added the storefront_* funnel values used by the storefront-activity adapter (The Knot / WeddingWire discovery-funnel exports). storefront_message is a real inquiry; storefront_view / storefront_save are earlier-funnel touchpoints.';

NOTIFY pgrst, 'reload schema';
