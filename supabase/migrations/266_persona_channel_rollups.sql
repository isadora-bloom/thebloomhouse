-- ---------------------------------------------------------------------------
-- 266_persona_channel_rollups.sql
-- ---------------------------------------------------------------------------
-- Wave 6B — persona × channel × revenue rollups.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 6 closes the forensic loop: ROI per
--     persona per channel reveals what aggregate-channel ROI hides)
--   - bloom-wave4-5-6-master-plan.md (6B: rollup table reading from
--     attribution_events.persona_overlay (mig 263) + marketing_spend_records
--     (mig 263) + weddings.booking_value (mig 181))
--   - bloom-phase-b-decisions.md (attribution_events is the source of truth
--     for first-touch — Wave 6B only READS, never modifies)
--   - feedback_parallel_stream_safety.md (Wave 6B holds migration 266;
--     Wave 5C holds 265 in parallel)
--
-- Why this migration exists
-- -------------------------
-- ROI per channel without persona overlay is a lie. "Knot brings 100 leads,
-- 5% convert" hides that "Knot brings 70% Cost-Conscious at 3% conversion +
-- 30% Heritage-Forward at 11% conversion." Wave 6B writes one row per cell
-- in the (channel × persona × time-window) matrix so the dashboard can
-- reveal the real story instead of the channel-aggregate fiction.
--
-- The cohort-size threshold (n ≥ 10) is enforced at write time via the
-- n_too_small flag — small cohorts get NULL'd numerics to prevent the
-- dashboard from rendering misleading "this channel has 22% conversion"
-- when the cell has 2 weddings.
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — persona_channel_rollups (one row per cell of the matrix)
-- ============================================================================
-- Cell key: (venue_id, channel, persona_label, time_window_start,
-- time_window_end). persona_label may be NULL when the cell rolls up
-- attributions that didn't have a persona overlay attached yet —
-- equivalent to "untagged" in the heatmap.

CREATE TABLE IF NOT EXISTS public.persona_channel_rollups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Free-text channel string. Mirrors the vocabulary used by Wave 6A's
  -- marketing_spend_records.channel + attribution_events.source_platform.
  -- Common values: google_ads | meta_ads | tiktok_ads | theknot_fee |
  -- weddingwire_fee | organic_seo | vendor_referral | other.
  channel text NOT NULL,

  -- Persona discovered by Wave 5A's couple_intel. NULL means "no persona
  -- overlay yet" — so a couple whose intel hasn't been derived rolls up
  -- under a single (channel, NULL) cell. Operator reads this as "we
  -- haven't tagged these yet" rather than as a persona name.
  persona_label text,

  time_window_start date NOT NULL,
  time_window_end date NOT NULL,

  -- Metrics. Cents on monetary fields to match the rest of the platform.
  spend_cents int NOT NULL DEFAULT 0,
  inquiries_count int NOT NULL DEFAULT 0,
  touring_count int NOT NULL DEFAULT 0,
  booked_count int NOT NULL DEFAULT 0,
  lost_count int NOT NULL DEFAULT 0,
  total_booked_value_cents int NOT NULL DEFAULT 0,

  -- Derived metrics. NULL when n_too_small=true so the dashboard never
  -- renders a misleading number. CAC is also NULL when booked_count=0.
  cac_cents int,
  conversion_pct numeric(5,2),
  avg_booking_value_cents int,
  ltv_cents int,
  roi_pct numeric(7,2),
  payback_months numeric(5,2),

  -- True when the cohort underlying this cell is < 10. Drives the
  -- "n < 10" gray-out in the heatmap. Reads from inquiries_count +
  -- booked_count totals.
  n_too_small boolean NOT NULL DEFAULT false,

  computed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.persona_channel_rollups IS
  'owner:intelligence. Wave 6B persona × channel × time-window rollup. One '
  'row per cell of the (venue, channel, persona_label, window) matrix. '
  'Point-in-time (NOT cumulative) — recompute REPLACES all numerics + '
  'computed_at. Read by /intel/marketing-roi heatmap + summary endpoints. '
  'Migration 266.';

COMMENT ON COLUMN public.persona_channel_rollups.persona_label IS
  'Persona discovered by Wave 5A couple_intel. NULL = no overlay attached '
  'yet (couples without derived intel roll up under one (channel, NULL) '
  'cell). Heatmap labels NULL cells "untagged" so operator sees the gap.';

COMMENT ON COLUMN public.persona_channel_rollups.cac_cents IS
  'Customer acquisition cost in cents. spend_cents / booked_count. NULL '
  'when n_too_small=true (cohort < 10) or booked_count=0.';

COMMENT ON COLUMN public.persona_channel_rollups.conversion_pct IS
  'Booked / inquiries as a percentage. NULL when n_too_small=true. The '
  'dashboard renders only n ≥ 10 cells as a number; smaller cells are '
  'grayed out so the operator never reads a 50% conversion rate from a '
  '2-wedding cohort.';

COMMENT ON COLUMN public.persona_channel_rollups.ltv_cents IS
  'Lifetime value placeholder. Wave 6B initial implementation defaults to '
  'avg_booking_value_cents (one-shot wedding). When repeat-event tracking '
  'lands later, this column upgrades to the full LTV calc.';

COMMENT ON COLUMN public.persona_channel_rollups.roi_pct IS
  'Return on spend as a percentage. (total_booked_value_cents - '
  'spend_cents) / spend_cents × 100. NULL when spend_cents=0 or '
  'n_too_small=true.';

COMMENT ON COLUMN public.persona_channel_rollups.payback_months IS
  'Months to recover the spend at the cell-level monthly revenue run rate. '
  'spend_cents / (total_booked_value_cents / months_in_window). NULL when '
  'spend or booked value is zero.';

COMMENT ON COLUMN public.persona_channel_rollups.n_too_small IS
  'True when (inquiries_count + booked_count) < 10. Drives the "n < 10" '
  'gray-out in the heatmap. Numeric fields are NULL when this flag is '
  'set so the UI cannot accidentally render a misleading percentage.';

-- Idempotent rollup: re-running for the same cell key REPLACES the
-- numerics + computed_at. Persona_label is part of the key but can be
-- NULL — the unique constraint uses COALESCE so the NULL case still
-- dedupes to one row per (venue, channel, '', window).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_persona_channel_rollups_cell
  ON public.persona_channel_rollups (
    venue_id,
    channel,
    COALESCE(persona_label, ''),
    time_window_start,
    time_window_end
  );

COMMENT ON INDEX public.uniq_persona_channel_rollups_cell IS
  'One row per (venue, channel, persona, window) cell. NULL persona_label '
  'collapses to '''' so the un-tagged bucket dedupes to one row per '
  '(channel, window).';

CREATE INDEX IF NOT EXISTS idx_persona_channel_rollups_venue_window
  ON public.persona_channel_rollups (venue_id, time_window_end DESC);

COMMENT ON INDEX public.idx_persona_channel_rollups_venue_window IS
  'Hot-path: "show me the latest rollup window for this venue" — the '
  'heatmap endpoint reads by venue + window range.';

CREATE INDEX IF NOT EXISTS idx_persona_channel_rollups_venue_channel
  ON public.persona_channel_rollups (venue_id, channel);

COMMENT ON INDEX public.idx_persona_channel_rollups_venue_channel IS
  'Per-channel summary card lookups: "for this venue, all rollup cells '
  'tagged channel=google_ads".';

CREATE INDEX IF NOT EXISTS idx_persona_channel_rollups_venue_persona
  ON public.persona_channel_rollups (venue_id, persona_label);

COMMENT ON INDEX public.idx_persona_channel_rollups_venue_persona IS
  'Per-persona aggregation: "all cells tagged persona=heritage_forward '
  'across channels for this venue".';

-- ============================================================================
-- STEP 2 — RLS (mirror marketing_spend_records pattern from mig 263)
-- ============================================================================
-- Authenticated users see their own venue's rows. Service-role bypasses
-- RLS for the rollup writer + sweep cron + admin endpoints. No anon
-- access — internal ops surface only.

ALTER TABLE public.persona_channel_rollups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "persona_channel_rollups_auth_select"
  ON public.persona_channel_rollups;
CREATE POLICY "persona_channel_rollups_auth_select"
  ON public.persona_channel_rollups
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

-- Insert / update are reserved for service-role (the rollup writer is
-- the only legitimate writer). We don't grant authenticated INSERT
-- because no UI ever needs to write rows directly. Mirroring 263's
-- shape only as far as helpful — leaving inserts to service-role keeps
-- the cell-key invariants safe.
DROP POLICY IF EXISTS "persona_channel_rollups_auth_insert"
  ON public.persona_channel_rollups;
CREATE POLICY "persona_channel_rollups_auth_insert"
  ON public.persona_channel_rollups
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "persona_channel_rollups_auth_update"
  ON public.persona_channel_rollups;
CREATE POLICY "persona_channel_rollups_auth_update"
  ON public.persona_channel_rollups
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "persona_channel_rollups_auth_delete"
  ON public.persona_channel_rollups;
CREATE POLICY "persona_channel_rollups_auth_delete"
  ON public.persona_channel_rollups
  FOR DELETE
  TO authenticated
  USING (false);

COMMIT;

NOTIFY pgrst, 'reload schema';
