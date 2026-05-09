-- ---------------------------------------------------------------------------
-- 259_handle_merge_decisions.sql
-- ---------------------------------------------------------------------------
-- Audit + dedupe table for the cross-platform handle-merge proposals
-- surfaced by /api/admin/identity/handle-merge-proposals (Wave 2C) and
-- the new coordinator UI (Wave 2D, this migration's companion).
--
-- Why this exists
-- ---------------
-- crossPlatformHandleMerge() in src/lib/services/identity/handle-convergence.ts
-- recomputes proposals on every GET. Without an audit + filter table,
-- a coordinator who rejects a false-positive proposal would see it
-- bubble back up to the top of the list every time they reopen the
-- page. We want decisions to stick: accepted proposals fire the
-- existing merge machinery (mergePeople), rejected proposals stay
-- viewable as audit history but get filtered out of the live list,
-- deferred proposals stay surfaced but at the bottom.
--
-- Handle-merge proposals are keyed by (venue_id, normalised_handle) —
-- the algorithm groups handle observations across platforms under the
-- normalised form ("rosaliehoyle"). One decision per handle per venue.
-- Subsequent re-decisions overwrite the previous row (the coordinator
-- can change their mind), but the FIRST decision is preserved via the
-- decided_at timestamp + the source_records snapshot.
--
-- Constitution invariant: this table is a forensic audit, not a
-- workflow status. It records what the coordinator decided AND the
-- record IDs that converged on the handle at decision time, so a
-- future audit can reconstruct "which records were merged together
-- when this handle decision was made" even if records are later
-- re-merged or split.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS public.handle_merge_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- The normalised handle the proposal was anchored to. Mirrors the
  -- normaliseHandle() output in handle-convergence.ts (lower-case,
  -- leading punctuation stripped, trailing decoration trimmed).
  -- Stored normalised so the unique index works across platform-
  -- decoration variations (@rosaliehoyle vs rosaliehoyle vs
  -- ROSALIEHOYLE all collapse to the same row).
  handle_normalised text NOT NULL,

  decision text NOT NULL
    CHECK (decision IN ('accepted', 'rejected', 'deferred')),

  -- coordinator user id (auth.users). Nullable for system-generated
  -- decisions that may surface in the future (e.g. confidence cap
  -- auto-defer). Manual decisions always populate this.
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),

  -- Snapshot of the record IDs converging on this handle at decision
  -- time. Shape: { records: [{kind, recordId, platform, ...}], score,
  -- platforms, mixed }. Mirrors HandleMergeProposal in
  -- handle-convergence.ts so a future audit can reconstruct the
  -- proposal exactly. jsonb so the auditor can drill into platforms
  -- without parsing.
  source_records jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- For accepted decisions: the merge result identifiers from
  -- mergePeople (one merge per pair). Coordinator may accept a
  -- proposal that spans 3+ records → fan-out into N-1 pairwise
  -- merges. Stored as an array so the audit row carries every merge
  -- id created from this single decision. Empty for rejected/deferred.
  merge_ids uuid[] NOT NULL DEFAULT '{}',

  -- Optional human note (why rejected, why deferred). Surfaced on
  -- the audit list view.
  note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One decision row per (venue, handle). Subsequent re-decisions UPDATE
-- the row in place; the original decided_at carries forward via
-- UPSERT semantics in the API handler (the handler only updates
-- decision/decided_by/decided_at/source_records; it does not reset
-- created_at).
CREATE UNIQUE INDEX IF NOT EXISTS uq_handle_merge_decisions_venue_handle
  ON public.handle_merge_decisions (venue_id, handle_normalised);

-- Lookup index for "all decisions for this venue, most-recent first"
-- (audit list view).
CREATE INDEX IF NOT EXISTS idx_handle_merge_decisions_venue_decided_at
  ON public.handle_merge_decisions (venue_id, decided_at DESC);

COMMENT ON TABLE public.handle_merge_decisions IS
  'Audit + dedupe table for cross-platform handle-merge proposals '
  '(migration 259). Filters /api/admin/identity/handle-merge-proposals '
  'so accepted/rejected proposals do not re-surface. Forensic record '
  'of every coordinator decision; never hard-deleted.';

COMMENT ON COLUMN public.handle_merge_decisions.handle_normalised IS
  'Lower-cased, decoration-stripped handle. Mirrors normaliseHandle() '
  'in src/lib/services/identity/handle-convergence.ts.';

COMMENT ON COLUMN public.handle_merge_decisions.decision IS
  'accepted | rejected | deferred. accepted fires mergePeople for '
  'each pair of records on the proposal. rejected stays as audit but '
  'is filtered from the live list. deferred stays in the live list '
  'but sinks to the bottom.';

COMMENT ON COLUMN public.handle_merge_decisions.source_records IS
  'Snapshot of HandleMergeProposal at decision time. Lets a future '
  'audit reconstruct exactly which records the coordinator was '
  'looking at when they decided.';

COMMENT ON COLUMN public.handle_merge_decisions.merge_ids IS
  'For accepted decisions: the person_merges row ids created by '
  'fanning out the multi-record proposal into pairwise mergePeople '
  'calls. Empty array for rejected/deferred.';

-- ---------------------------------------------------------------------------
-- RLS — auth-permissive baseline (mirrors migration 245).
-- ---------------------------------------------------------------------------

ALTER TABLE public.handle_merge_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_handle_merge_decisions"
  ON public.handle_merge_decisions;
CREATE POLICY "auth_select_handle_merge_decisions" ON public.handle_merge_decisions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_handle_merge_decisions"
  ON public.handle_merge_decisions;
CREATE POLICY "auth_insert_handle_merge_decisions" ON public.handle_merge_decisions
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_handle_merge_decisions"
  ON public.handle_merge_decisions;
CREATE POLICY "auth_update_handle_merge_decisions" ON public.handle_merge_decisions
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_handle_merge_decisions"
  ON public.handle_merge_decisions;
CREATE POLICY "auth_delete_handle_merge_decisions" ON public.handle_merge_decisions
  FOR DELETE TO authenticated USING (true);

COMMIT;

NOTIFY pgrst, 'reload schema';
