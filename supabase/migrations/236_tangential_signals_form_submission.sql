-- ============================================================================
-- 236_tangential_signals_form_submission.sql
-- Tier-D #171 fix (2026-05-08). Real drift caught during data-gathering sweep.
--
-- src/lib/services/crm-import/web-form.ts:880 has been writing
-- signal_type='form_submission' but mig 085's CHECK constraint only
-- admits {instagram_engagement, instagram_follow, website_visit,
-- review, mention, analytics_entry, referral, other}. Every web-form
-- import row therefore returned a 23514 CHECK violation. The wrapper
-- doesn't flip ok=false on tangential errors ("auxiliary funnel-
-- analytics data, not lead state") so the failure was silent — the
-- whole web-form attribution channel sat dark.
--
-- Fix: add form_submission to the CHECK. It's a meaningful classifier
-- (couple-side action vs discovery touch) — the tangential model
-- already distinguishes signal_class = source vs touchpoint, and
-- 'form_submission' deserves to ride alongside 'review' in the enum.
--
-- Idempotent. Drops + re-adds the constraint with the wider list.
-- ============================================================================

ALTER TABLE public.tangential_signals
  DROP CONSTRAINT IF EXISTS tangential_signals_signal_type_check;

ALTER TABLE public.tangential_signals
  ADD CONSTRAINT tangential_signals_signal_type_check
  CHECK (signal_type IN (
    'instagram_engagement',
    'instagram_follow',
    'website_visit',
    'review',
    'mention',
    'analytics_entry',
    'referral',
    'form_submission',
    'other'
  ));

COMMENT ON CONSTRAINT tangential_signals_signal_type_check
  ON public.tangential_signals IS
  'Allowed signal types. form_submission added 2026-05-08 (Tier-D #171) — was being written by web-form.ts and silently failing CHECK. When new writer paths land, extend this list rather than letting writes fall back to "other".';
