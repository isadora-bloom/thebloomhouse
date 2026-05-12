-- ---------------------------------------------------------------------------
-- 326_discovery_source_sync.sql
-- ---------------------------------------------------------------------------
-- Bug 2 from Sophie Thomas RM-1040 trace: Calendly Q&A "Where did you
-- first hear about us?" → "ChatGPT" gets captured into discovery_sources
-- with canonical_source='ai_tool', but weddings.source is never updated
-- so the lead-detail header / source-rendering surfaces all show "Other".
--
-- The sync gap is structural: discovery_sources is the Wave 15
-- forensic-evidence table, weddings.source is the legacy column most
-- readers still use. They were never wired together. The Sonnet
-- reconstruct judge reads discovery_sources, but no one back-syncs the
-- canonical_source to the wedding column.
--
-- This migration:
--   1. AFTER INSERT trigger on discovery_sources — when canonical_source
--      is a meaningful value (not 'unknown' / 'other') AND wedding_id
--      is set AND weddings.source is currently null / 'other' / 'direct'
--      / 'unknown', UPDATE weddings.source to the canonical_source.
--   2. One-time retro-sync that runs the same logic against every
--      historical discovery_sources row. Closes the data gap on every
--      existing Rixey lead before the trigger starts catching new ones.
--
-- Source priority: we never overwrite a non-null non-default source.
-- The trigger only fills the gap; it doesn't overrule an existing
-- attribution (Knot relay first-touch wins over a stated "I found you
-- on Google" — first-touch attribution lives in attribution_events,
-- not weddings.source).
--
-- Idempotent. No BEGIN/COMMIT (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- 1. Trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_discovery_to_wedding_source()
RETURNS TRIGGER AS $$
DECLARE
  current_source text;
BEGIN
  -- Only sync canonical sources that map to a real attribution channel.
  -- 'unknown' = answer empty/unparseable. 'other' = answer present but
  -- unrecognised. Neither is more informative than the wedding's
  -- existing default; skip.
  IF NEW.canonical_source IS NULL OR NEW.canonical_source IN ('unknown', 'other') THEN
    RETURN NEW;
  END IF;
  IF NEW.wedding_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Read the wedding's current source. Only fill when it's null or a
  -- low-information default. Never overwrite a stated platform source
  -- (Knot / WW / Instagram / etc.) — those carry first-touch weight.
  SELECT source INTO current_source FROM public.weddings WHERE id = NEW.wedding_id;

  IF current_source IS NULL
     OR current_source IN ('other', 'direct', 'unknown', '')
  THEN
    UPDATE public.weddings
       SET source = NEW.canonical_source,
           updated_at = now()
     WHERE id = NEW.wedding_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_discovery_sync_wedding_source ON public.discovery_sources;
CREATE TRIGGER trg_discovery_sync_wedding_source
  AFTER INSERT ON public.discovery_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_discovery_to_wedding_source();

-- ============================================================================
-- 2. One-time retro-sync of historical rows
-- ============================================================================
-- For every wedding whose source is null/'other'/'direct'/'unknown' AND
-- has at least one matching discovery_sources row, fill weddings.source
-- from the EARLIEST captured discovery_source (the first time the
-- couple stated where they came from).

UPDATE public.weddings w
SET source = sub.canonical_source,
    updated_at = now()
FROM (
  SELECT DISTINCT ON (wedding_id)
    wedding_id,
    canonical_source
  FROM public.discovery_sources
  WHERE wedding_id IS NOT NULL
    AND canonical_source IS NOT NULL
    AND canonical_source NOT IN ('unknown', 'other')
  ORDER BY wedding_id, captured_at ASC
) sub
WHERE w.id = sub.wedding_id
  AND (w.source IS NULL OR w.source IN ('other', 'direct', 'unknown', ''));

NOTIFY pgrst, 'reload schema';
