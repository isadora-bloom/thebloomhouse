-- ---------------------------------------------------------------------------
-- 277_identity_decision_clusters.sql  (Wave 10)
-- ---------------------------------------------------------------------------
-- Person-keyed audit log for the identity decision UX. Wave 10 elevates
-- the handle-merge surface from "one row per handle" to "one row per
-- real person" by clustering converging handle proposals together
-- BEFORE presenting to the operator.
--
-- The bug Wave 10 closes
-- ----------------------
-- "Jamie B" appeared as 4 separate proposals on
-- /admin/identity/handle-merges — one per cross-platform handle she
-- has (gmail / Knot inbox / Calendly / phone). Operator clicked accept
-- on one → the underlying mergePeople ran for that handle's records →
-- canonical Jamie B emerged → the other 3 proposals disappeared on
-- refresh because their records now resolved to the same canonical.
-- No data lost, but the UX presented 4 decisions when 1 was needed.
--
-- What this table is
-- ------------------
-- A forensic audit row per CLUSTER decision the operator makes.
-- Where handle_merge_decisions (mig 259) is keyed by normalised handle,
-- this is keyed by cluster_key (the canonical_person_id OR the
-- strongest shared identifier when no people row exists yet).
--
-- One operator decision can fan out into many handle-level merges; the
-- audit row carries the full picture (handles_involved jsonb) so a
-- future auditor can reconstruct "which handles were swept together
-- when this cluster was accepted/rejected/deferred".
--
-- Relationship to mig 259
-- -----------------------
-- mig 259 (handle_merge_decisions) is still the source of truth for
-- per-handle decisions — accept-cluster fans out into N handle accepts
-- and writes N rows to mig 259 PLUS one cluster row here. Rejecting a
-- cluster writes N rejected rows to mig 259 and one rejected row here.
-- The cluster row is the operator-facing decision; the handle rows
-- are the underlying primitives.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS public.identity_decision_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Stable identifier for the cluster within a venue. Either the
  -- canonical_person_id (when the cluster centres on a known people
  -- row) or the strongest shared identifier (email / phone /
  -- normalized first+last) when no person row exists yet (the
  -- pre-zero candidate-only case). See clusterProposalsByPerson() in
  -- src/lib/services/identity/decision-clustering/cluster-proposals.ts
  -- for the derivation rules.
  cluster_key text NOT NULL,

  -- When the cluster centres on a known canonical person, that id.
  -- Null when the cluster is candidate-only / pre-zero.
  canonical_person_id uuid REFERENCES public.people(id) ON DELETE SET NULL,

  -- jsonb array — one element per handle the cluster covers. Shape:
  --   [{ handle: string, platforms: string[], score: number,
  --      recordCount: number }, ...]
  -- Mirrors PersonCluster.handles in the clustering service.
  handles_involved jsonb NOT NULL,

  total_records int NOT NULL,
  aggregate_score numeric(5,2) NOT NULL,

  decision text NOT NULL
    CHECK (decision IN ('accepted', 'rejected', 'deferred')),

  decision_note text,

  -- For accepted decisions: pointers back to the handle_merge_decisions
  -- rows the cluster-accept created. Shape:
  --   [{ handle: string, decision_id: uuid, merge_ids: uuid[] }, ...]
  -- Lets the audit trail walk cluster → handle → person_merges.
  applied_handle_merges jsonb,

  decided_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Lookup by venue + recency (history page).
CREATE INDEX IF NOT EXISTS idx_identity_decision_clusters_venue_decided_at
  ON public.identity_decision_clusters (venue_id, decided_at DESC);

-- Lookup by canonical person (audit: "every cluster decision involving
-- this person").
CREATE INDEX IF NOT EXISTS idx_identity_decision_clusters_venue_person
  ON public.identity_decision_clusters (venue_id, canonical_person_id);

COMMENT ON TABLE public.identity_decision_clusters IS
  'Wave 10 — person-keyed audit log for the identity decision UX. '
  'One row per operator cluster-decision; the underlying per-handle '
  'decisions live in handle_merge_decisions (mig 259). cluster_key is '
  'canonical_person_id when known, else strongest shared identifier.';

COMMENT ON COLUMN public.identity_decision_clusters.cluster_key IS
  'Either canonical_person_id (UUID as text) or strongest shared '
  'identifier (email / phone / normalized name). Stable within a '
  'venue for re-decision idempotency.';

COMMENT ON COLUMN public.identity_decision_clusters.handles_involved IS
  'jsonb array of { handle, platforms, score, recordCount } — every '
  'handle the cluster covered at decision time. Forensic snapshot.';

COMMENT ON COLUMN public.identity_decision_clusters.applied_handle_merges IS
  'For accepted decisions: pointers to the handle_merge_decisions '
  'rows + the person_merges row ids each handle-accept produced. '
  'Empty/null for rejected/deferred.';

-- ---------------------------------------------------------------------------
-- RLS — mirrors mig 259 / mig 245 (auth-permissive baseline; service
-- role bypasses).
-- ---------------------------------------------------------------------------

ALTER TABLE public.identity_decision_clusters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_identity_decision_clusters"
  ON public.identity_decision_clusters;
CREATE POLICY "auth_select_identity_decision_clusters"
  ON public.identity_decision_clusters
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_identity_decision_clusters"
  ON public.identity_decision_clusters;
CREATE POLICY "auth_insert_identity_decision_clusters"
  ON public.identity_decision_clusters
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_identity_decision_clusters"
  ON public.identity_decision_clusters;
CREATE POLICY "auth_update_identity_decision_clusters"
  ON public.identity_decision_clusters
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_identity_decision_clusters"
  ON public.identity_decision_clusters;
CREATE POLICY "auth_delete_identity_decision_clusters"
  ON public.identity_decision_clusters
  FOR DELETE TO authenticated USING (true);

COMMIT;

NOTIFY pgrst, 'reload schema';
