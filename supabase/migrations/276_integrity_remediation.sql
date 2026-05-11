-- ============================================================================
-- 276_integrity_remediation.sql
-- ============================================================================
-- Wave 9 — data integrity remediation surface.
--
-- Anchor docs:
--   - bloom-data-integrity-sweep.md (the 9 invariants live in
--     src/lib/services/data-integrity.ts; detection has shipped — this
--     migration adds the remediation/audit surface so the operator has
--     a STRUCTURAL fix path instead of raw SQL band-aids).
--   - feedback_deep_fix_vs_bandaid.md (one click per anomaly, idempotent
--     fix, audit trail preserved — not raw SQL, not a curated rule list).
--   - bloom-wave4-identity-reconstruction.md (mirrors Wave 4 Phase 3
--     pattern: one source of truth, idempotent operator action, audit
--     trail — the syncProfileToPeople call this remediation invokes is
--     the same shape).
--
-- What this migration creates
-- ---------------------------
-- public.integrity_remediations — one row per remediation run (one
-- venue × one invariant × one mode). Tracks violations detected vs
-- fixed vs skipped, sample before/after, the operator (or NULL when
-- fired by cron), errors, and the strategy used.
--
-- The detector (data-integrity.ts) is untouched; this is a sibling
-- surface. The remediation service in src/lib/services/data-integrity/
-- remediation/ reads detector output and applies one of four
-- tier-based fixes per invariant.
--
-- Idempotency: a remediation run is one row; re-running on a clean
-- venue produces a row with violations_detected=0 and violations_fixed=0.
-- The fix sub-routines are idempotent at the data layer (check
-- predicate before/after each fix).
--
-- Constitution invariant: NEVER hard-delete. The wedding_has_people
-- Tier 3 path tombstones via weddings.merged_into_id (already added
-- by migration 257). Audit history preserved here in
-- integrity_remediations.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.integrity_remediations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Free text per invariant — kept open so future invariants don't need
  -- a migration to add. Matches the InvariantResult.id values from
  -- src/lib/services/data-integrity.ts (wedding_has_people,
  -- direction_from_venue_own, inquiry_date_drift,
  -- touchpoint_source_consistency, …). New invariants land here without
  -- a schema change.
  invariant_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  violations_detected integer NOT NULL DEFAULT 0,
  violations_fixed integer NOT NULL DEFAULT 0,
  -- Counts of violations that the remediation chose not to fix —
  -- e.g. true orphan weddings with no profile and no interactions,
  -- which require coordinator judgment before tombstone, or weddings
  -- with no inbound at all (CRM-imported) where inquiry_date drift
  -- cannot be corrected without a signal. skip_reasons surfaces the
  -- breakdown for the admin page.
  violations_skipped integer NOT NULL DEFAULT 0,
  skip_reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Short human-readable description of the strategy used. Surfaces
  -- on the admin page next to the run.
  fix_strategy text NOT NULL,
  -- Preview of the violations BEFORE the fix (up to 10). Used by the
  -- admin page to show the operator what the fix is about to touch.
  -- For dry_run, this is the full set of violations the fix would
  -- have touched.
  sample_before jsonb,
  -- Preview of the same rows AFTER the fix (up to 10). NULL for
  -- dry_run runs.
  sample_after jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- NULL when fired by cron; populated when fired by an operator from
  -- the admin page. Used to show "Fixed by X" attribution.
  operator_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb
);

COMMENT ON TABLE public.integrity_remediations IS
  'owner:agent. Wave 9 — data integrity remediation audit trail. One '
  'row per remediation run (venue × invariant × mode). Detection lives '
  'in src/lib/services/data-integrity.ts; remediation in '
  'src/lib/services/data-integrity/remediation/. Migration 276.';

COMMENT ON COLUMN public.integrity_remediations.invariant_id IS
  'Matches InvariantResult.id from data-integrity.ts. Free text so new '
  'invariants don''t require a migration. Current values: '
  'wedding_has_people, direction_from_venue_own, inquiry_date_drift, '
  'touchpoint_source_consistency.';

COMMENT ON COLUMN public.integrity_remediations.mode IS
  'dry_run: detect + preview only, no writes. apply: detect + write. '
  'Cron defaults to dry_run unless venue opts in via '
  'venue_config.feature_flags.integrity_auto_remediate=true.';

COMMENT ON COLUMN public.integrity_remediations.fix_strategy IS
  'Short description of HOW each violation was fixed in this run '
  '(e.g. "Tier 1: profile->people sync (12), Tier 2: synth partner1 '
  'from interaction (3), Tier 3: tombstone (1)").';

COMMENT ON COLUMN public.integrity_remediations.skip_reasons IS
  'Per-skip-reason counts as JSON object. E.g. '
  '{ "no_profile_no_interactions": 2, "manual_judgment_required": 0 }';

COMMENT ON COLUMN public.integrity_remediations.operator_id IS
  'NULL when fired by cron sweep. Populated when fired via the admin '
  'page so the run history shows "Fixed by X".';

-- Per-venue, per-invariant timeline — the admin page's most-common
-- query (history of runs for one invariant on one venue).
CREATE INDEX IF NOT EXISTS idx_integrity_remediations_venue_inv_time
  ON public.integrity_remediations (venue_id, invariant_id, started_at DESC);

COMMENT ON INDEX public.idx_integrity_remediations_venue_inv_time IS
  'Admin page history query: rows for (venue, invariant) newest first.';

-- ============================================================================
-- RLS — venue-scoped (mirrors import_runs pattern from migration 270)
-- ============================================================================

ALTER TABLE public.integrity_remediations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "integrity_remediations_auth_select" ON public.integrity_remediations;
CREATE POLICY "integrity_remediations_auth_select"
  ON public.integrity_remediations
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "integrity_remediations_auth_insert" ON public.integrity_remediations;
CREATE POLICY "integrity_remediations_auth_insert"
  ON public.integrity_remediations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "integrity_remediations_auth_update" ON public.integrity_remediations;
CREATE POLICY "integrity_remediations_auth_update"
  ON public.integrity_remediations
  FOR UPDATE
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

-- Service-role writes (cron sweep) bypass RLS by design (the service
-- client used by the cron path bypasses RLS entirely; no policy needed
-- to enable that). The auth_insert/auth_update policies above let an
-- authenticated coordinator hit the admin endpoint and have it succeed
-- without service-role escalation when the endpoint chooses to use the
-- session client (most don't — they use service-role + manual venue
-- scoping per auth-helpers.ts).

COMMIT;

NOTIFY pgrst, 'reload schema';
