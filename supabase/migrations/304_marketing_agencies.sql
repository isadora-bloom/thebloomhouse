-- ---------------------------------------------------------------------------
-- 304_marketing_agencies.sql  (Wave 6E — agency entity layer)
-- ---------------------------------------------------------------------------
-- The "is Hawthorn paying off?" question is the strongest single argument
-- for Bloom right now. Boutique wedding-marketing agencies (Hawthorn
-- Creative, Elite Wedding Marketing, Path & Compass, Alecan, Slamdot,
-- Del Priore Hospitality, Wedding Venue Leads, etc.) bill $2k-$8k/mo
-- and report on top-of-funnel metrics they can see (impressions,
-- clicks, form submissions). They CANNOT see what happens after the
-- form: tour conversion, booking, revenue. Bloom can — and once an
-- agency is a first-class entity, "agency CAC" and "agency-vs-claimed
-- attribution" become the headline TBH Report.
--
-- This migration lands the agency entity + the venue-agency engagement.
-- Migration 305 adds the linkage columns on marketing_spend_records and
-- marketing_channels so spend rows + channels can point at an agency.
--
-- Architectural choices baked in here:
--
--   1. marketing_agencies is NOT venue-scoped by default — the same
--      agency (Hawthorn) can serve multiple venues at Wedgewood scale.
--      An agency belongs to an organisation (org_id) when an org owns
--      the relationship, or to a single venue (venue_id) when a
--      stand-alone Bloom customer manages their own roster. CHECK
--      requires exactly one ownership pointer.
--
--   2. venue_agency_engagements is the M:N relationship that carries
--      per-venue cost + per-venue scope. The same agency can have
--      different monthly fees at different venues. Active engagement
--      = ended_at IS NULL. One active engagement per (venue, agency).
--
--   3. Soft-delete only — `deleted_at` preserves history for TBH
--      Reports run against terminated engagements ("what did Hawthorn
--      actually deliver during the 18 months they ran our ads?").
--
--   4. Idempotent — every CREATE uses IF NOT EXISTS, RLS uses
--      DROP THEN CREATE. Safe to re-run. No BEGIN/COMMIT wrapper
--      (exec_sql RPC silently rejects transaction blocks — see
--      feedback_migration_no_transaction_wrapper memory, Wave 23
--      caught this).
--
-- What is NOT in this migration:
--   * Spend / channel linkage columns (migration 305 owns).
--   * Agency-attributed ROI compute function (service layer owns).
--   * Agency-portal multi-tenancy (deferred — see bloom expansion
--     investigation notes; only build after 5+ venues use TBH Reports).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — marketing_agencies (the agency entity)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.marketing_agencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Exactly one ownership pointer must be set. org_id wins at
  -- Wedgewood scale (one Hawthorn relationship shared across 8
  -- venues). venue_id is the single-venue case (Rixey solo).
  org_id uuid REFERENCES public.organisations(id) ON DELETE CASCADE,
  venue_id uuid REFERENCES public.venues(id) ON DELETE CASCADE,

  -- The agency's display name. Free-text so regional / international
  -- agencies land without a hardcoded list.
  name text NOT NULL,

  -- Optional contact + identity fields. All free-text, all nullable.
  -- Coordinators populate over time as they get the data.
  website text,
  contact_name text,
  contact_email text,
  contact_phone text,

  -- The agency's typical pricing model. PER-VENUE cost lives on
  -- venue_agency_engagements (where it actually varies); these are
  -- the rack-rate defaults the agency advertises.
  default_monthly_retainer_cents integer
    CHECK (default_monthly_retainer_cents IS NULL OR default_monthly_retainer_cents >= 0),
  performance_fee_pct numeric(5,2)
    CHECK (performance_fee_pct IS NULL OR (performance_fee_pct >= 0 AND performance_fee_pct <= 100)),

  -- Services the agency claims to offer. Free-text tags in a JSON
  -- array so the operator can record what they're actually paying
  -- for. Common values: 'seo' | 'paid_search' | 'paid_social' |
  -- 'content' | 'web_design' | 'email' | 'pinterest' | 'reputation'.
  services jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Long-form coordinator notes. Contracts, account-rep names, the
  -- "they promised X but actually deliver Y" running log.
  notes text,

  -- Audit trail. created_by is nullable so service-role / cron
  -- inserts (rare here) don't break the FK.
  created_by uuid REFERENCES public.user_profiles(id),

  -- Soft-delete only. Preserves historical attribution + cost.
  deleted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketing_agencies_name_nonempty
    CHECK (length(trim(name)) > 0),

  -- Exactly one ownership pointer.
  CONSTRAINT marketing_agencies_owner_xor
    CHECK ((org_id IS NOT NULL) <> (venue_id IS NOT NULL))
);

COMMENT ON TABLE public.marketing_agencies IS
  'owner:intelligence. Wave 6E. First-class marketing-agency entity. '
  'NOT venue-scoped — a single agency can serve multiple venues at '
  'Wedgewood scale via venue_agency_engagements. Owned by either an '
  'organisation (org-level relationship) or a venue (single-venue '
  'roster) but never both. Soft-delete preserves historical '
  'attribution. The "is Hawthorn paying off?" answer is computed by '
  'joining attribution_events → marketing_channels.managed_by_agency_id '
  '+ marketing_spend_records.agency_id (migration 305). Migration 304.';

COMMENT ON COLUMN public.marketing_agencies.org_id IS
  'When set, agency is shared across all venues in the org. Wedgewood '
  'pattern. Mutually exclusive with venue_id.';

COMMENT ON COLUMN public.marketing_agencies.venue_id IS
  'When set, agency is owned by a single venue (no org context). '
  'Solo-Bloom pattern. Mutually exclusive with org_id.';

COMMENT ON COLUMN public.marketing_agencies.services IS
  'JSON array of free-text service tags. Common values: seo, '
  'paid_search, paid_social, content, web_design, email, pinterest, '
  'reputation, listing_management. UI surfaces these as chips on the '
  'agency card.';

COMMENT ON COLUMN public.marketing_agencies.default_monthly_retainer_cents IS
  'Rack-rate retainer the agency advertises (cents). Actual per-venue '
  'fee lives on venue_agency_engagements.monthly_fee_cents.';

CREATE INDEX IF NOT EXISTS idx_marketing_agencies_org
  ON public.marketing_agencies (org_id)
  WHERE deleted_at IS NULL AND org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_agencies_venue
  ON public.marketing_agencies (venue_id)
  WHERE deleted_at IS NULL AND venue_id IS NOT NULL;

-- Case-insensitive name lookup for the "do we already have this agency?"
-- prompt in the create form.
CREATE INDEX IF NOT EXISTS idx_marketing_agencies_name_lower
  ON public.marketing_agencies (lower(name))
  WHERE deleted_at IS NULL;

-- ============================================================================
-- STEP 2 — venue_agency_engagements (M:N pivot with cost + scope)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.venue_agency_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,

  -- Engagement period. ended_at NULL = currently active. ended_at
  -- in the past = historical (still counts for TBH Reports run with
  -- a window that overlaps the engagement).
  started_at date NOT NULL,
  ended_at date,

  -- What this venue is actually paying. Distinct from the agency's
  -- default_monthly_retainer — the same agency can charge different
  -- fees at different venues.
  monthly_fee_cents integer NOT NULL DEFAULT 0
    CHECK (monthly_fee_cents >= 0),

  -- Which channels (marketing_channels.key values) this engagement
  -- covers. The TBH ROI compute joins attribution_events against
  -- this set when answering "what did Hawthorn drive?". Stored as
  -- a JSON array to allow zero-or-more channels per engagement.
  managed_channels jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Coordinator-facing description of scope.
  scope_description text,

  notes text,

  deleted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT venue_agency_engagements_dates_valid
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

COMMENT ON TABLE public.venue_agency_engagements IS
  'owner:intelligence. Wave 6E. Per-venue agency engagement. Many-to-'
  'many between venues and marketing_agencies. Carries the per-venue '
  'fee (which can differ from the agency''s rack rate) and the set of '
  'channels the agency manages at this venue. One active engagement '
  '(ended_at IS NULL) per (venue, agency). Soft-delete preserves '
  'historical TBH Report data. Migration 304.';

COMMENT ON COLUMN public.venue_agency_engagements.managed_channels IS
  'JSON array of marketing_channels.key values that this engagement '
  'covers. Example: ["google_ads", "meta_ads", "organic_seo"]. The '
  'agency-ROI compute joins attribution_events.source_platform '
  'against this set.';

COMMENT ON COLUMN public.venue_agency_engagements.ended_at IS
  'NULL = currently active. Set when the relationship ends — '
  'historical TBH Reports still include this engagement when their '
  'window overlaps started_at..ended_at.';

-- One active engagement per (venue, agency).
CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_agency_engagements_active
  ON public.venue_agency_engagements (venue_id, agency_id)
  WHERE ended_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_venue_agency_engagements_venue
  ON public.venue_agency_engagements (venue_id, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_venue_agency_engagements_agency
  ON public.venue_agency_engagements (agency_id, started_at DESC)
  WHERE deleted_at IS NULL;

-- ============================================================================
-- STEP 3 — RLS for marketing_agencies
-- ============================================================================
-- An authenticated user can see an agency if either:
--   (a) their user_profile.org_id matches the agency's org_id, OR
--   (b) their user_profile.venue_id matches the agency's venue_id, OR
--   (c) they're in the org that owns a venue with an engagement to
--       the agency (multi-venue users), OR
--   (d) they're a super_admin.
-- Service-role bypasses RLS for the cron + compute paths.

ALTER TABLE public.marketing_agencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_agencies_select" ON public.marketing_agencies;
CREATE POLICY "marketing_agencies_select" ON public.marketing_agencies
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      org_id IS NOT NULL
      AND org_id IN (
        SELECT up.org_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.org_id IS NOT NULL
      )
    )
    OR (
      venue_id IS NOT NULL
      AND venue_id IN (
        SELECT up.venue_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
        UNION
        SELECT v.id FROM public.venues v
          JOIN public.user_profiles up ON up.org_id = v.org_id
        WHERE up.id = auth.uid()
      )
    )
    OR id IN (
      SELECT eng.agency_id
      FROM public.venue_agency_engagements eng
      WHERE eng.deleted_at IS NULL
        AND eng.venue_id IN (
          SELECT up.venue_id FROM public.user_profiles up
          WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
          UNION
          SELECT v.id FROM public.venues v
            JOIN public.user_profiles up ON up.org_id = v.org_id
          WHERE up.id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "marketing_agencies_modify" ON public.marketing_agencies;
CREATE POLICY "marketing_agencies_modify" ON public.marketing_agencies
  FOR ALL TO authenticated
  USING (
    public.is_super_admin()
    OR (
      org_id IS NOT NULL
      AND org_id IN (
        SELECT up.org_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.org_id IS NOT NULL
      )
    )
    OR (
      venue_id IS NOT NULL
      AND venue_id IN (
        SELECT up.venue_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
        UNION
        SELECT v.id FROM public.venues v
          JOIN public.user_profiles up ON up.org_id = v.org_id
        WHERE up.id = auth.uid()
      )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR (
      org_id IS NOT NULL
      AND org_id IN (
        SELECT up.org_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.org_id IS NOT NULL
      )
    )
    OR (
      venue_id IS NOT NULL
      AND venue_id IN (
        SELECT up.venue_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
        UNION
        SELECT v.id FROM public.venues v
          JOIN public.user_profiles up ON up.org_id = v.org_id
        WHERE up.id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "marketing_agencies_service" ON public.marketing_agencies;
CREATE POLICY "marketing_agencies_service" ON public.marketing_agencies
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_marketing_agencies" ON public.marketing_agencies;
CREATE POLICY "demo_anon_select_marketing_agencies" ON public.marketing_agencies
  FOR SELECT TO anon
  USING (
    venue_id IN (SELECT id FROM public.venues WHERE is_demo = true)
    OR org_id IN (
      SELECT DISTINCT org_id FROM public.venues
      WHERE is_demo = true AND org_id IS NOT NULL
    )
  );

-- ============================================================================
-- STEP 4 — RLS for venue_agency_engagements
-- ============================================================================
-- Mirror marketing_channels pattern — venue-scoped, with org-fanout
-- via user_profiles.org_id JOIN venues.org_id.

ALTER TABLE public.venue_agency_engagements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_agency_engagements_select" ON public.venue_agency_engagements;
CREATE POLICY "venue_agency_engagements_select" ON public.venue_agency_engagements
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

DROP POLICY IF EXISTS "venue_agency_engagements_modify" ON public.venue_agency_engagements;
CREATE POLICY "venue_agency_engagements_modify" ON public.venue_agency_engagements
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

DROP POLICY IF EXISTS "venue_agency_engagements_service" ON public.venue_agency_engagements;
CREATE POLICY "venue_agency_engagements_service" ON public.venue_agency_engagements
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_venue_agency_engagements"
  ON public.venue_agency_engagements;
CREATE POLICY "demo_anon_select_venue_agency_engagements"
  ON public.venue_agency_engagements
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ============================================================================
-- STEP 5 — updated_at touch triggers
-- ============================================================================

CREATE OR REPLACE FUNCTION public.marketing_agencies_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_marketing_agencies_updated_at
  ON public.marketing_agencies;
CREATE TRIGGER trg_marketing_agencies_updated_at
  BEFORE UPDATE ON public.marketing_agencies
  FOR EACH ROW
  EXECUTE FUNCTION public.marketing_agencies_touch_updated_at();

CREATE OR REPLACE FUNCTION public.venue_agency_engagements_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_agency_engagements_updated_at
  ON public.venue_agency_engagements;
CREATE TRIGGER trg_venue_agency_engagements_updated_at
  BEFORE UPDATE ON public.venue_agency_engagements
  FOR EACH ROW
  EXECUTE FUNCTION public.venue_agency_engagements_touch_updated_at();

NOTIFY pgrst, 'reload schema';
