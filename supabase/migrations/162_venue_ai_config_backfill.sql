-- Migration 162: T5-β.1 — venue_ai_config.ai_name backfill.
--
-- Closes a brand-leak in the legacy data: any venue created before the
-- T5-β white-label sweep could end up with venue_ai_config.ai_name
-- NULL (or no row at all). The brain layer now requires ai_name and
-- throws when missing — this migration ensures the live tables don't
-- trigger that error for any pre-existing venue.
--
-- Strategy:
--   1. INSERT a venue_ai_config row for every venue that lacks one,
--      seeding ai_name as `<venue.name> Concierge`. ON CONFLICT DO
--      NOTHING so re-running is safe.
--   2. UPDATE existing rows where ai_name IS NULL or empty, setting
--      ai_name = `<venue.name> Concierge`. Coordinators can rename via
--      /settings/personality afterwards — the goal here is to stop the
--      "Sage" silent-default from ever being needed.
--
-- Idempotent: safe to run multiple times. Only touches rows where
-- ai_name is currently null/empty so a venue that has already named
-- their AI is never overwritten.

-- 1. Insert missing venue_ai_config rows.
INSERT INTO public.venue_ai_config (venue_id, ai_name, updated_at)
SELECT v.id,
       trim(coalesce(v.name, 'Venue')) || ' Concierge',
       NOW()
  FROM public.venues v
  LEFT JOIN public.venue_ai_config c ON c.venue_id = v.id
 WHERE c.venue_id IS NULL
ON CONFLICT (venue_id) DO NOTHING;

-- 2. Backfill ai_name for existing rows where it's null/empty.
UPDATE public.venue_ai_config c
   SET ai_name = trim(coalesce(v.name, 'Venue')) || ' Concierge',
       updated_at = NOW()
  FROM public.venues v
 WHERE c.venue_id = v.id
   AND (c.ai_name IS NULL OR trim(c.ai_name) = '');

-- Sanity: confirm no venue is left without an ai_name. This is a
-- belt-and-braces assertion; if the SELECT returns rows the migration
-- still committed (we don't want to roll back a partial fix), but the
-- log line is enough to surface the issue.
DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT COUNT(*)
    INTO missing_count
    FROM public.venues v
    LEFT JOIN public.venue_ai_config c ON c.venue_id = v.id
   WHERE c.ai_name IS NULL OR trim(c.ai_name) = '';

  IF missing_count > 0 THEN
    RAISE NOTICE
      '[162] % venue(s) still lack venue_ai_config.ai_name after backfill — investigate.',
      missing_count;
  END IF;
END $$;
