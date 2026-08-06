-- 389: couple-facing notifications
--
-- Rixey gave couples a notification bell (new messages, planning reminders) with
-- unread state. Bloom couples had nothing — they only learned of a venue reply by
-- opening the messages section. This wedding-scoped feed backs a bell in the
-- couple top bar. Producers call createCoupleNotification (lib/services).

CREATE TABLE IF NOT EXISTS couple_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_couple_notifications_wedding
  ON couple_notifications (wedding_id, read, created_at DESC);

COMMENT ON TABLE couple_notifications IS
  'Couple-facing notification feed (per wedding). Backs the bell in the couple top bar. type e.g. new_message / planning_reminder; link is a relative couple-portal path.';

-- ---------------------------------------------------------------------------
-- Venue isolation (gap G17). The first cut of this migration shipped the table
-- with a venue_id column, no ENABLE RLS and no policy, which the ratchet in
-- scripts/check-rls-on-venue-id.mjs caught as a regression (1 -> 2 gaps).
-- Canonical policy set, copied from the prod-proven 377/383 pattern.
--
-- Every read and write of this table goes through the service key
-- (src/app/api/couple/notifications/route.ts uses createServiceClient and
-- filters on venue_id + wedding_id from getCoupleAuth), so the service_role
-- policy is what keeps the bell working. The authenticated policies exist so
-- that a future direct-from-client read cannot cross a venue boundary.
-- ---------------------------------------------------------------------------

ALTER TABLE public.couple_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple_notifications_select" ON public.couple_notifications;
CREATE POLICY "couple_notifications_select" ON public.couple_notifications
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "couple_notifications_modify" ON public.couple_notifications;
CREATE POLICY "couple_notifications_modify" ON public.couple_notifications
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "couple_notifications_service" ON public.couple_notifications;
CREATE POLICY "couple_notifications_service" ON public.couple_notifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_couple_notifications" ON public.couple_notifications;
CREATE POLICY "demo_anon_select_couple_notifications" ON public.couple_notifications
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));
