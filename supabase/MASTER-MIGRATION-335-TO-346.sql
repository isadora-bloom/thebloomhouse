-- ===========================================================================
-- MASTER MIGRATION 335 → 346
-- ---------------------------------------------------------------------------
-- One file you can paste into the Supabase SQL editor as-is.
--
-- This bundles migrations 335 (crm_import_rows), 336-345 (the backlog
-- that hit errors when run individually), and 346 (Identity-First
-- Phase A). Every statement is idempotent. Re-running is a no-op.
--
-- Why this exists
-- ---------------
-- Running 336-345 standalone hit "lots of errors" — likely a mix of
-- search_path resolution and partial-state from earlier attempts.
-- This master file:
--   1. Sets search_path explicitly so unqualified references resolve.
--   2. Schema-qualifies every reference (public.X) so even if search_
--      path is overridden by the editor, names resolve correctly.
--   3. Uses IF NOT EXISTS / IF EXISTS / DROP IF EXISTS throughout, so
--      partial-state from prior runs doesn't crash this one.
--
-- How to run
-- ----------
-- 1. Open https://supabase.com/dashboard/project/jsxxgwprxuqgcauzlxcb
-- 2. SQL Editor → New Query
-- 3. Paste this entire file → Run
-- 4. After it completes, run scripts/phase-a-acceptance.sql separately
--    to verify Phase A landed cleanly.
--
-- Anchor docs
-- -----------
-- - IDENTITY-FIRST-ARCHITECTURE.md (Phase A doctrine)
-- - supabase/migrations/335_crm_import_rows.sql through 346_identity_*
--   (the per-migration originals; this master is byte-equivalent to
--   their union with schema-qualification applied uniformly)
-- ===========================================================================

-- Make absolutely sure unqualified names resolve to public + extensions.
-- The Supabase SQL editor occasionally runs with a narrower search_path.
SET search_path = public, extensions, pg_catalog;


-- ===========================================================================
-- SECTION 335: crm_import_rows
-- ---------------------------------------------------------------------------
-- Recurring CSV import dedup layer. Already idempotent in the original.
-- Included here as belt-and-suspenders in case the user's "335 was the
-- last successful one" turned out to be partial.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.crm_import_rows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  source              text NOT NULL CHECK (length(source) <= 32),
  row_fingerprint     text NOT NULL CHECK (length(row_fingerprint) = 64),
  content_hash        text NOT NULL CHECK (length(content_hash) = 64),
  row_data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_history       jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  resolved_wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  resolution          text NOT NULL DEFAULT 'flagged' CHECK (resolution IN (
    'attached_strong','attached_medium','flagged','minted_new','rejected'
  )),
  resolution_reason   text,
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at         timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_import_rows_fingerprint
  ON public.crm_import_rows (venue_id, source, row_fingerprint);

CREATE INDEX IF NOT EXISTS ix_crm_import_rows_flagged
  ON public.crm_import_rows (venue_id, resolution, last_seen_at DESC)
  WHERE resolution = 'flagged';

CREATE INDEX IF NOT EXISTS ix_crm_import_rows_venue_wedding
  ON public.crm_import_rows (venue_id, resolved_wedding_id)
  WHERE resolved_wedding_id IS NOT NULL;

ALTER TABLE public.crm_import_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_import_rows_select" ON public.crm_import_rows;
CREATE POLICY "crm_import_rows_select" ON public.crm_import_rows
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

DROP POLICY IF EXISTS "crm_import_rows_modify" ON public.crm_import_rows;
CREATE POLICY "crm_import_rows_modify" ON public.crm_import_rows
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

DROP POLICY IF EXISTS "crm_import_rows_service" ON public.crm_import_rows;
CREATE POLICY "crm_import_rows_service" ON public.crm_import_rows
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_crm_import_rows" ON public.crm_import_rows;
CREATE POLICY "demo_anon_select_crm_import_rows" ON public.crm_import_rows
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));


-- ===========================================================================
-- SECTION 336: pattern_a_uniqueness
-- ---------------------------------------------------------------------------
-- Adds tombstoned_at + signal_id + narrative_cache_busted_at, backfills,
-- dedups, creates partial unique indexes, and exposes _live views.
-- ===========================================================================

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz;

COMMENT ON COLUMN public.attribution_events.tombstoned_at IS
  'Soft-tombstone marker for Pattern A dedup. Distinct from reverted_at.';

ALTER TABLE public.wedding_touchpoints
  ADD COLUMN IF NOT EXISTS signal_id uuid;

COMMENT ON COLUMN public.wedding_touchpoints.signal_id IS
  'Denormalized from metadata.signal_id when this touchpoint came from a tangential_signal.';

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS narrative_cache_busted_at timestamptz;

COMMENT ON COLUMN public.weddings.narrative_cache_busted_at IS
  'Sage journey narrative invalidation marker. Set by mass mutations that change attribution truth.';

-- Backfill signal_id from metadata
UPDATE public.wedding_touchpoints
SET signal_id = (metadata->>'signal_id')::uuid
WHERE signal_id IS NULL
  AND metadata ? 'signal_id'
  AND (metadata->>'signal_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Dedup wedding_touchpoints duplicates by signal_id
WITH ranked AS (
  SELECT
    id, wedding_id, signal_id,
    ROW_NUMBER() OVER (
      PARTITION BY wedding_id, signal_id
      ORDER BY occurred_at ASC, created_at ASC, id ASC
    ) AS rn
  FROM public.wedding_touchpoints
  WHERE signal_id IS NOT NULL
)
UPDATE public.wedding_touchpoints wt
SET signal_id = NULL,
    metadata = wt.metadata
      || jsonb_build_object(
        'tombstoned_at_336', now()::text,
        'tombstoned_reason', 'pattern_a_dedup',
        'original_signal_id', wt.signal_id::text
      )
FROM ranked
WHERE wt.id = ranked.id AND ranked.rn > 1;

-- Dedup attribution_events
WITH ranked_attr AS (
  SELECT
    id, candidate_identity_id, wedding_id, signal_id,
    ROW_NUMBER() OVER (
      PARTITION BY candidate_identity_id, wedding_id, signal_id
      ORDER BY decided_at ASC, created_at ASC, id ASC
    ) AS rn
  FROM public.attribution_events
  WHERE signal_id IS NOT NULL
    AND reverted_at IS NULL
    AND tombstoned_at IS NULL
)
UPDATE public.attribution_events ae
SET tombstoned_at = now()
FROM ranked_attr
WHERE ae.id = ranked_attr.id AND ranked_attr.rn > 1;

-- Mark affected weddings' narrative cache stale
UPDATE public.weddings w
SET narrative_cache_busted_at = now()
WHERE w.id IN (
  SELECT DISTINCT wedding_id FROM public.attribution_events
  WHERE tombstoned_at IS NOT NULL
    AND tombstoned_at >= now() - interval '5 minutes'
)
OR w.id IN (
  SELECT DISTINCT wedding_id FROM public.wedding_touchpoints
  WHERE metadata->>'tombstoned_at_336' IS NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attribution_events_live
  ON public.attribution_events (venue_id, wedding_id)
  WHERE reverted_at IS NULL AND tombstoned_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_attribution_events_live_signal
  ON public.attribution_events (candidate_identity_id, wedding_id, signal_id)
  WHERE reverted_at IS NULL AND tombstoned_at IS NULL AND signal_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wedding_touchpoints_live_signal
  ON public.wedding_touchpoints (wedding_id, signal_id)
  WHERE signal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_weddings_narrative_cache_busted
  ON public.weddings (narrative_cache_busted_at)
  WHERE narrative_cache_busted_at IS NOT NULL;

CREATE OR REPLACE VIEW public.attribution_events_live AS
SELECT * FROM public.attribution_events
WHERE reverted_at IS NULL AND tombstoned_at IS NULL;

COMMENT ON VIEW public.attribution_events_live IS
  'Live attributions only. Filters reverted_at + tombstoned_at.';

CREATE OR REPLACE VIEW public.wedding_touchpoints_live AS
SELECT * FROM public.wedding_touchpoints
WHERE (metadata->>'tombstoned_at_336') IS NULL;

COMMENT ON VIEW public.wedding_touchpoints_live IS
  'Live touchpoints only. Filters rows tombstoned by mig 336.';


-- ===========================================================================
-- SECTION 337: client_match_queue RLS
-- ===========================================================================

DROP POLICY IF EXISTS venue_scope_select ON public.client_match_queue;
DROP POLICY IF EXISTS venue_scope_insert ON public.client_match_queue;
DROP POLICY IF EXISTS venue_scope_update ON public.client_match_queue;
DROP POLICY IF EXISTS venue_scope_delete ON public.client_match_queue;
DROP POLICY IF EXISTS super_admin_all ON public.client_match_queue;

CREATE POLICY venue_scope_select ON public.client_match_queue
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

CREATE POLICY venue_scope_update ON public.client_match_queue
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

CREATE POLICY venue_scope_insert ON public.client_match_queue
  FOR INSERT TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

CREATE POLICY super_admin_all ON public.client_match_queue
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());


-- ===========================================================================
-- SECTION 338: source_taxonomy
-- ---------------------------------------------------------------------------
-- Adds source_kind, conflict_resolution columns, deleted_reason,
-- match_eligibility_band_days, and backfills.
-- ===========================================================================

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS source_kind text;

-- Constraint added conditionally so a partial re-run doesn't crash.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'weddings'
      AND constraint_name = 'weddings_source_kind_check'
  ) THEN
    ALTER TABLE public.weddings
      ADD CONSTRAINT weddings_source_kind_check
      CHECK (source_kind IS NULL OR source_kind IN ('origin','destination','tool','unknown'));
  END IF;
END $$;

COMMENT ON COLUMN public.weddings.source_kind IS
  'Taxonomy: origin / destination / tool / unknown.';

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS conflict_resolution_state text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'attribution_events'
      AND constraint_name = 'attribution_events_resolution_check'
  ) THEN
    ALTER TABLE public.attribution_events
      ADD CONSTRAINT attribution_events_resolution_check
      CHECK (
        conflict_resolution_state IS NULL
        OR conflict_resolution_state IN (
          'auto_resolved_destination','auto_resolved_low_information',
          'auto_resolved_high_confidence','manual_resolved'
        )
      );
  END IF;
END $$;

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS conflict_resolved_at timestamptz;

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS conflict_resolved_by text;

-- Backfill source_kind
UPDATE public.weddings
SET source_kind = 'destination'
WHERE source_kind IS NULL
  AND LOWER(source) IN (
    'honeybook','calendly','acuity','dubsado','aisle_planner',
    'aisleplanner','tave','tave_studio','tavestudio'
  );

UPDATE public.weddings
SET source_kind = 'tool'
WHERE source_kind IS NULL
  AND LOWER(source) IN ('zapier','ifttt','formstack','integromat','make');

UPDATE public.weddings
SET source_kind = 'origin'
WHERE source_kind IS NULL AND source IS NOT NULL;

UPDATE public.weddings
SET source_kind = 'unknown'
WHERE source_kind IS NULL;

-- Rewrite destination → origin where attribution has a forensic first-touch
WITH origin_picks AS (
  SELECT
    ae.wedding_id, ae.source_platform, ae.decided_at,
    ROW_NUMBER() OVER (
      PARTITION BY ae.wedding_id
      ORDER BY ae.decided_at ASC, ae.id ASC
    ) AS rn
  FROM public.attribution_events_live ae
  WHERE ae.is_first_touch = true
    AND ae.bucket = 'attribution'
    AND ae.source_platform IS NOT NULL
)
UPDATE public.weddings w
SET source_detail = COALESCE(w.source_detail, w.source),
    source = op.source_platform
FROM origin_picks op
WHERE w.id = op.wedding_id
  AND op.rn = 1
  AND w.source_kind = 'destination'
  AND op.source_platform IS NOT NULL
  AND op.source_platform <> w.source;

UPDATE public.weddings
SET source_kind = 'origin'
WHERE source_kind = 'destination'
  AND LOWER(source) NOT IN (
    'honeybook','calendly','acuity','dubsado','aisle_planner',
    'aisleplanner','tave','tave_studio','tavestudio'
  );

CREATE INDEX IF NOT EXISTS idx_weddings_source_kind
  ON public.weddings (venue_id, source_kind);

CREATE INDEX IF NOT EXISTS idx_attribution_events_open_conflicts
  ON public.attribution_events (venue_id, decided_at DESC)
  WHERE conflict_with_legacy_source IS NOT NULL
    AND conflict_resolution_state IS NULL
    AND reverted_at IS NULL
    AND tombstoned_at IS NULL;

ALTER TABLE public.candidate_identities
  ADD COLUMN IF NOT EXISTS deleted_reason text;

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS match_eligibility_band_days integer
  CHECK (match_eligibility_band_days IS NULL OR (match_eligibility_band_days >= 30 AND match_eligibility_band_days <= 730));


-- ===========================================================================
-- SECTION 339: venue_email_filter_matches
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.venue_email_filter_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  filter_id uuid NOT NULL REFERENCES public.venue_email_filters(id) ON DELETE CASCADE,
  pattern text NOT NULL,
  pattern_type text NOT NULL CHECK (pattern_type IN ('sender_exact','sender_domain','gmail_label')),
  action text NOT NULL CHECK (action IN ('ignore','no_draft')),
  from_email text NOT NULL,
  matched_label text,
  matched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS venue_email_filter_matches_venue_at_idx
  ON public.venue_email_filter_matches (venue_id, matched_at DESC);
CREATE INDEX IF NOT EXISTS venue_email_filter_matches_filter_at_idx
  ON public.venue_email_filter_matches (filter_id, matched_at DESC);
CREATE INDEX IF NOT EXISTS venue_email_filter_matches_from_idx
  ON public.venue_email_filter_matches (venue_id, from_email);

ALTER TABLE public.venue_email_filter_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS venue_email_filter_matches_select_own
  ON public.venue_email_filter_matches;
CREATE POLICY venue_email_filter_matches_select_own
  ON public.venue_email_filter_matches
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS venue_email_filter_matches_super_admin
  ON public.venue_email_filter_matches;
CREATE POLICY venue_email_filter_matches_super_admin
  ON public.venue_email_filter_matches
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());


-- ===========================================================================
-- SECTION 340: weather_climate_norms
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.weather_climate_norms (
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  month_num int NOT NULL CHECK (month_num BETWEEN 1 AND 12),
  hour_local int NOT NULL CHECK (hour_local BETWEEN 0 AND 23),
  recent_temp_avg_f decimal,
  recent_temp_p10_f decimal,
  recent_temp_p90_f decimal,
  recent_precip_avg_in decimal,
  recent_precip_prob_pct decimal,
  recent_sample_count int NOT NULL DEFAULT 0,
  prior_temp_avg_f decimal,
  prior_precip_avg_in decimal,
  prior_precip_prob_pct decimal,
  prior_sample_count int NOT NULL DEFAULT 0,
  recent_window_start date,
  recent_window_end date,
  prior_window_start date,
  prior_window_end date,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, month_num, hour_local)
);

CREATE INDEX IF NOT EXISTS weather_climate_norms_venue_month_idx
  ON public.weather_climate_norms (venue_id, month_num);

ALTER TABLE public.weather_climate_norms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS weather_climate_norms_select_own ON public.weather_climate_norms;
CREATE POLICY weather_climate_norms_select_own
  ON public.weather_climate_norms
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS weather_climate_norms_super_admin ON public.weather_climate_norms;
CREATE POLICY weather_climate_norms_super_admin
  ON public.weather_climate_norms
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());


-- ===========================================================================
-- SECTION 341: weather_anomaly_events
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.weather_anomaly_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('cold_snap','heat_wave','wet_stretch','severe_storm','snow_event')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  duration_days int NOT NULL,
  severity text NOT NULL CHECK (severity IN ('moderate','severe','extreme')),
  description text NOT NULL,
  min_temp_f decimal,
  max_temp_f decimal,
  total_precip_in decimal,
  total_snow_in decimal,
  inquiries_during int,
  inquiries_typical int,
  tours_during int,
  tours_typical int,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, start_date, event_type)
);

CREATE INDEX IF NOT EXISTS weather_anomaly_events_venue_start_idx
  ON public.weather_anomaly_events (venue_id, start_date DESC);
CREATE INDEX IF NOT EXISTS weather_anomaly_events_date_idx
  ON public.weather_anomaly_events (venue_id, start_date);

ALTER TABLE public.weather_anomaly_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS weather_anomaly_events_select_own ON public.weather_anomaly_events;
CREATE POLICY weather_anomaly_events_select_own
  ON public.weather_anomaly_events
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS weather_anomaly_events_super_admin ON public.weather_anomaly_events;
CREATE POLICY weather_anomaly_events_super_admin
  ON public.weather_anomaly_events
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());


-- ===========================================================================
-- SECTION 342: weather_anomaly_monthly_types
-- ---------------------------------------------------------------------------
-- Extends the event_type CHECK to include monthly-deviation types.
-- ===========================================================================

ALTER TABLE public.weather_anomaly_events
  DROP CONSTRAINT IF EXISTS weather_anomaly_events_event_type_check;

ALTER TABLE public.weather_anomaly_events
  ADD CONSTRAINT weather_anomaly_events_event_type_check
  CHECK (event_type IN (
    'cold_snap','heat_wave','wet_stretch','severe_storm','snow_event',
    'warm_month','cool_month','wet_month','dry_month'
  ));


-- ===========================================================================
-- SECTION 343: reviews RLS lockdown
-- ===========================================================================

DROP POLICY IF EXISTS "anon_select_reviews"          ON public.reviews;
DROP POLICY IF EXISTS "anon_insert_reviews"          ON public.reviews;
DROP POLICY IF EXISTS "anon_update_reviews"          ON public.reviews;
DROP POLICY IF EXISTS "anon_delete_reviews"          ON public.reviews;
DROP POLICY IF EXISTS "authenticated_select_reviews" ON public.reviews;
DROP POLICY IF EXISTS "authenticated_insert_reviews" ON public.reviews;
DROP POLICY IF EXISTS "authenticated_update_reviews" ON public.reviews;
DROP POLICY IF EXISTS "authenticated_delete_reviews" ON public.reviews;
DROP POLICY IF EXISTS reviews_venue_scope_select ON public.reviews;
DROP POLICY IF EXISTS reviews_venue_scope_update ON public.reviews;
DROP POLICY IF EXISTS reviews_super_admin       ON public.reviews;

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY reviews_venue_scope_select ON public.reviews
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

CREATE POLICY reviews_venue_scope_update ON public.reviews
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

CREATE POLICY reviews_super_admin ON public.reviews
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());


-- ===========================================================================
-- SECTION 344: venues review source IDs
-- ===========================================================================

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS google_place_id text,
  ADD COLUMN IF NOT EXISTS the_knot_url text,
  ADD COLUMN IF NOT EXISTS wedding_wire_url text,
  ADD COLUMN IF NOT EXISTS zola_url text,
  ADD COLUMN IF NOT EXISTS yelp_business_id text,
  ADD COLUMN IF NOT EXISTS facebook_page_id text;


-- ===========================================================================
-- SECTION 345: reviews column guard
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.reviews_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
  IF public.is_super_admin() THEN RETURN NEW; END IF;

  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'reviews: venue_id is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.source IS DISTINCT FROM NEW.source THEN
    RAISE EXCEPTION 'reviews: source is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.source_review_id IS DISTINCT FROM NEW.source_review_id THEN
    RAISE EXCEPTION 'reviews: source_review_id is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.reviewer_name IS DISTINCT FROM NEW.reviewer_name THEN
    RAISE EXCEPTION 'reviews: reviewer_name is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.rating IS DISTINCT FROM NEW.rating THEN
    RAISE EXCEPTION 'reviews: rating is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.body IS DISTINCT FROM NEW.body THEN
    RAISE EXCEPTION 'reviews: body is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.title IS DISTINCT FROM NEW.title THEN
    RAISE EXCEPTION 'reviews: title is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.review_date IS DISTINCT FROM NEW.review_date THEN
    RAISE EXCEPTION 'reviews: review_date is immutable from the operator surface (TIER 7+ guard)';
  END IF;
  IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'reviews: created_at is immutable (TIER 7+ guard)';
  END IF;
  IF OLD.wedding_id IS DISTINCT FROM NEW.wedding_id THEN
    RAISE EXCEPTION 'reviews: wedding_id is set by reconcileReceivedReviewWithSolicitation only (TIER 7+ guard)';
  END IF;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS reviews_column_guard_trigger ON public.reviews;
CREATE TRIGGER reviews_column_guard_trigger
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.reviews_column_guard();


-- ===========================================================================
-- SECTION 346: Identity-First Phase A
-- ---------------------------------------------------------------------------
-- couples, agent_couple_links, touchpoints, fragments, couple_merge_events,
-- couple_progression_events, candidate_matches, tracer_run_events.
--
-- Naming note: doctrine calls the entity table `persons`; repo uses
-- `couples` to avoid colliding with the existing `people` table.
-- See IDENTITY-FIRST-ARCHITECTURE.md and migration 346 header for the
-- full rationale.
-- ===========================================================================

-- 346-1: couples
CREATE TABLE IF NOT EXISTS public.couples (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id                    uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  primary_contact_name        text NOT NULL,
  primary_contact_email       text,
  primary_contact_phone       text,
  partner_contact_name        text,
  partner_contact_email       text,
  partner_contact_phone       text,
  wedding_date                date,
  lifecycle_state             text NOT NULL CHECK (lifecycle_state IN (
    'channel_scoped','resolved','booked','ghost','agent'
  )),
  channel_scope               text,
  decay_window_days           integer NOT NULL DEFAULT 180
                                CHECK (decay_window_days >= 90),
  last_progression_at         timestamptz,
  heat_score                  numeric,
  source_wedding_id           uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_couples_source_wedding
  ON public.couples (venue_id, source_wedding_id);

CREATE INDEX IF NOT EXISTS ix_couples_venue_lifecycle
  ON public.couples (venue_id, lifecycle_state);

CREATE INDEX IF NOT EXISTS ix_couples_venue_primary_email
  ON public.couples (venue_id, lower(primary_contact_email))
  WHERE primary_contact_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_couples_venue_partner_email
  ON public.couples (venue_id, lower(partner_contact_email))
  WHERE partner_contact_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_couples_venue_primary_phone
  ON public.couples (venue_id, primary_contact_phone)
  WHERE primary_contact_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_couples_venue_partner_phone
  ON public.couples (venue_id, partner_contact_phone)
  WHERE partner_contact_phone IS NOT NULL;


-- 346-2: agent_couple_links
CREATE TABLE IF NOT EXISTS public.agent_couple_links (
  agent_id        uuid NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  couple_id       uuid NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  established_at  timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL CHECK (source IN (
    'self_identified','multi_couple_inferred','operator_confirmed'
  )),
  PRIMARY KEY (agent_id, couple_id),
  CHECK (agent_id <> couple_id)
);

CREATE INDEX IF NOT EXISTS ix_agent_couple_links_couple
  ON public.agent_couple_links (couple_id);


-- 346-3: touchpoints
CREATE TABLE IF NOT EXISTS public.touchpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id        uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  couple_id       uuid REFERENCES public.couples(id) ON DELETE SET NULL,
  agent_id        uuid REFERENCES public.couples(id) ON DELETE SET NULL,
  channel         text NOT NULL,
  signal_tier     text NOT NULL CHECK (signal_tier IN (
    'highest','high','medium_high','medium','low','aggregate_only'
  )),
  action_type     text NOT NULL,
  external_id     text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  confidence_tier text CHECK (confidence_tier IN ('high','medium','low')),
  raw_payload     jsonb,
  UNIQUE (venue_id, channel, external_id)
);

CREATE INDEX IF NOT EXISTS ix_touchpoints_couple_time
  ON public.touchpoints (couple_id, occurred_at DESC)
  WHERE couple_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_touchpoints_agent_time
  ON public.touchpoints (agent_id, occurred_at DESC)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_touchpoints_venue_channel
  ON public.touchpoints (venue_id, channel, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ix_touchpoints_raw_payload_gin
  ON public.touchpoints USING gin (raw_payload);


-- 346-4: fragments
CREATE TABLE IF NOT EXISTS public.fragments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id                uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  channel                 text NOT NULL,
  identity_hint           text,
  external_id             text NOT NULL,
  occurred_at             timestamptz NOT NULL,
  raw_payload             jsonb,
  promoted_to_couple_id   uuid REFERENCES public.couples(id) ON DELETE SET NULL,
  promoted_at             timestamptz,
  UNIQUE (venue_id, channel, external_id)
);

CREATE INDEX IF NOT EXISTS ix_fragments_venue_promotion_scan
  ON public.fragments (venue_id, channel, identity_hint, occurred_at)
  WHERE promoted_to_couple_id IS NULL;

CREATE INDEX IF NOT EXISTS ix_fragments_promoted_to_couple
  ON public.fragments (promoted_to_couple_id)
  WHERE promoted_to_couple_id IS NOT NULL;


-- 346-5: couple_merge_events
CREATE TABLE IF NOT EXISTS public.couple_merge_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  event_type          text NOT NULL CHECK (event_type IN (
    'fragment_promoted','channel_scoped_bridged','candidate_confirmed',
    'candidate_rejected','manual_merge','manual_unmerge','resurrection',
    'resurrection_rejected'
  )),
  primary_couple_id   uuid REFERENCES public.couples(id) ON DELETE SET NULL,
  secondary_couple_id uuid REFERENCES public.couples(id) ON DELETE SET NULL,
  operator_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rule_triggered      text,
  confidence_tier     text CHECK (confidence_tier IN ('high','medium','low')),
  reason              text,
  occurred_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_couple_merge_events_venue_time
  ON public.couple_merge_events (venue_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ix_couple_merge_events_primary
  ON public.couple_merge_events (primary_couple_id, occurred_at DESC)
  WHERE primary_couple_id IS NOT NULL;


-- 346-6: couple_progression_events
CREATE TABLE IF NOT EXISTS public.couple_progression_events (
  couple_id            uuid NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  occurred_at          timestamptz NOT NULL,
  event_type           text NOT NULL CHECK (event_type IN (
    'email_reply','tour_booked','tour_rescheduled','tour_attended',
    'new_channel_inquiry','portal_click','contract_signed',
    'inbound_followup','fragment_match_returned'
  )),
  source_touchpoint_id uuid REFERENCES public.touchpoints(id) ON DELETE SET NULL,
  PRIMARY KEY (couple_id, occurred_at, event_type)
);

CREATE INDEX IF NOT EXISTS ix_couple_progression_recent
  ON public.couple_progression_events (couple_id, occurred_at DESC);


-- 346-7: candidate_matches
CREATE TABLE IF NOT EXISTS public.candidate_matches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id              uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  primary_record_id     uuid NOT NULL,
  primary_record_type   text NOT NULL CHECK (primary_record_type IN (
    'couple','fragment','channel_scoped'
  )),
  secondary_record_id   uuid NOT NULL,
  secondary_record_type text NOT NULL CHECK (secondary_record_type IN (
    'couple','fragment','channel_scoped'
  )),
  confidence_tier       text NOT NULL CHECK (confidence_tier IN ('high','medium','low')),
  matcher_reason        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  resolution            text CHECK (resolution IN ('confirmed','rejected','not_sure')),
  resolved_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_candidate_matches_open_queue
  ON public.candidate_matches (venue_id, created_at DESC)
  WHERE resolution IS NULL;


-- 346-8: tracer_run_events
CREATE TABLE IF NOT EXISTS public.tracer_run_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL,
  stage         text NOT NULL,
  status        text NOT NULL CHECK (status IN (
    'started','progress','succeeded','failed','skipped'
  )),
  batch_index   integer,
  rows_seen     integer,
  rows_written  integer,
  detail        jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_tracer_run_events_run
  ON public.tracer_run_events (run_id, occurred_at);

CREATE INDEX IF NOT EXISTS ix_tracer_run_events_venue_recent
  ON public.tracer_run_events (venue_id, occurred_at DESC);


-- 346-9: RLS
ALTER TABLE public.couples                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_couple_links        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.touchpoints               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fragments                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.couple_merge_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.couple_progression_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidate_matches         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracer_run_events         ENABLE ROW LEVEL SECURITY;

-- couples
DROP POLICY IF EXISTS "couples_select" ON public.couples;
CREATE POLICY "couples_select" ON public.couples
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

DROP POLICY IF EXISTS "couples_modify" ON public.couples;
CREATE POLICY "couples_modify" ON public.couples
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

DROP POLICY IF EXISTS "couples_service" ON public.couples;
CREATE POLICY "couples_service" ON public.couples
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_couples" ON public.couples;
CREATE POLICY "demo_anon_select_couples" ON public.couples
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- agent_couple_links
DROP POLICY IF EXISTS "agent_couple_links_select" ON public.agent_couple_links;
CREATE POLICY "agent_couple_links_select" ON public.agent_couple_links
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.couples c
      WHERE c.id = agent_couple_links.agent_id
        AND (
          c.venue_id IN (
            SELECT up.venue_id FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
            UNION
            SELECT v.id FROM public.venues v
              JOIN public.user_profiles up ON up.org_id = v.org_id
            WHERE up.id = auth.uid()
          )
          OR public.is_super_admin()
        )
    )
  );

DROP POLICY IF EXISTS "agent_couple_links_modify" ON public.agent_couple_links;
CREATE POLICY "agent_couple_links_modify" ON public.agent_couple_links
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.couples c
      WHERE c.id = agent_couple_links.agent_id
        AND (
          c.venue_id IN (
            SELECT up.venue_id FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
            UNION
            SELECT v.id FROM public.venues v
              JOIN public.user_profiles up ON up.org_id = v.org_id
            WHERE up.id = auth.uid()
          )
          OR public.is_super_admin()
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.couples c
      WHERE c.id = agent_couple_links.agent_id
        AND (
          c.venue_id IN (
            SELECT up.venue_id FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
            UNION
            SELECT v.id FROM public.venues v
              JOIN public.user_profiles up ON up.org_id = v.org_id
            WHERE up.id = auth.uid()
          )
          OR public.is_super_admin()
        )
    )
  );

DROP POLICY IF EXISTS "agent_couple_links_service" ON public.agent_couple_links;
CREATE POLICY "agent_couple_links_service" ON public.agent_couple_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- touchpoints
DROP POLICY IF EXISTS "touchpoints_select" ON public.touchpoints;
CREATE POLICY "touchpoints_select" ON public.touchpoints
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

DROP POLICY IF EXISTS "touchpoints_modify" ON public.touchpoints;
CREATE POLICY "touchpoints_modify" ON public.touchpoints
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

DROP POLICY IF EXISTS "touchpoints_service" ON public.touchpoints;
CREATE POLICY "touchpoints_service" ON public.touchpoints
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_touchpoints" ON public.touchpoints;
CREATE POLICY "demo_anon_select_touchpoints" ON public.touchpoints
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- fragments
DROP POLICY IF EXISTS "fragments_select" ON public.fragments;
CREATE POLICY "fragments_select" ON public.fragments
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

DROP POLICY IF EXISTS "fragments_modify" ON public.fragments;
CREATE POLICY "fragments_modify" ON public.fragments
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

DROP POLICY IF EXISTS "fragments_service" ON public.fragments;
CREATE POLICY "fragments_service" ON public.fragments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_fragments" ON public.fragments;
CREATE POLICY "demo_anon_select_fragments" ON public.fragments
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- couple_merge_events
DROP POLICY IF EXISTS "couple_merge_events_select" ON public.couple_merge_events;
CREATE POLICY "couple_merge_events_select" ON public.couple_merge_events
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

DROP POLICY IF EXISTS "couple_merge_events_service" ON public.couple_merge_events;
CREATE POLICY "couple_merge_events_service" ON public.couple_merge_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- couple_progression_events (via couples)
DROP POLICY IF EXISTS "couple_progression_events_select" ON public.couple_progression_events;
CREATE POLICY "couple_progression_events_select" ON public.couple_progression_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.couples c
      WHERE c.id = couple_progression_events.couple_id
        AND (
          c.venue_id IN (
            SELECT up.venue_id FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
            UNION
            SELECT v.id FROM public.venues v
              JOIN public.user_profiles up ON up.org_id = v.org_id
            WHERE up.id = auth.uid()
          )
          OR public.is_super_admin()
        )
    )
  );

DROP POLICY IF EXISTS "couple_progression_events_service" ON public.couple_progression_events;
CREATE POLICY "couple_progression_events_service" ON public.couple_progression_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- candidate_matches
DROP POLICY IF EXISTS "candidate_matches_select" ON public.candidate_matches;
CREATE POLICY "candidate_matches_select" ON public.candidate_matches
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

DROP POLICY IF EXISTS "candidate_matches_modify" ON public.candidate_matches;
CREATE POLICY "candidate_matches_modify" ON public.candidate_matches
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

DROP POLICY IF EXISTS "candidate_matches_service" ON public.candidate_matches;
CREATE POLICY "candidate_matches_service" ON public.candidate_matches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- tracer_run_events
DROP POLICY IF EXISTS "tracer_run_events_select" ON public.tracer_run_events;
CREATE POLICY "tracer_run_events_select" ON public.tracer_run_events
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

DROP POLICY IF EXISTS "tracer_run_events_service" ON public.tracer_run_events;
CREATE POLICY "tracer_run_events_service" ON public.tracer_run_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- 346-10: backfill weddings → couples (idempotent via ON CONFLICT)
INSERT INTO public.couples (
  venue_id,
  primary_contact_name,
  primary_contact_email,
  primary_contact_phone,
  partner_contact_name,
  partner_contact_email,
  partner_contact_phone,
  wedding_date,
  lifecycle_state,
  source_wedding_id,
  created_at,
  updated_at
)
SELECT
  w.venue_id,
  COALESCE(
    NULLIF(TRIM(CONCAT_WS(' ', p1.first_name, p1.last_name)), ''),
    NULLIF(TRIM(CONCAT_WS(' ', p2.first_name, p2.last_name)), ''),
    '(Unknown — backfilled from weddings ' || w.id::text || ')'
  ),
  p1.email,
  p1.phone,
  NULLIF(TRIM(CONCAT_WS(' ', p2.first_name, p2.last_name)), ''),
  p2.email,
  p2.phone,
  w.wedding_date,
  CASE
    WHEN w.status IN ('booked','completed') THEN 'booked'
    WHEN w.status IN ('lost','cancelled')   THEN 'ghost'
    ELSE                                         'resolved'
  END,
  w.id,
  w.inquiry_date,
  w.updated_at
FROM public.weddings w
LEFT JOIN LATERAL (
  SELECT first_name, last_name, email, phone
  FROM public.people
  WHERE wedding_id = w.id AND role = 'partner1'
  ORDER BY created_at ASC LIMIT 1
) p1 ON true
LEFT JOIN LATERAL (
  SELECT first_name, last_name, email, phone
  FROM public.people
  WHERE wedding_id = w.id AND role = 'partner2'
  ORDER BY created_at ASC LIMIT 1
) p2 ON true
ON CONFLICT (venue_id, source_wedding_id) DO NOTHING;


-- ===========================================================================
-- DONE
-- ---------------------------------------------------------------------------
-- Verify rough state with these read-only queries (paste into a new
-- SQL editor tab):
--
--   SELECT COUNT(*) AS weddings FROM public.weddings;
--   SELECT COUNT(*) AS couples  FROM public.couples;
--   -- drift_pct should be 0% or near-zero
--
--   SELECT lifecycle_state, COUNT(*) FROM public.couples GROUP BY 1;
--   -- expected: booked + resolved + ghost rows, NO channel_scoped/agent yet
--
--   SELECT to_regclass('public.touchpoints')    AS touchpoints,
--          to_regclass('public.fragments')      AS fragments,
--          to_regclass('public.candidate_matches') AS candidate_matches,
--          to_regclass('public.tracer_run_events') AS tracer_run_events;
--   -- all four should be non-null
-- ===========================================================================
