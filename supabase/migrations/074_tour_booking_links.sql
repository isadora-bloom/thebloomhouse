-- ---------------------------------------------------------------------------
-- 074_tour_booking_links.sql
-- ---------------------------------------------------------------------------
-- Phase 2 Task 14: per-venue Calendly (or equivalent) tour-booking links.
-- Consolidates two orphaned columns into one canonical, multi-link-capable
-- home on venue_ai_config.
--
-- Before this migration:
--   * venue_config.calendly_link (migration 001) — single text column. Read
--     by inquiry-brain.ts:104 and client-brain.ts:86 but never forwarded
--     to the Claude prompt. Effectively dark.
--   * venue_ai_config.tour_booking_link — single text column. Consumed by
--     personality-builder.ts:214 to render **Tour Booking Link:** in the
--     prompt header. Nothing writes to it. Always renders [NOT SET].
--   * lib/supabase/types.ts:35 references a venue_config.tour_booking_url
--     column that does not exist in the schema. Latent read-error bug in
--     src/app/api/public/sage-preview/route.ts:65.
--
-- After this migration:
--   * venue_ai_config.tour_booking_links jsonb — canonical column. Array
--     of objects { label, url, is_default }. Exactly one entry should
--     have is_default=true when the array is non-empty; the multi-link
--     UI enforces this. `tour_booking_link` is kept for back-compat with
--     pre-migration writes but new code reads tour_booking_links.
--
-- Multi-venue / multi-tour-type: venues with a weekday Calendly link AND a
-- weekend Calendly link can configure both with different labels. Sage
-- chooses the default for generic "book a tour" references and includes
-- the full labelled list when relevant.
--
-- Backfill order (first non-null wins):
--   1. venue_ai_config.tour_booking_link
--   2. venue_config.calendly_link
-- Either of these, when present, becomes a one-element array with
-- label='Book a tour' and is_default=true.
-- ---------------------------------------------------------------------------

ALTER TABLE public.venue_ai_config
  ADD COLUMN IF NOT EXISTS tour_booking_links jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.venue_ai_config.tour_booking_links IS
  'Array of tour-booking URLs. Shape: [{"label": "Weekday tour", "url": "https://calendly.com/venue/weekday", "is_default": true}]. Exactly one entry should have is_default=true when the array is non-empty. Sage uses the default for generic "book a tour" references and may list all when a couple asks about multiple tour types.';

-- ---------------------------------------------------------------------------
-- Backfill — merge legacy single-string columns into the new array shape.
-- Idempotent: only populates rows where tour_booking_links is still empty.
-- ---------------------------------------------------------------------------

UPDATE public.venue_ai_config AS ai
   SET tour_booking_links = jsonb_build_array(
         jsonb_build_object(
           'label', 'Book a tour',
           'url', ai.tour_booking_link,
           'is_default', true
         )
       )
 WHERE ai.tour_booking_link IS NOT NULL
   AND ai.tour_booking_link <> ''
   AND (ai.tour_booking_links IS NULL OR ai.tour_booking_links = '[]'::jsonb);

-- For venues where only venue_config.calendly_link was populated (the pre-
-- venue_ai_config pattern), lift it into tour_booking_links so Sage can
-- finally see it. The old calendly_link column stays in place so any
-- coordinator UI that still writes there doesn't regress silently.
UPDATE public.venue_ai_config AS ai
   SET tour_booking_links = jsonb_build_array(
         jsonb_build_object(
           'label', 'Book a tour',
           'url', cfg.calendly_link,
           'is_default', true
         )
       )
  FROM public.venue_config AS cfg
 WHERE cfg.venue_id = ai.venue_id
   AND cfg.calendly_link IS NOT NULL
   AND cfg.calendly_link <> ''
   AND (ai.tour_booking_links IS NULL OR ai.tour_booking_links = '[]'::jsonb);

COMMENT ON COLUMN public.venue_ai_config.tour_booking_link IS
  'DEPRECATED — use tour_booking_links. Kept for back-compat during migration 074. Writers should target tour_booking_links going forward; readers should prefer tour_booking_links and fall back to this.';
COMMENT ON COLUMN public.venue_config.calendly_link IS
  'DEPRECATED — use venue_ai_config.tour_booking_links. Kept for back-compat during migration 074.';

NOTIFY pgrst, 'reload schema';
