-- ---------------------------------------------------------------------------
-- 177_identity_reconciliation.sql
-- ---------------------------------------------------------------------------
-- Stream KK (T5-Rixey-KK) — cross-source identity reconciliation +
-- lead-source derivation. The capstone of the wave-7 multi-source
-- import work.
--
-- Why this exists. Onboarding Rixey landed three lead-source files:
-- HoneyBook (94 projects), Calendly (417 events / 256 tours), web
-- calculator (443 submissions). Many leads appear in MULTIPLE sources
-- — same email, sometimes name-only matches, sometimes phone-only.
-- Without an automated post-import reconciliation step, those three
-- imports produce ~950 duplicate weddings rows for ~250 actual unique
-- couples. Constitution principle: Bloom is forensic identity
-- reconstruction, not CRM. Multiple-source convergence on one human
-- is the *core* problem the platform exists to solve. Every venue
-- with multiple lead sources hits this; building the reconciliation
-- as a first-class platform capability not a Rixey one-off.
--
-- Constitution invariant. Losers are NEVER hard-deleted. weddings.merged_into_id
-- carries the loser→winner pointer so:
--   - the forensic record stays intact (audit trail; coordinator can
--     undo a bad merge),
--   - downstream queries SELECT WHERE merged_into_id IS NULL to get
--     the active set without seeing duplicates,
--   - the source_records jsonb on the winner records which source
--     contributed which fields after the merge.
--
-- Schema additions (all idempotent via IF NOT EXISTS):
--
--   weddings.merged_into_id (uuid, FK self):
--     When set, this row is a loser in a reconciliation merge. Points
--     at the winner. Active queries filter on IS NULL.
--
--   weddings.source_records (jsonb, default '[]'):
--     Provenance log: array of {source, source_id, imported_at,
--     fields_provided: ['lead_source', 'estimated_guests', ...]}
--     entries. Tells you which fields originally came from which
--     source.
--
--   weddings.attribution_priority (jsonb, default NULL):
--     Coordinator override of source priority for this specific
--     wedding (rarely used). When set, lead_source derivation respects
--     it instead of the default priority chain.
--
--   weddings.lead_source (text, default NULL):
--     Derived first-touch lead source (the_knot, calendly_q,
--     instagram, etc.). Computed by the daily derive_lead_source cron
--     using the priority chain. NEVER overwrites a coordinator-set
--     value (attribution_priority guards against re-derivation).
--
--   idx_weddings_active:
--     Partial index on (venue_id, merged_into_id) WHERE
--     merged_into_id IS NULL. The active-set query pattern is hit by
--     every coordinator surface.
--
--   lead_source_derivation_log (new table):
--     Append-only audit per derivation. Coordinator-visible at
--     /intel/clients/[id]: "Lead source derived from: Calendly tour
--     Q7 'Where did you hear about us' = 'The Knot' (high confidence)".
--     Coordinator can override + the override stamps
--     weddings.attribution_priority so future re-derivation respects
--     it.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — weddings source-tracking columns (idempotent)
-- ============================================================================

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.weddings.merged_into_id IS
  'Reconciliation loser → winner pointer. NULL = active row. NOT NULL '
  '= duplicate consolidated into the referenced winner. Forensic '
  'record preserved per Constitution; never hard-delete losers. Set by '
  'src/lib/services/identity-reconciliation.ts. Migration 177.';

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS source_records jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.weddings.source_records IS
  'Provenance log: array of {source, source_id, imported_at, '
  'fields_provided}. After reconciliation, the winner accumulates one '
  'entry per merged loser so audit can show which source contributed '
  'which fields. Migration 177.';

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS attribution_priority jsonb DEFAULT NULL;

COMMENT ON COLUMN public.weddings.attribution_priority IS
  'Coordinator override of the lead_source derivation priority chain '
  'for this specific wedding. Rarely set. When non-null, the daily '
  'derive_lead_source cron uses this list instead of the platform '
  'default. Shape: {priority: ["calendly_qa", "calculator", ...], '
  'set_by: uuid, set_at: timestamptz, reason?: text}. Migration 177.';

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS lead_source text DEFAULT NULL;

COMMENT ON COLUMN public.weddings.lead_source IS
  'Derived first-touch lead source — different from the legacy '
  '`source` enum-bound column (which Phase B says NEVER overwrite). '
  '`lead_source` is free-text + may carry richer values (e.g. '
  '"the_knot", "calendly_qa:google", "calculator", "email_domain:gmail"). '
  'Written by derive_lead_source cron + reconciliation backfill. '
  'attribution_priority overrides the default chain. Migration 177.';

CREATE INDEX IF NOT EXISTS idx_weddings_active
  ON public.weddings (venue_id, merged_into_id)
  WHERE merged_into_id IS NULL;

COMMENT ON INDEX public.idx_weddings_active IS
  'Partial index on the active-set query pattern: every coordinator '
  'surface filters on (venue_id, merged_into_id IS NULL). Migration 177.';

CREATE INDEX IF NOT EXISTS idx_weddings_merged_into
  ON public.weddings (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

COMMENT ON INDEX public.idx_weddings_merged_into IS
  'Reverse-pointer lookup: given a winner, find all losers that point '
  'at it. Used by audit + undo paths. Migration 177.';

-- ============================================================================
-- STEP 2 — lead_source_derivation_log table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.lead_source_derivation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  derived_at timestamptz NOT NULL DEFAULT now(),
  -- The lead source value the derivation produced. NULL when the
  -- chain ran out of evidence (priority 6 = no_signal).
  derived_source text,
  -- Which priority slot fired (1..6). 0 means coordinator override
  -- via attribution_priority short-circuited the chain.
  priority_used integer NOT NULL CHECK (priority_used >= 0 AND priority_used <= 6),
  -- Free-form evidence payload — Q&A row, email-domain string, UTM
  -- tag, etc. Shape varies per priority.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Confidence band the derivation logic places on this attribution.
  -- Tier 1-2 (explicit lead_source / Calendly Q&A) = high. Tier 3-4
  -- (web form / email domain) = medium. Tier 5-6 (UTM only / no
  -- signal) = low.
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  -- 'auto' = cron run. 'coordinator' = manual override. 'reconcile'
  -- = post-merge backfill from a loser source_record.
  decided_by text NOT NULL DEFAULT 'auto'
    CHECK (decided_by IN ('auto', 'coordinator', 'reconcile')),
  -- Who clicked override (coordinator path only). NULL otherwise.
  decided_by_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  -- Optional human reason on coordinator overrides.
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.lead_source_derivation_log IS
  'Append-only audit per lead_source derivation decision. Coordinator-'
  'visible at /intel/clients/[id]: "Lead source derived from: Calendly '
  'tour Q7 ''Where did you hear about us'' = ''The Knot'' (high '
  'confidence)". Coordinator override stamps weddings.attribution_priority '
  'so future re-derivation respects it. Migration 177.';

CREATE INDEX IF NOT EXISTS idx_lead_source_derivation_log_wedding
  ON public.lead_source_derivation_log (wedding_id, derived_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_source_derivation_log_venue
  ON public.lead_source_derivation_log (venue_id, derived_at DESC);

-- ============================================================================
-- STEP 3 — RLS
-- ============================================================================
-- weddings RLS already covers the new columns (column-level RLS is
-- not used; the table-level policy applies to all columns).
--
-- lead_source_derivation_log gets a venue-scoped policy mirror — read
-- + write inside the venue's company scope.

ALTER TABLE public.lead_source_derivation_log ENABLE ROW LEVEL SECURITY;

-- Service-role bypass for cron + reconciliation writes.
DROP POLICY IF EXISTS lsdl_service_all ON public.lead_source_derivation_log;
CREATE POLICY lsdl_service_all ON public.lead_source_derivation_log
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Coordinator read scope mirrors marketing_channels / onboarding_projects:
-- venue_id IN visible-venues + super-admin escape hatch.
DROP POLICY IF EXISTS lsdl_authenticated_select
  ON public.lead_source_derivation_log;
CREATE POLICY lsdl_authenticated_select ON public.lead_source_derivation_log
  FOR SELECT TO authenticated
  USING (
    venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  );

-- Coordinator-initiated overrides write through an authenticated POST
-- handler. WITH CHECK enforces venue scope for non-service writers.
DROP POLICY IF EXISTS lsdl_authenticated_insert
  ON public.lead_source_derivation_log;
CREATE POLICY lsdl_authenticated_insert ON public.lead_source_derivation_log
  FOR INSERT TO authenticated
  WITH CHECK (
    venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  );

-- ============================================================================
-- STEP 4 — onboarding step key registration (for the project-flow UI)
-- ============================================================================
-- The reconciliation step is wired into onboarding-project.ts as a
-- new Day-3 step. No schema change needed; left here as a marker
-- comment so future migrations know the new step key
-- ('identity_reconciliation') was introduced in 177.
