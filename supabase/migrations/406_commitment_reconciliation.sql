-- 406_commitment_reconciliation.sql
--
-- W50 / the groom's cake.
--
-- A couple writes "we're having a groom's cake" in an email to the
-- coordinator. It is read once. On the day there is no cake table, no
-- cake, and nobody remembers being told. The sentence was captured
-- nowhere, so nothing could reconcile it against the day-of timeline.
--
-- Two changes here, both small:
--
--   1. planning_notes gains a source interaction. Until now a note could
--      only come from a couple's Sage message or a contract PDF, and the
--      row recorded no pointer back to what produced it. Notes written
--      from a coordinator-venue conversation need that pointer for two
--      reasons: the coordinator wants to click through to the message
--      that said it, and the writer needs somewhere to look to stay
--      idempotent when the same interaction is replayed.
--
--   2. commitment_reconciliation holds the nightly answer to "what have
--      they told us that is not on the day yet". One row per captured
--      commitment per wedding, keyed by a stable hash of the sentence so
--      a rerun updates rather than duplicates.
--
-- Numbering: the fleet integrator reserved 406 for this workstream. The
-- tree's highest committed migration at the time of writing is 394; the
-- gap belongs to sibling workstreams that had not landed yet.
--
-- Schema-qualified on purpose: scripts/run-migration.ts drives
-- public.exec_sql, which runs with search_path = pg_catalog, public. An
-- unqualified CREATE lands in the first schema on that path and fails
-- with 42501.
--
-- No BEGIN/COMMIT — exec_sql wraps each statement itself.

-- ---------------------------------------------------------------------------
-- 1. planning_notes: where did this note come from
-- ---------------------------------------------------------------------------

ALTER TABLE public.planning_notes
  ADD COLUMN IF NOT EXISTS source_interaction_id uuid
    REFERENCES public.interactions(id) ON DELETE SET NULL;

ALTER TABLE public.planning_notes
  ADD COLUMN IF NOT EXISTS source_channel text;

COMMENT ON COLUMN public.planning_notes.source_interaction_id IS
  'The inbound interaction this note was extracted from, when it came from a coordinator-venue conversation rather than a Sage chat message or a contract. Doubles as the idempotency key: the writer in services/intel/planning-extraction.ts refuses to extract twice from the same interaction.';

COMMENT ON COLUMN public.planning_notes.source_channel IS
  'Channel the source conversation arrived on (email / sms / instagram). Null for the legacy chatbot and contract writers.';

-- Deliberately NOT unique. A single email can legitimately carry several
-- planning notes ("we booked the florist AND we're having a groom's cake").
-- Idempotency is enforced by the writer reading this index before it
-- extracts, not by the database refusing the second row. A partial unique
-- index here would also break any future .upsert({onConflict}) against
-- this table with 42P10.
CREATE INDEX IF NOT EXISTS idx_planning_notes_source_interaction
  ON public.planning_notes (source_interaction_id)
  WHERE source_interaction_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1b. timeline.config_json, declared at last
-- ---------------------------------------------------------------------------
--
-- The couple's timeline builder has written `config_json` since it was
-- built, and the coordinator print view reads it, but no migration ever
-- declared the column. It exists in production and nowhere in this
-- directory, which is exactly the phantom-column class the schema-truth
-- check hunts for. The reconciler has to read it, so declare it.
--
-- IF NOT EXISTS, so this is a no-op against production and a fix against
-- any database built from this directory alone.

ALTER TABLE public.timeline
  ADD COLUMN IF NOT EXISTS config_json jsonb;

COMMENT ON COLUMN public.timeline.config_json IS
  'Config-blob mode: { config, events, customEvents } for the whole day, one row per wedding, written by the couple timeline builder. The table is dual-mode (see migration 076 and 188) — other rows are per-event and leave this null. services/commitments/timeline-read.ts is the reader that understands both.';

-- ---------------------------------------------------------------------------
-- 2. commitment_reconciliation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.commitment_reconciliation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,

  -- Stable identity of the sentence. FNV-1a 32-bit of the normalised
  -- quote, computed in services/commitments/reconcile.ts. Rewording the
  -- same commitment produces a new row; that is the intended behaviour,
  -- because the coordinator should see the words the couple used.
  commitment_key text NOT NULL,

  -- What they said, in their words. This is what the coordinator reads.
  quote text NOT NULL,

  -- 'intention' | 'special_request' | 'planning_note'
  kind text NOT NULL,

  -- Where the quote was captured. Exactly one of the two id columns is
  -- set; both are nullable because a note can outlive its source row.
  source_interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL,
  source_planning_note_id uuid REFERENCES public.planning_notes(id) ON DELETE SET NULL,

  -- unmatched  — captured, nothing on the timeline covers it (the queue)
  -- matched    — the judge found a timeline event that covers it
  -- added      — a coordinator added an event for it from the queue
  -- dismissed  — a coordinator decided it needs no event. Recorded, not
  --              deleted: the next sweep must not resurrect it, and the
  --              record of the decision is the point.
  status text NOT NULL DEFAULT 'unmatched'
    CHECK (status IN ('unmatched', 'matched', 'added', 'dismissed')),

  -- Title of the timeline event the judge matched this to, when matched.
  matched_event_title text,
  -- One sentence from the judge. Shown to the coordinator so a match is
  -- arguable rather than mysterious.
  judge_reason text,

  -- Content hash of (quote + the timeline titles it was judged against).
  -- A sweep that finds the same hash skips the model call entirely.
  judge_cache_key text,

  resolved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,

  -- Deliberately not called created_at / updated_at. These are read on a
  -- coordinator surface, and check-no-coordinator-facing-created-at.mjs
  -- exists because every batch pass bumps a generic updated_at to now()
  -- and makes the page lie about when something happened.
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now()
);

-- Full (not partial) unique index so .upsert({ onConflict:
-- 'wedding_id,commitment_key' }) in reconcile.ts has a real constraint to
-- land on. A partial index would return 42P10 on every upsert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commitment_reconciliation_wedding_key
  ON public.commitment_reconciliation (wedding_id, commitment_key);

CREATE INDEX IF NOT EXISTS idx_commitment_reconciliation_queue
  ON public.commitment_reconciliation (venue_id, wedding_id, status, first_seen_at DESC);

COMMENT ON TABLE public.commitment_reconciliation IS
  'Things a couple told the venue that have no matching event on their day-of timeline. Written nightly by services/commitments/reconcile.ts off the data_integrity_sweep cron tick; read by the queue on the coordinator wedding page. One row per captured commitment per wedding.';

COMMENT ON COLUMN public.commitment_reconciliation.commitment_key IS
  'FNV-1a 32-bit hash of the normalised quote. Makes the nightly sweep idempotent: same sentence, same row.';

COMMENT ON COLUMN public.commitment_reconciliation.status IS
  'unmatched = on the queue; matched = a timeline event covers it; added = a coordinator created an event from the queue; dismissed = a coordinator decided no event is needed (recorded, never deleted).';

-- ---------------------------------------------------------------------------
-- Venue isolation (gap G17). Canonical policy set, same shape as 377 /
-- 383 / 389. Every read and write from the sweep goes through the service
-- key; the authenticated policies are what stop the coordinator page (a
-- browser client) from ever seeing another venue's row.
-- ---------------------------------------------------------------------------

ALTER TABLE public.commitment_reconciliation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "commitment_reconciliation_select" ON public.commitment_reconciliation;
CREATE POLICY "commitment_reconciliation_select" ON public.commitment_reconciliation
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

DROP POLICY IF EXISTS "commitment_reconciliation_modify" ON public.commitment_reconciliation;
CREATE POLICY "commitment_reconciliation_modify" ON public.commitment_reconciliation
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

DROP POLICY IF EXISTS "commitment_reconciliation_service" ON public.commitment_reconciliation;
CREATE POLICY "commitment_reconciliation_service" ON public.commitment_reconciliation
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_commitment_reconciliation" ON public.commitment_reconciliation;
CREATE POLICY "demo_anon_select_commitment_reconciliation" ON public.commitment_reconciliation
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));
