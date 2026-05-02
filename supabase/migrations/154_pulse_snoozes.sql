-- Migration 154: pulse_snoozes — coordinator can snooze or dismiss
-- pulse items without mutating the underlying notification / anomaly /
-- insight rows (T4-C / Playbook Part 20.2).
--
-- Pre-fix /pulse aggregator returned every unread/unacked/new row;
-- coordinator had no way to say "I'll deal with this Monday" without
-- marking it read (which loses the surface-priority signal). pulse_snoozes
-- is the filter the aggregator subtracts — items snoozed past now() are
-- hidden until snoozed_until passes; dismissed items are hidden forever
-- unless explicitly un-dismissed.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.pulse_snoozes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,

  -- Composite item key from PulseItem.id ('notif:<uuid>' / 'anomaly:<uuid>'
  -- / 'insight:<uuid>'). Stored as the full string so the aggregator can
  -- filter without parsing.
  item_key text NOT NULL,

  -- Action taken.
  action text NOT NULL CHECK (action IN ('snoozed', 'dismissed')),

  -- For snoozed: when to re-surface. NULL when action='dismissed'.
  snoozed_until timestamptz,

  -- Optional reason / note for audit. Free text.
  reason text,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- One active snooze/dismiss per (venue, item_key). Coordinator
-- re-snoozing an item just updates the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pulse_snoozes_venue_item
  ON public.pulse_snoozes (venue_id, item_key);

CREATE INDEX IF NOT EXISTS idx_pulse_snoozes_until
  ON public.pulse_snoozes (venue_id, snoozed_until)
  WHERE action = 'snoozed';

COMMENT ON TABLE public.pulse_snoozes IS
  'Per-coordinator snooze/dismiss filter for /pulse items. The '
  'aggregator subtracts active snoozes (snoozed_until > now()) + '
  'all dismissals. Per Playbook 20.2 / T4-C.';

ALTER TABLE public.pulse_snoozes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ps_select" ON public.pulse_snoozes;
CREATE POLICY "ps_select" ON public.pulse_snoozes
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "ps_insert" ON public.pulse_snoozes;
CREATE POLICY "ps_insert" ON public.pulse_snoozes
  FOR INSERT TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "ps_update" ON public.pulse_snoozes;
CREATE POLICY "ps_update" ON public.pulse_snoozes
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "ps_delete" ON public.pulse_snoozes;
CREATE POLICY "ps_delete" ON public.pulse_snoozes
  FOR DELETE TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "ps_service" ON public.pulse_snoozes;
CREATE POLICY "ps_service" ON public.pulse_snoozes
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
