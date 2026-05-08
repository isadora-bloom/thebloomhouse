-- ============================================================================
-- 234_venue_groups_hierarchy.sql
-- Tier-C #133 (2026-05-08). Multi-venue enterprise hierarchy.
--
-- Today: venue_groups is a flat collection (org → group → venues). For
-- multi-region operators with their own corporate org structure
-- (Wedgewood-tier customers), one level isn't enough — they think in
-- Region → District → Venue. /intel/regions exists but groups by
-- venues.state which is a different (geographic) model.
--
-- Fix:
--   1. parent_group_id allows venue_groups to nest. NULL = top-level.
--   2. group_kind labels the level so the UI can render correctly
--      ('region' / 'district' / 'cluster' / 'custom').
--   3. Cycle-prevention trigger blocks A→B→A loops at write time.
--   4. Depth cap of 4 prevents pathological hierarchies.
--
-- Backwards-compatible: existing flat groups stay valid (parent_group_id
-- defaults NULL, group_kind defaults 'custom'). No downstream code change
-- required to keep working; new code can opt into hierarchy.
-- ============================================================================

ALTER TABLE public.venue_groups
  ADD COLUMN IF NOT EXISTS parent_group_id uuid
    REFERENCES public.venue_groups(id) ON DELETE SET NULL;

ALTER TABLE public.venue_groups
  ADD COLUMN IF NOT EXISTS group_kind text NOT NULL DEFAULT 'custom';

-- Add CHECK only if it doesn't already exist (idempotent re-run safety).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_schema = 'public'
       AND constraint_name = 'venue_groups_kind_chk'
  ) THEN
    ALTER TABLE public.venue_groups
      ADD CONSTRAINT venue_groups_kind_chk
      CHECK (group_kind IN ('region', 'district', 'cluster', 'custom'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_venue_groups_parent
  ON public.venue_groups (parent_group_id)
  WHERE parent_group_id IS NOT NULL;

COMMENT ON COLUMN public.venue_groups.parent_group_id IS
  'Optional parent group for hierarchical structures (Region → District → Venue). NULL = top-level. Cycle and depth enforced by trg_venue_groups_validate_hierarchy.';

COMMENT ON COLUMN public.venue_groups.group_kind IS
  'Group level label: region (top corporate division), district (mid), cluster (operational grouping), custom (free-form). The UI uses this to render correct breadcrumbs.';

-- ===========================================================================
-- Cycle + depth validator. Runs on INSERT + UPDATE of parent_group_id.
-- Walks up the parent chain; if it hits the row being updated → cycle.
-- If it walks more than 4 hops without reaching a NULL parent → too deep.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.venue_groups_validate_hierarchy()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cursor_id uuid := NEW.parent_group_id;
  hops integer := 0;
  max_depth constant integer := 4;
BEGIN
  IF NEW.parent_group_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_group_id = NEW.id THEN
    RAISE EXCEPTION 'venue_groups: a group cannot be its own parent (id=%)', NEW.id;
  END IF;

  WHILE cursor_id IS NOT NULL AND hops <= max_depth LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'venue_groups: parent chain forms a cycle through id=%', NEW.id;
    END IF;
    SELECT parent_group_id INTO cursor_id
      FROM public.venue_groups
     WHERE id = cursor_id;
    hops := hops + 1;
  END LOOP;

  IF hops > max_depth THEN
    RAISE EXCEPTION 'venue_groups: hierarchy depth exceeds % (would be % hops from root)', max_depth, hops;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_venue_groups_validate_hierarchy ON public.venue_groups;
CREATE TRIGGER trg_venue_groups_validate_hierarchy
  BEFORE INSERT OR UPDATE OF parent_group_id ON public.venue_groups
  FOR EACH ROW
  EXECUTE FUNCTION public.venue_groups_validate_hierarchy();

COMMENT ON FUNCTION public.venue_groups_validate_hierarchy() IS
  'Tier-C #133: prevents cycles in venue_groups.parent_group_id and caps hierarchy depth at 4 levels. Fires on INSERT + UPDATE of parent_group_id.';
