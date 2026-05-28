-- ============================================================================
-- 373: WEDDING_PRIORITIES (coordinator-flagged "work on this next")
--
-- 2026-05-26. Pairs with the sidebar "Now" star added in the same
-- sweep. The time-aware default suggests 1-3 items based on
-- days-until-wedding; coordinators can override per-couple by pinning
-- specific sections. The couple sees the override star in place of
-- the time-aware one, with a "Coordinator priority" tooltip.
--
-- Schema choices:
--   - `section_slug` is free text (matches the sidebar nav slug like
--     'budget' / 'contracts' / 'table-map'). No FK because slugs live
--     in a TS const, and venues will get custom sections later.
--   - `sort_order` integer lets coordinators rank priorities so the
--     UI can show the most-urgent first. Default 0 means "no explicit
--     order; render alphabetically".
--   - `note` optional free text — coordinator can write context for
--     the couple ("Contract is due Friday, need it signed before
--     final-walkthrough"). Surfaced in the sidebar tooltip.
--   - Unique on (wedding_id, section_slug) so re-flagging the same
--     section just updates the existing row.
--
-- Writes go through the coordinator-side API (service-client). Couples
-- only READ — no couple_insert/update/delete policy. Defence in depth:
-- couples can't escalate by flagging their own priorities.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.wedding_priorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  section_slug text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  note text,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wedding_id, section_slug)
);

COMMENT ON TABLE public.wedding_priorities IS 'owner:portal';
COMMENT ON COLUMN public.wedding_priorities.section_slug IS
  'Sidebar nav slug (e.g. budget / contracts / table-map). Free text — sidebar matches against PORTAL_SECTIONS registry on the client.';
COMMENT ON COLUMN public.wedding_priorities.note IS
  'Optional context the coordinator wants the couple to see, surfaced in the sidebar tooltip / Now-star hover.';

CREATE INDEX IF NOT EXISTS idx_wedding_priorities_wedding
  ON public.wedding_priorities(wedding_id, sort_order);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

ALTER TABLE public.wedding_priorities ENABLE ROW LEVEL SECURITY;

-- Couples can READ their own priorities. The sidebar reads via the
-- browser client; this policy keeps that read scoped.
DROP POLICY IF EXISTS "couple_read" ON public.wedding_priorities;
CREATE POLICY "couple_read" ON public.wedding_priorities
  FOR SELECT TO authenticated
  USING (wedding_id = public.couple_user_wedding_id());

-- Coordinator-side reads: gated through the venue scope. Matches the
-- pattern from mig 006's venue_isolation (couples never hit this
-- predicate because their couple_user_wedding_id() check above already
-- granted access).
DROP POLICY IF EXISTS "staff_read" ON public.wedding_priorities;
CREATE POLICY "staff_read" ON public.wedding_priorities
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
       WHERE id = auth.uid()
         AND venue_id = wedding_priorities.venue_id
         AND role IN ('coordinator', 'org_admin', 'super_admin')
    )
  );

-- Writes go through the service-client only (coordinator API routes).
-- No couple write policies — couples cannot self-flag priorities.

NOTIFY pgrst, 'reload schema';
