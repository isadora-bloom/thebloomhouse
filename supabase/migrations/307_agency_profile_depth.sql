-- ---------------------------------------------------------------------------
-- 306_agency_profile_depth.sql  (Wave 6E — depth pass)
-- ---------------------------------------------------------------------------
-- Migrations 304/305 landed the agency entity + spend/channel linkage.
-- v1 of the tracker captured one contact + flat retainer + free-text
-- notes. Real agency relationships are deeper:
--
--   * Multiple humans (account manager, strategist, billing).
--   * Contracts (PDFs) with renewal dates.
--   * Specific KPIs the agency contractually promised (the TBH Report's
--     "they promised X, actual Y" requires this as a substrate).
--   * Per-channel sub-budgets WITHIN the engagement ($1.5k Google + $1k
--     Meta + $0.5k content, not just one $3k retainer line).
--   * Reporting cadence + dashboard URL — so Bloom can flag when their
--     monthly report is late and deep-link to their own view.
--   * Activity log — decisions over time (Q2 review notes, channel
--     shifts, escalations). Replaces the single free-text `notes` blob.
--
-- This migration adds four new tables + three new columns on
-- venue_agency_engagements. Idempotent. No BEGIN/COMMIT wrapper
-- (Wave 23 doctrine — see feedback_migration_no_transaction_wrapper).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — agency_contacts (multiple contacts per agency)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.agency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,

  name text NOT NULL,
  email text,
  phone text,

  -- Free-text role tag. Common values: 'account_manager' | 'strategist'
  -- | 'billing' | 'creative' | 'founder' | 'support' | 'other'. Free-
  -- text so agencies with idiosyncratic structures land without
  -- migration.
  role text,

  -- Coordinator-facing notes about this specific contact ("prefers
  -- Slack over email", "covers maternity Jan-Mar", etc.).
  notes text,

  -- Primary contact for the relationship. At most one per agency
  -- (enforced via partial unique index below). UI surfaces the
  -- primary at the top of the contacts list.
  is_primary boolean NOT NULL DEFAULT false,

  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agency_contacts_name_nonempty
    CHECK (length(trim(name)) > 0)
);

COMMENT ON TABLE public.agency_contacts IS
  'owner:intelligence. Wave 6E depth. One row per human at an agency. '
  'Replaces the single contact_name/email/phone fields on '
  'marketing_agencies (which stay as the canonical primary for back-'
  'compat). Soft-delete preserves who-said-what-when in the activity '
  'log. Migration 306.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_contacts_primary
  ON public.agency_contacts (agency_id)
  WHERE is_primary = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agency_contacts_agency
  ON public.agency_contacts (agency_id)
  WHERE deleted_at IS NULL;

-- ============================================================================
-- STEP 2 — agency_documents (contracts, statements, reports)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.agency_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,
  engagement_id uuid REFERENCES public.venue_agency_engagements(id) ON DELETE SET NULL,

  -- File metadata. file_url points to Supabase Storage (bucket
  -- 'agency-documents' — provisioned via app config, not this
  -- migration). file_size in bytes for UI display.
  name text NOT NULL,
  file_url text,
  file_size_bytes integer,
  mime_type text,

  -- Free-text kind tag. Common values: 'contract' | 'sow' |
  -- 'statement' | 'invoice' | 'monthly_report' | 'quarterly_review' |
  -- 'asset_brief' | 'other'.
  kind text,

  -- Renewal / expiry tracking. NULL when not applicable (e.g. a
  -- one-off monthly report). When set, UI surfaces a 30-day warning.
  effective_date date,
  expires_at date,

  notes text,

  uploaded_by uuid REFERENCES public.user_profiles(id),

  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agency_documents_name_nonempty
    CHECK (length(trim(name)) > 0)
);

COMMENT ON TABLE public.agency_documents IS
  'owner:intelligence. Wave 6E depth. PDF / image / link attachments '
  'for an agency relationship. Backed by Supabase Storage bucket '
  '`agency-documents`. expires_at drives the 30-day renewal warning. '
  'engagement_id is optional — contracts often span engagements; '
  'monthly reports are engagement-scoped. Migration 306.';

CREATE INDEX IF NOT EXISTS idx_agency_documents_agency
  ON public.agency_documents (agency_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agency_documents_expiring
  ON public.agency_documents (expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- STEP 3 — agency_kpi_commitments (what the agency promised)
-- ============================================================================
-- The "they promised X" side of the TBH Report. Bloom stores the
-- commitment; the agency-ROI compute reads it alongside the actuals
-- to produce the truth-vs-claim comparison.

CREATE TABLE IF NOT EXISTS public.agency_kpi_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,
  engagement_id uuid REFERENCES public.venue_agency_engagements(id) ON DELETE SET NULL,

  -- Free-text metric name. Common: 'leads_per_month' |
  -- 'cost_per_lead' | 'tour_conversion_rate' | 'impressions_per_month'.
  -- Free-text so agencies with non-standard KPIs (e.g. "Pinterest
  -- saves") land without schema change.
  metric_name text NOT NULL,

  -- Numeric target. Stored as numeric (not cents) because some KPIs
  -- are counts (47 leads), some are percentages (8.5%), some are
  -- currency (which the unit column disambiguates).
  target_value numeric(18, 4) NOT NULL,

  -- Unit string. 'count' | 'cents' | 'usd' | 'percent' | 'days' |
  -- 'minutes' | 'other'. UI uses for display formatting.
  target_unit text NOT NULL DEFAULT 'count',

  -- Window the KPI is measured over. 'month' | 'quarter' | 'year' |
  -- 'engagement'.
  target_window text NOT NULL DEFAULT 'month',

  -- Optional human description for nuance.
  notes text,

  -- Track whether the commitment is currently active. Setting
  -- effective_to to a past date retires the KPI without deleting it
  -- (preserves historical truth-vs-claim).
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,

  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agency_kpi_commitments_metric_nonempty
    CHECK (length(trim(metric_name)) > 0),
  CONSTRAINT agency_kpi_commitments_dates_valid
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE public.agency_kpi_commitments IS
  'owner:intelligence. Wave 6E depth. What the agency contractually '
  'promised. Lets the TBH Report contrast "promised X" vs "delivered '
  'Y" with the actual data Bloom can compute. effective_from / '
  'effective_to make commitments time-bound so contract renewals '
  'replace old targets without losing history. Migration 306.';

CREATE INDEX IF NOT EXISTS idx_agency_kpi_agency_active
  ON public.agency_kpi_commitments (agency_id)
  WHERE effective_to IS NULL AND deleted_at IS NULL;

-- ============================================================================
-- STEP 4 — agency_activity_log (timeline of decisions)
-- ============================================================================
-- The single notes blob on marketing_agencies isn't a relationship.
-- This is the timeline: "Q2 review on 2026-02-15, agreed to shift
-- 20% to Pinterest" / "renewed contract" / "added Maria as new account
-- manager" / "their monthly report is 8 days late".

CREATE TABLE IF NOT EXISTS public.agency_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,
  engagement_id uuid REFERENCES public.venue_agency_engagements(id) ON DELETE SET NULL,
  venue_id uuid REFERENCES public.venues(id) ON DELETE CASCADE,

  -- The event date the operator wants to remember. Distinct from
  -- created_at (when the row was written). Coordinator might log a
  -- meeting from 3 weeks ago and want the date right.
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- Free-text kind. Common: 'note' | 'meeting' | 'review' |
  -- 'decision' | 'escalation' | 'report_received' | 'report_late' |
  -- 'contract_renewed' | 'channel_change' | 'kpi_set' |
  -- 'kpi_missed' | 'kpi_hit'. Free-text so the operator can write
  -- their own kinds.
  kind text NOT NULL DEFAULT 'note',

  -- Short headline.
  summary text NOT NULL,

  -- Long-form body. Markdown OK.
  body text,

  -- Optional structured payload — e.g. for 'kpi_missed' the kpi_id
  -- + actual vs target. UI inspects this to render the appropriate
  -- visualization.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  recorded_by uuid REFERENCES public.user_profiles(id),

  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agency_activity_log_summary_nonempty
    CHECK (length(trim(summary)) > 0)
);

COMMENT ON TABLE public.agency_activity_log IS
  'owner:intelligence. Wave 6E depth. Append-only timeline of '
  'decisions / meetings / KPI events for an agency relationship. '
  'Replaces the single notes blob with a structured history. Cron '
  'writers (e.g. "monthly report is late") share this table with '
  'human writers. Migration 306.';

CREATE INDEX IF NOT EXISTS idx_agency_activity_log_agency
  ON public.agency_activity_log (agency_id, occurred_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agency_activity_log_engagement
  ON public.agency_activity_log (engagement_id, occurred_at DESC)
  WHERE engagement_id IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- STEP 5 — venue_agency_engagements extensions
-- ============================================================================

ALTER TABLE public.venue_agency_engagements
  ADD COLUMN IF NOT EXISTS channel_sub_budgets jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.venue_agency_engagements.channel_sub_budgets IS
  'Wave 6E depth. JSON object mapping marketing_channels.key → monthly '
  'cents budget. Example: { "google_ads": 150000, "meta_ads": 100000 }. '
  'Sums should equal monthly_fee_cents but the application layer '
  'enforces — DB allows drift so coordinator can record partial '
  'allocations.';

ALTER TABLE public.venue_agency_engagements
  ADD COLUMN IF NOT EXISTS reporting_cadence text;

COMMENT ON COLUMN public.venue_agency_engagements.reporting_cadence IS
  'Wave 6E depth. Free-text label for when the agency reports. '
  'Common: "weekly_email" | "biweekly_call" | "monthly_dashboard" | '
  '"quarterly_review". Drives the "their report is late" flag.';

ALTER TABLE public.venue_agency_engagements
  ADD COLUMN IF NOT EXISTS dashboard_url text;

COMMENT ON COLUMN public.venue_agency_engagements.dashboard_url IS
  'Wave 6E depth. Deep-link to the agency''s own reporting surface '
  '(their Looker / Data Studio / portal). Surface on the agency '
  'detail page next to Bloom''s view so the operator can compare '
  'their numbers to ours.';

-- ============================================================================
-- STEP 6 — RLS (mirror agency entity pattern from migration 304)
-- ============================================================================
-- All four tables follow the same access rule: visible to anyone who
-- can see the parent agency. Implemented as a single subquery against
-- marketing_agencies — RLS on that table already enforces the org /
-- venue / engagement-fanout logic.

-- Helper macro inline — repeat the policy pattern per table.

ALTER TABLE public.agency_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_contacts_select" ON public.agency_contacts;
CREATE POLICY "agency_contacts_select" ON public.agency_contacts
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_contacts_modify" ON public.agency_contacts;
CREATE POLICY "agency_contacts_modify" ON public.agency_contacts
  FOR ALL TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  )
  WITH CHECK (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_contacts_service" ON public.agency_contacts;
CREATE POLICY "agency_contacts_service" ON public.agency_contacts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.agency_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_documents_select" ON public.agency_documents;
CREATE POLICY "agency_documents_select" ON public.agency_documents
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_documents_modify" ON public.agency_documents;
CREATE POLICY "agency_documents_modify" ON public.agency_documents
  FOR ALL TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  )
  WITH CHECK (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_documents_service" ON public.agency_documents;
CREATE POLICY "agency_documents_service" ON public.agency_documents
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.agency_kpi_commitments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_kpi_select" ON public.agency_kpi_commitments;
CREATE POLICY "agency_kpi_select" ON public.agency_kpi_commitments
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_kpi_modify" ON public.agency_kpi_commitments;
CREATE POLICY "agency_kpi_modify" ON public.agency_kpi_commitments
  FOR ALL TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  )
  WITH CHECK (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_kpi_service" ON public.agency_kpi_commitments;
CREATE POLICY "agency_kpi_service" ON public.agency_kpi_commitments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.agency_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_activity_select" ON public.agency_activity_log;
CREATE POLICY "agency_activity_select" ON public.agency_activity_log
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_activity_modify" ON public.agency_activity_log;
CREATE POLICY "agency_activity_modify" ON public.agency_activity_log
  FOR ALL TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  )
  WITH CHECK (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_activity_service" ON public.agency_activity_log;
CREATE POLICY "agency_activity_service" ON public.agency_activity_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- STEP 7 — touch_updated_at triggers
-- ============================================================================

CREATE OR REPLACE FUNCTION public.agency_profile_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agency_contacts_updated_at ON public.agency_contacts;
CREATE TRIGGER trg_agency_contacts_updated_at
  BEFORE UPDATE ON public.agency_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.agency_profile_touch_updated_at();

DROP TRIGGER IF EXISTS trg_agency_documents_updated_at ON public.agency_documents;
CREATE TRIGGER trg_agency_documents_updated_at
  BEFORE UPDATE ON public.agency_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.agency_profile_touch_updated_at();

DROP TRIGGER IF EXISTS trg_agency_kpi_updated_at ON public.agency_kpi_commitments;
CREATE TRIGGER trg_agency_kpi_updated_at
  BEFORE UPDATE ON public.agency_kpi_commitments
  FOR EACH ROW
  EXECUTE FUNCTION public.agency_profile_touch_updated_at();

NOTIFY pgrst, 'reload schema';
