-- ---------------------------------------------------------------------------
-- 335_crm_import_rows.sql
-- ---------------------------------------------------------------------------
-- Recurring CSV import dedup layer.
-- Anchor: memory/bloom-recurring-csv-import-doctrine.md (2026-05-13).
--
-- Problem this solves
-- -------------------
-- Venues will upload Knot / HoneyBook / WeddingWire / Zola exports weekly
-- with rolling-12-month windows — ~95% of every upload overlaps the
-- previous one. The existing src/lib/services/crm-import/index.ts has
-- NO "I already saw this row" memory. A re-upload either:
--   - Catches the overlap by accidental email/phone match (fragile;
--     breaks when the existing wedding has '(Unknown)' partner1)
--   - Mints a duplicate wedding (contaminates the dataset)
-- And tour-scheduler.ts (Calendly CSV) has the same gap: re-importing
-- the same CSV today would insert 200 duplicate interactions because
-- the interactions writer at crm-import/index.ts:817 is a plain
-- .insert(), not an upsert (despite the synth body containing
-- event_uuid:<UUID> — that's text in the body, not a DB constraint).
--
-- Design (the doctrine has the full version; this is the schema half)
-- ---------------------------------------------------------------------
--   row_fingerprint = sha256 over the IDENTITY of a row, stable across
--     re-exports. Priority chain:
--       1. normalised_email + inquiry_date_YYYY_MM_DD
--       2. normalised_phone + inquiry_date
--       3. normalised_full_name + wedding_date
--     For Calendly: event_uuid alone (sufficient — Calendly mints
--     unique UUIDs per booking).
--   content_hash = sha256 over STATE fields ONLY: status,
--     wedding_date, guest_count, budget, tour_scheduled_for, canceled.
--     Excludes timestamps, casing, whitespace — trivial export
--     differences don't trigger fake diffs.
--
-- Decision tree per CSV row at import:
--   fingerprint NEW → run Layer 2 resolution chain → insert this row
--     with resolved_wedding_id + resolution. One touchpoint per row
--     (the initial signal).
--   fingerprint EXISTS, content_hash SAME → bump last_seen_at, noop.
--   fingerprint EXISTS, content_hash DIFFERS → diff state-significant
--     fields, append to state_history, write ONE touchpoint
--     describing the state change.
--
-- The actual fingerprint and content_hash computation lives in
-- src/lib/services/crm-import/import-rows.ts. This migration just
-- creates the table + unique constraint + supporting indexes.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS crm_import_rows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,

  -- Which adapter wrote this row. Mirrors the crm_source enum
  -- accepted by commitNormalisedRows (honeybook / dubsado /
  -- aisle_planner / generic_csv / web_form) plus tour_scheduler for
  -- Calendly/Acuity/iCal and platform_csv values knot / wedding_wire /
  -- zola once those adapters land. Kept as text so new adapters can
  -- be added without a migration; the CI guard in
  -- scripts/check-adapter-source-justification.mjs validates the set.
  source              text NOT NULL CHECK (length(source) <= 32),

  -- IDENTITY hash. Stable across re-uploads. UNIQUE per (venue, source).
  row_fingerprint     text NOT NULL CHECK (length(row_fingerprint) = 64),

  -- STATE hash. Mutates only when a state-significant field on the
  -- row actually changed. Stored as the LATEST observed hash.
  content_hash        text NOT NULL CHECK (length(content_hash) = 64),

  -- Snapshot of the latest CSV row (jsonb of the parsed fields the
  -- adapter cared about). Operator UI reads this to show "what the
  -- last upload claimed". Always the most recent.
  row_data            jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Append-only history of state diffs. Each entry shape:
  --   { seen_at: timestamptz,
  --     content_hash: text,
  --     diff: { fieldName: [oldValue, newValue], ... } }
  -- Excludes the initial sighting (that's first_seen_at + row_data).
  -- Capped at 50 entries server-side; older entries get summarised.
  state_history       jsonb NOT NULL DEFAULT '[]'::jsonb,

  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),

  -- The wedding this row landed on. Null only when resolution =
  -- 'flagged' (operator hasn't picked yet) or 'rejected' (operator
  -- said "this row isn't a real lead"). All other resolutions
  -- guarantee a non-null FK.
  resolved_wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,

  -- Resolution outcome from the Layer 2 chain (or operator action).
  --   attached_strong   — email/phone match against existing wedding
  --   attached_medium   — name+date fuzzy match (≥0.75 jaccard, ±30d)
  --   flagged           — ambiguous; operator review queue
  --   minted_new        — no match; mintWedding fired
  --   rejected          — operator said "this isn't a real lead";
  --                       future re-uploads of same fingerprint skip
  resolution          text NOT NULL DEFAULT 'flagged' CHECK (resolution IN (
    'attached_strong',
    'attached_medium',
    'flagged',
    'minted_new',
    'rejected'
  )),

  -- Operator-readable reason. Free-text. Populated by Layer 2 with
  -- the rule that fired ("email exact match", "no signal — minted").
  resolution_reason   text,

  -- Audit: who resolved this if operator-driven (NULL = automatic).
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at         timestamptz
);

-- The hard idempotency primitive. Re-upload of the SAME row from the
-- SAME source at the SAME venue is a no-op short-circuit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_import_rows_fingerprint
  ON crm_import_rows (venue_id, source, row_fingerprint);

-- Operator queue queries: "show me all flagged rows at this venue".
CREATE INDEX IF NOT EXISTS ix_crm_import_rows_flagged
  ON crm_import_rows (venue_id, resolution, last_seen_at DESC)
  WHERE resolution = 'flagged';

-- Resolution-chain queries: when a couple_identity_profile upgrades
-- name_quality, the post-discovery consolidation job (Gap 2 in
-- bloom-may13-late-session.md) needs to scan all CRM rows at the
-- venue regardless of which wedding they landed on.
CREATE INDEX IF NOT EXISTS ix_crm_import_rows_venue_wedding
  ON crm_import_rows (venue_id, resolved_wedding_id)
  WHERE resolved_wedding_id IS NOT NULL;

-- RLS — same shape as venue_agency_engagements (migration 304).
-- Single-venue users join via user_profiles.venue_id; org-wide users
-- join via user_profiles.org_id = venues.org_id; super-admins bypass.
ALTER TABLE crm_import_rows ENABLE ROW LEVEL SECURITY;

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

-- Service-role bypass for the import pipeline + crons.
DROP POLICY IF EXISTS "crm_import_rows_service" ON public.crm_import_rows;
CREATE POLICY "crm_import_rows_service" ON public.crm_import_rows
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Demo venues read-only for anon (matches the pattern from mig 304).
DROP POLICY IF EXISTS "demo_anon_select_crm_import_rows" ON public.crm_import_rows;
CREATE POLICY "demo_anon_select_crm_import_rows" ON public.crm_import_rows
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMENT ON TABLE crm_import_rows IS
  'Dedup layer for recurring CSV imports (Knot/HoneyBook/WW/Zola/Calendly). '
  'row_fingerprint = stable identity hash; content_hash = state hash that '
  'mutates on meaningful field changes. UNIQUE(venue_id, source, row_fingerprint) '
  'makes re-upload of the same row a no-op. See memory/bloom-recurring-csv-import-doctrine.md.';

COMMENT ON COLUMN crm_import_rows.row_fingerprint IS
  'sha256(64 hex chars). Priority chain: email+inquiry_date / phone+inquiry_date / '
  'name+wedding_date. Calendly uses event_uuid alone.';

COMMENT ON COLUMN crm_import_rows.content_hash IS
  'sha256(64 hex chars) over state-significant fields ONLY: status, wedding_date, '
  'guest_count, budget, tour_scheduled_for, canceled. Excludes timestamps + casing '
  '+ whitespace so trivial export-format diffs do not trigger fake state changes.';

COMMENT ON COLUMN crm_import_rows.state_history IS
  'Append-only [{seen_at, content_hash, diff}]. Capped at 50 entries server-side. '
  'Each diff is {fieldName: [old, new]} over state-significant fields only.';
