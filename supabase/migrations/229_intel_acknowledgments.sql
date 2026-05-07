-- ============================================================================
-- 229: INTEL_ACKNOWLEDGMENTS (Tier-B #64A)
--
-- Generic suppression table for intel "insight" surfaces that don't have
-- their own backing row (anomaly_alerts already carries an acknowledged
-- flag and isn't covered here). Many intel pages — forecasts, capacity,
-- sources/parity, market-pulse, source-quality scorecards — render
-- coordinator-facing cards like "Tour cancellation rate is 34% this
-- month" with no way to mark them as seen. The card re-appears next
-- week / next page-view; coordinator reads it again and does nothing.
--
-- Mechanics:
--   - Each renderable insight has a stable (kind, key) pair. kind is
--     the surface name ("forecasts.q3_dropoff" or "market_pulse.cpi_spike"),
--     key is whatever uniquely identifies THIS instance ("2026-08" for a
--     month-bucket, or the hash of the underlying input window).
--   - When a coordinator clicks "Got it" the row inserts (or updates).
--   - Render paths LEFT JOIN this table and filter out rows where
--     suppress_until > NOW().
--   - Default suppress window: 7 days. Coordinator can extend per-row
--     via the API later.
--
-- Out of scope:
--   - Per-venue defaults for the suppress window (could ship if 7d
--     turns out to be the wrong shape; defer until coordinator feedback).
--   - "Wrong" verdict tracking. Today this is binary (seen/unseen);
--     accuracy feedback lives separately in shadow-decisions for now.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intel_acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  insight_kind text NOT NULL,
  insight_key text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  suppress_until timestamptz NOT NULL DEFAULT now() + interval '7 days',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, insight_kind, insight_key)
);

CREATE INDEX IF NOT EXISTS idx_intel_acks_venue_active
  ON public.intel_acknowledgments(venue_id, suppress_until DESC);

COMMENT ON TABLE public.intel_acknowledgments IS
  'Coordinator suppression of display-only intel insights (forecasts, capacity, sources/parity, market-pulse, source-quality, etc). Keyed on a (venue_id, insight_kind, insight_key) tuple. Render paths filter out rows where suppress_until > NOW(). Tier-B #64A.';

COMMENT ON COLUMN public.intel_acknowledgments.insight_kind IS
  'Surface identifier, e.g. "forecasts.q3_dropoff" or "market_pulse.cpi_spike". Stable across deployments; treat as an enum without a CHECK constraint so adding new surfaces does not require a migration.';

COMMENT ON COLUMN public.intel_acknowledgments.insight_key IS
  'Per-instance identifier within the kind. Examples: "2026-08" for a month-bucket, FNV-1a hash of input data for content-bound insights, or a row id when the insight maps 1:1 to another table. Together with kind makes a stable suppression target.';

COMMENT ON COLUMN public.intel_acknowledgments.suppress_until IS
  'Insight is hidden from rendering until this timestamp passes. Default 7 days from acknowledgment. Coordinator can clear (DELETE) or extend via the API.';

-- ============================================================================
-- RLS — venue-scoped reads/writes for coordinators; service-role bypass.
-- ============================================================================

ALTER TABLE public.intel_acknowledgments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_isolation" ON public.intel_acknowledgments;
CREATE POLICY "venue_isolation" ON public.intel_acknowledgments
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "super_admin_bypass" ON public.intel_acknowledgments;
CREATE POLICY "super_admin_bypass" ON public.intel_acknowledgments
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

NOTIFY pgrst, 'reload schema';
