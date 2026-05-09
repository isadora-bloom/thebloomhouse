-- ---------------------------------------------------------------------------
-- Combined apply: migrations 246 + 247 + identity backfill (v2)
-- ---------------------------------------------------------------------------
-- Paste into https://supabase.com/dashboard/project/jsxxgwprxuqgcauzlxcb/sql/new
-- Idempotent. Safe to re-run.
-- 2026-05-08 v2: backfill now introspects information_schema before each
-- UPDATE so missing wedding_id columns (notifications / knowledge_gaps /
-- tangential_signals / source_attribution / error_logs / draft_feedback /
-- user_profiles) are silently skipped instead of aborting the transaction.

-- ============================================
-- MIGRATION 246: wedding lifecycle state machine
-- ============================================
-- ============================================================================
-- Migration 246: Wedding Lifecycle Events + per-message lifecycle signal.
-- ============================================================================
--
-- Companion to lib/services/lifecycle/wedding-lifecycle-engine.ts +
-- signal-detector.ts. Two changes:
--
--   1) wedding_lifecycle_events: append-only audit table for every
--      lifecycle transition (or attempted transition that the engine
--      rejected as illegal -- those land with status_to=null and
--      signal includes a 'violation:' prefix). Coordinators read this on
--      the wedding detail page; intel reads it for journey narratives;
--      backfill / cron readiness gates read it for invariant checks.
--
--   2) interactions.lifecycle_signal: per-message detection result. The
--      detector writes this on every inbound. The auto-draft gate
--      reads the most recent inbound on a thread and refuses to draft
--      when the signal is a loss kind (lead_declined / going_with_other
--      / silent_close), even if the wedding row has not yet
--      transitioned to 'lost' (the engine + writer are eventually
--      consistent on the row, but the per-message signal is the
--      authoritative source for the gate).
--
-- Idempotent: CREATE TABLE / INDEX / POLICY all use IF NOT EXISTS or
-- DROP-then-CREATE so re-running the migration on a venue that already
-- saw a prior partial apply is safe. Permissive auth policies match the
-- rest of the system (post-058 sweep).
-- ============================================================================

CREATE TABLE IF NOT EXISTS wedding_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  signal text NOT NULL,
  status_from text,
  status_to text,
  reason text,
  detected_by text NOT NULL CHECK (detected_by IN ('ai', 'pipeline', 'coordinator', 'webhook', 'cron', 'backfill')),
  source_interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL,
  confidence numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wlce_wedding_id
  ON wedding_lifecycle_events (wedding_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wlce_venue_id
  ON wedding_lifecycle_events (venue_id, created_at DESC);

ALTER TABLE wedding_lifecycle_events ENABLE ROW LEVEL SECURITY;

-- Permissive policies (auth scope check is owned upstream by venue
-- membership context; the table only contains lifecycle metadata, no
-- raw PII). Matches the /225 / 226 RLS doctrine.
DROP POLICY IF EXISTS "auth_select_wlce" ON wedding_lifecycle_events;
CREATE POLICY "auth_select_wlce" ON wedding_lifecycle_events
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_wlce" ON wedding_lifecycle_events;
CREATE POLICY "auth_insert_wlce" ON wedding_lifecycle_events
  FOR INSERT TO authenticated WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- interactions.lifecycle_signal: per-message detector output.
-- ----------------------------------------------------------------------------
--
-- Stamped on inbound rows by the email pipeline after the AI signal
-- detector runs. NULL means either the detector returned null (most
-- common case -- regular inquiries / questions) or the row predates this
-- column. Auto-draft gate reads the most recent inbound on a thread and
-- treats lead_declined / going_with_other / silent_close as
-- draft-suppressing.
--
-- No CHECK constraint on the value: the engine's LifecycleSignal type
-- evolves and we'd rather a future signal kind land here as data than
-- fail the inbound INSERT. Coordinators / migrations 247+ enforce
-- coherence.

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS lifecycle_signal text;

-- weddings.cancelled_at: stamped when a booked wedding is cancelled.
-- Mirrors lost_at / booked_at (already in 001_shared_tables.sql). Used by
-- the lifecycle writer + intel narratives to anchor "wedding cancelled
-- on date X" without needing to scan engagement_events.
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

-- Partial index: only index rows that actually carry a signal. Queries
-- like "find me weddings whose latest inbound was a decline" are heavily
-- selective.
CREATE INDEX IF NOT EXISTS idx_interactions_lifecycle_signal
  ON interactions (wedding_id, timestamp DESC)
  WHERE lifecycle_signal IS NOT NULL;

-- ============================================================================
-- One-shot heuristic backfill (in-migration, idempotent).
-- ============================================================================
--
-- This is COARSER than the live AI detector. We scan inbound interactions
-- for explicit decline / going-with-other / platform-close phrases via SQL
-- ILIKE. The live detector takes over for new mail, where it can use
-- Haiku-grade language understanding. The backfill exists so that as of
-- the migration apply, weddings that should ALREADY be lost stop
-- emitting auto-replies on their next inbound.
--
-- Trade-off documented: regex-style backfill catches the common cases
-- (the 80%) but misses paraphrasing. The user accepted this; the live
-- AI detector covers the long tail going forward.
--
-- Safety:
--   - Only flips weddings whose CURRENT status is in the pre-booking
--     set (inquiry / tour_scheduled / tour_completed / proposal_sent).
--     A booked or completed wedding never gets auto-flipped.
--   - Inserts a wedding_lifecycle_events row with detected_by='backfill'
--     so the source is auditable.
--   - Idempotent: the WHERE clause filters out weddings that already
--     have a backfill event for the same signal. Re-running the
--     migration is safe.

DO $backfill$
DECLARE
  affected_count int := 0;
BEGIN
  -- Loss-signal inbound interactions. Each WHEN branch matches one
  -- LifecycleSignal kind. We deliberately keep the patterns narrow --
  -- false positives flip a real lead to lost.
  WITH loss_candidates AS (
    SELECT
      i.id AS interaction_id,
      i.venue_id,
      i.wedding_id,
      i.timestamp,
      i.full_body,
      i.subject,
      i.from_email,
      CASE
        -- silent_close: platform-driven close events. WeddingPro /
        -- WeddingWire have a stock phrase; The Knot uses different
        -- wording.
        WHEN COALESCE(i.full_body, '') ILIKE '%decided to close the conversation%'
          OR COALESCE(i.full_body, '') ILIKE '%couple closed this conversation%'
          OR COALESCE(i.full_body, '') ILIKE '%marked as not interested%'
          OR COALESCE(i.full_body, '') ILIKE '%this lead has been archived%'
          OR COALESCE(i.subject, '') ILIKE '%conversation closed%'
          OR COALESCE(i.subject, '') ILIKE '%lead archived%'
          THEN 'silent_close'
        -- going_with_other: chose another venue.
        WHEN COALESCE(i.full_body, '') ILIKE '%decided on another venue%'
          OR COALESCE(i.full_body, '') ILIKE '%going with another%'
          OR COALESCE(i.full_body, '') ILIKE '%we''re going with %'
          OR COALESCE(i.full_body, '') ILIKE '%chose a different venue%'
          OR COALESCE(i.full_body, '') ILIKE '%signed with another venue%'
          OR COALESCE(i.full_body, '') ILIKE '%booked another venue%'
          THEN 'going_with_other'
        -- lead_declined: explicit decline. Order matters -- match the
        -- specific decline patterns before the noisier "we won't" cases.
        WHEN COALESCE(i.full_body, '') ILIKE '%won''t be moving forward%'
          OR COALESCE(i.full_body, '') ILIKE '%will not be moving forward%'
          OR COALESCE(i.full_body, '') ILIKE '%no longer pursuing%'
          OR COALESCE(i.full_body, '') ILIKE '%removing your venue from consideration%'
          OR COALESCE(i.full_body, '') ILIKE '%decided not to book%'
          OR COALESCE(i.full_body, '') ILIKE '%no longer in the running%'
          OR COALESCE(i.full_body, '') ILIKE '%we''re going to pass%'
          OR COALESCE(i.full_body, '') ILIKE '%we are going to pass%'
          THEN 'lead_declined'
        ELSE NULL
      END AS detected_signal
    FROM interactions i
    WHERE i.direction = 'inbound'
      AND i.wedding_id IS NOT NULL
      AND i.full_body IS NOT NULL
  ),
  matches AS (
    SELECT * FROM loss_candidates WHERE detected_signal IS NOT NULL
  ),
  -- Pick the most recent matching inbound per wedding so the backfill
  -- event ties to the latest signal, not an old one. A wedding might
  -- have several decline-shaped phrases historically (e.g. couple wrote
  -- back later); the latest is the authoritative state.
  latest_per_wedding AS (
    SELECT DISTINCT ON (wedding_id)
      wedding_id, venue_id, interaction_id, detected_signal, timestamp
    FROM matches
    ORDER BY wedding_id, timestamp DESC
  ),
  -- Filter to weddings still in pre-booking states; never flip booked /
  -- completed / cancelled. lost-already weddings are also filtered out
  -- (the event would be a no-op).
  to_flip AS (
    SELECT lpw.*
    FROM latest_per_wedding lpw
    JOIN weddings w ON w.id = lpw.wedding_id
    WHERE w.status IN ('inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent')
      -- Idempotent: skip rows that already have a backfill event for
      -- this signal kind.
      AND NOT EXISTS (
        SELECT 1 FROM wedding_lifecycle_events e
        WHERE e.wedding_id = lpw.wedding_id
          AND e.signal = lpw.detected_signal
          AND e.detected_by = 'backfill'
      )
  )
  -- Step 1: log the lifecycle events.
  INSERT INTO wedding_lifecycle_events
    (venue_id, wedding_id, signal, status_from, status_to, reason, detected_by, source_interaction_id, confidence)
  SELECT
    f.venue_id,
    f.wedding_id,
    f.detected_signal,
    w.status,
    'lost',
    'heuristic backfill on migration 246',
    'backfill',
    f.interaction_id,
    NULL  -- backfill has no model confidence; keep the column nullable
  FROM to_flip f
  JOIN weddings w ON w.id = f.wedding_id;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'backfill: logged % wedding_lifecycle_events rows', affected_count;

  -- Step 2: flip the wedding rows to lost. The WHERE clause repeats the
  -- pre-booking guard so a concurrent transition between step 1 and 2
  -- doesn't get clobbered.
  UPDATE weddings w
  SET status = 'lost',
      lost_at = COALESCE(w.lost_at, now()),
      lost_reason = COALESCE(w.lost_reason, 'backfill: ' || f.detected_signal),
      updated_at = now()
  FROM (
    SELECT DISTINCT wedding_id, detected_signal FROM (
      SELECT
        i.wedding_id,
        CASE
          WHEN COALESCE(i.full_body, '') ILIKE '%decided to close the conversation%'
            OR COALESCE(i.full_body, '') ILIKE '%couple closed this conversation%'
            OR COALESCE(i.full_body, '') ILIKE '%marked as not interested%'
            OR COALESCE(i.full_body, '') ILIKE '%this lead has been archived%'
            OR COALESCE(i.subject, '') ILIKE '%conversation closed%'
            OR COALESCE(i.subject, '') ILIKE '%lead archived%'
            THEN 'silent_close'
          WHEN COALESCE(i.full_body, '') ILIKE '%decided on another venue%'
            OR COALESCE(i.full_body, '') ILIKE '%going with another%'
            OR COALESCE(i.full_body, '') ILIKE '%we''re going with %'
            OR COALESCE(i.full_body, '') ILIKE '%chose a different venue%'
            OR COALESCE(i.full_body, '') ILIKE '%signed with another venue%'
            OR COALESCE(i.full_body, '') ILIKE '%booked another venue%'
            THEN 'going_with_other'
          WHEN COALESCE(i.full_body, '') ILIKE '%won''t be moving forward%'
            OR COALESCE(i.full_body, '') ILIKE '%will not be moving forward%'
            OR COALESCE(i.full_body, '') ILIKE '%no longer pursuing%'
            OR COALESCE(i.full_body, '') ILIKE '%removing your venue from consideration%'
            OR COALESCE(i.full_body, '') ILIKE '%decided not to book%'
            OR COALESCE(i.full_body, '') ILIKE '%no longer in the running%'
            OR COALESCE(i.full_body, '') ILIKE '%we''re going to pass%'
            OR COALESCE(i.full_body, '') ILIKE '%we are going to pass%'
            THEN 'lead_declined'
          ELSE NULL
        END AS detected_signal
      FROM interactions i
      WHERE i.direction = 'inbound'
        AND i.wedding_id IS NOT NULL
        AND i.full_body IS NOT NULL
    ) raw
    WHERE detected_signal IS NOT NULL
  ) f
  WHERE w.id = f.wedding_id
    AND w.status IN ('inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent');

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'backfill: flipped % weddings to lost', affected_count;
END;
$backfill$;

-- ============================================
-- MIGRATION 247: identity merge columns
-- ============================================
-- ---------------------------------------------------------------------------
-- 247_identity_merge_columns.sql
-- ---------------------------------------------------------------------------
-- Identity-resolver soft-merge tombstones for `people`.
--
-- Why this exists
-- ---------------
-- The Reem Ibrahim case (2026-05-08) surfaced the fact that we had three
-- entry paths (Knot relay email, calculator submission, contract-request)
-- each minting an independent `weddings` + `people` row for the same
-- couple. The new src/lib/services/identity/resolver.ts is the single
-- chokepoint that every entry path now goes through; when it discovers
-- that a candidate identity matches an existing person it merges them
-- via mergeWeddings() in the same module.
--
-- `weddings.merged_into_id` already exists (migration 177). This file
-- adds the symmetric column on `people` plus the supporting indexes so
-- the resolver can soft-tombstone duplicate person rows without losing
-- the FK chain.
--
-- Constitution invariant: a row with merged_into_id IS NOT NULL is a
-- tombstone. Active queries filter `merged_into_id IS NULL`. Readers
-- that hit a tombstone follow the pointer (resolveCanonical helper in
-- the resolver). Hard-deletes are never used; the audit trail must
-- stay intact.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — people.merged_into_id soft-merge pointer
-- ============================================================================

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS merged_into_id uuid
    REFERENCES public.people(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.people.merged_into_id IS
  'Identity-resolver loser → winner pointer (Reem-bug fix, migration 247). '
  'NULL = active row. NOT NULL = duplicate person consolidated into the '
  'referenced canonical row. Forensic record preserved per Constitution; '
  'the resolver soft-tombstones rather than hard-deletes so any stragglers '
  'pointing at this id (interactions, contacts, engagement_events, etc.) '
  'still resolve cleanly via resolveCanonical(). Set by '
  'src/lib/services/identity/resolver.ts.';

-- ============================================================================
-- STEP 2 — also re-assert the weddings.merged_into_id index on a partial
-- ============================================================================
-- Migration 177 already created idx_weddings_merged_into. This block stays
-- idempotent so the file can re-run without surprises.

CREATE INDEX IF NOT EXISTS idx_weddings_merged_into
  ON public.weddings (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_people_merged_into
  ON public.people (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

COMMENT ON INDEX public.idx_people_merged_into IS
  'Reverse-pointer lookup: given a canonical person, find every tombstone '
  'that points at it. Used by /admin/identity audit + the resolveCanonical '
  'helper that walks chains of merges. Migration 247.';

-- ============================================================================
-- STEP 3 — partial active-set index on people
-- ============================================================================
-- Mirrors idx_weddings_active. Every coordinator surface that lists people
-- (leads page, inbox sender column, /intel/matching) filters tombstones.

CREATE INDEX IF NOT EXISTS idx_people_active_venue
  ON public.people (venue_id, merged_into_id)
  WHERE merged_into_id IS NULL;

COMMENT ON INDEX public.idx_people_active_venue IS
  'Active-set partial index for people. Coordinator surfaces filter on '
  '(venue_id, merged_into_id IS NULL). Migration 247.';

-- ============================================================================
-- STEP 4 — extend weddings.source_provenance enum for resolver-created rows
-- ============================================================================
-- The new resolver creates wedding rows from non-pipeline entry points
-- (calculator submission, calendly form, brain-dump client_note). Migration
-- 178 capped source_provenance at a fixed enum; we add 'identity_resolver'
-- so downstream filters can distinguish the resolver path from a
-- pipeline-or-import write.

ALTER TABLE public.weddings
  DROP CONSTRAINT IF EXISTS weddings_source_provenance_check;

ALTER TABLE public.weddings
  ADD CONSTRAINT weddings_source_provenance_check
    CHECK (source_provenance IS NULL OR source_provenance IN (
      'pipeline',
      'crm_import',
      'web_form_import',
      'brain_dump',
      'manual_form',
      'manual_csv',
      'identity_resolution_merge',
      'identity_resolver'
    ));

NOTIFY pgrst, 'reload schema';

-- ============================================
-- BACKFILL: dedupe people + weddings by email
-- ============================================
-- ---------------------------------------------------------------------------
-- identity-backfill-merge.sql
-- ---------------------------------------------------------------------------
-- One-shot dedupe of historical people + weddings duplicates that pre-date
-- the canonical resolver (src/lib/services/identity/resolver.ts).
--
-- Why
-- ---
-- Real example surfaced 2026-05-08: Reem Ibrahim arrived via three entry
-- paths (Knot inquiry, calculator estimate, contract-request). Each path
-- minted its own `people` + `weddings` row. The fix lands the resolver
-- at the entry-path level so future signals never split. This file
-- catches everything that already split before the resolver shipped.
--
-- Scope
-- -----
-- Two passes:
--
--   Pass A (people)
--     Group active `people` rows (merged_into_id IS NULL) by lower-cased
--     trimmed email per venue. For each group with 2+ rows: pick the
--     OLDEST as canonical, soft-tombstone the rest by setting
--     merged_into_id, re-point every FK-referencing row to the canonical.
--
--   Pass B (weddings)
--     Group active `weddings` rows (merged_into_id IS NULL) by:
--       - the canonical person row attached via people.wedding_id
--     For each group with 2+ rows: pick the wedding with the highest
--     completeness score as canonical, soft-tombstone the rest by setting
--     merged_into_id (the migration-202 trigger reattaches
--     attribution_events / wedding_touchpoints / candidate_identities
--     automatically). Re-point every direct FK-referencing wedding_id
--     column to the canonical.
--
-- Idempotency
-- -----------
-- Both passes filter on `merged_into_id IS NULL` so re-running this file
-- is safe — once a row is tombstoned it drops out of the next run's
-- candidate set.
--
-- Hard rule
-- ---------
-- No row is ever hard-deleted. Tombstones preserve the forensic record
-- per bloom-constitution.md. The resolver chases pointers via the
-- resolveCanonicalPerson / resolveCanonicalWedding helpers.
--
-- Coordinator audit
-- -----------------
-- After this script runs, /admin/identity surfaces every merged_into_id
-- pointer with the source label, so the coordinator can spot-check what
-- was collapsed.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- Pass A — people dedupe by lower-cased email per venue
-- ============================================================================

DO $identity_backfill$
DECLARE
  -- For every venue × normalized-email pair with 2+ active rows, keep
  -- the OLDEST people row as canonical and merge the rest into it.
  r record;
  v_canonical_person uuid;
  v_canonical_wedding uuid;
  v_loser uuid;
  v_loser_wedding uuid;
  v_dupes_processed integer := 0;
BEGIN
  FOR r IN
    SELECT
      venue_id,
      lower(trim(email)) AS norm_email,
      array_agg(id ORDER BY created_at ASC) AS person_ids,
      array_agg(wedding_id ORDER BY created_at ASC) AS wedding_ids
    FROM public.people
    WHERE email IS NOT NULL
      AND trim(email) <> ''
      AND merged_into_id IS NULL
    GROUP BY venue_id, lower(trim(email))
    HAVING count(*) >= 2
  LOOP
    v_canonical_person := r.person_ids[1];
    v_canonical_wedding := r.wedding_ids[1];
    -- For each duplicate beyond the canonical, perform the merge.
    FOR i IN 2..array_length(r.person_ids, 1) LOOP
      v_loser := r.person_ids[i];
      v_loser_wedding := r.wedding_ids[i];

      -- Step A1: re-point person-keyed children to the canonical person.
      UPDATE public.interactions
        SET person_id = v_canonical_person
        WHERE person_id = v_loser;
      UPDATE public.contacts
        SET person_id = v_canonical_person
        WHERE person_id = v_loser;
      UPDATE public.tangential_signals
        SET matched_person_id = v_canonical_person
        WHERE matched_person_id = v_loser;

      -- Step A2: if the loser had a different wedding than the canonical,
      -- merge that wedding too. We do the wedding-side fan-out here
      -- because Pass B's grouping is by canonical-person and the resolver
      -- has not yet stamped the canonical-person on the loser's wedding.
      IF v_loser_wedding IS NOT NULL
         AND v_canonical_wedding IS NOT NULL
         AND v_loser_wedding <> v_canonical_wedding
      THEN
        -- Reassign every wedding_id-keyed row from the loser wedding to
        -- the canonical wedding. The candidate-table list below is what
        -- the resolver's mergeWeddings() walks; we introspect
        -- information_schema before each UPDATE so a table that does NOT
        -- carry wedding_id (notifications / knowledge_gaps /
        -- tangential_signals / source_attribution / error_logs /
        -- draft_feedback / user_profiles) is silently skipped instead
        -- of throwing 42703 and aborting the whole transaction.
        DECLARE
          v_t text;
          v_candidate_tables text[] := ARRAY[
            'interactions','drafts','engagement_events','tours','lost_deals',
            'admin_notifications','notifications','knowledge_gaps',
            'intelligence_extractions','tangential_signals','source_attribution',
            'error_logs','event_feedback','contracts','booked_vendors',
            'day_of_media','wedding_internal_notes','vendor_checklist',
            'messages','sage_conversations','planning_notes','checklist_items',
            'budget','guest_list','timeline','seating_tables',
            'seating_assignments','vendor_recommendations','inspo_gallery',
            'booked_dates','lead_score_history','draft_feedback',
            'wedding_lifecycle_events'
          ];
        BEGIN
          FOREACH v_t IN ARRAY v_candidate_tables LOOP
            IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = v_t
                AND column_name = 'wedding_id'
            ) THEN
              EXECUTE format('UPDATE public.%I SET wedding_id = $1 WHERE wedding_id = $2', v_t)
                USING v_canonical_wedding, v_loser_wedding;
            END IF;
          END LOOP;
        END;
        -- Tombstone the loser wedding. The migration-202 trigger
        -- reattaches attribution_events / wedding_touchpoints /
        -- candidate_identities to the canonical automatically.
        UPDATE public.weddings
          SET merged_into_id = v_canonical_wedding
          WHERE id = v_loser_wedding
            AND merged_into_id IS NULL;
      END IF;

      -- Step A3: tombstone the loser person.
      UPDATE public.people
        SET merged_into_id = v_canonical_person,
            wedding_id = v_canonical_wedding
        WHERE id = v_loser
          AND merged_into_id IS NULL;

      v_dupes_processed := v_dupes_processed + 1;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'identity-backfill Pass A: merged % duplicate person rows', v_dupes_processed;
END;
$identity_backfill$;

-- ============================================================================
-- Pass B — weddings dedupe by canonical-person attachment
-- ============================================================================
-- After Pass A every active person points at the right wedding via
-- people.wedding_id. But some venues had a DIFFERENT shape of duplication:
-- two weddings linked through interactions / engagement_events but neither
-- via people.wedding_id (e.g. brain-dump CSV import created a wedding
-- with no people row, then the calendar webhook later spawned a second
-- with the same person). Pass B catches those.
--
-- Strategy: group active weddings by the set of distinct active person
-- ids attached via interactions.person_id. When two weddings share an
-- exact person set (size >= 1), pick the more-complete wedding as
-- canonical and tombstone the other.

DO $wedding_backfill$
DECLARE
  r record;
  v_canonical_wedding uuid;
  v_loser_wedding uuid;
  v_dupes_processed integer := 0;
BEGIN
  FOR r IN
    -- Self-join active weddings on shared person via interactions.
    -- The DISTINCT + ORDER BY ensures stable canonical pick: a row with
    -- non-null wedding_date wins over a row with null wedding_date; on
    -- ties the older row wins.
    SELECT DISTINCT ON (venue_id, person_id, paired_id)
      w1.venue_id,
      i1.person_id,
      LEAST(w1.id, w2.id) AS paired_id,
      CASE
        WHEN w1.wedding_date IS NOT NULL AND w2.wedding_date IS NULL THEN w1.id
        WHEN w2.wedding_date IS NOT NULL AND w1.wedding_date IS NULL THEN w2.id
        WHEN w1.created_at <= w2.created_at THEN w1.id
        ELSE w2.id
      END AS canonical_id,
      CASE
        WHEN w1.wedding_date IS NOT NULL AND w2.wedding_date IS NULL THEN w2.id
        WHEN w2.wedding_date IS NOT NULL AND w1.wedding_date IS NULL THEN w1.id
        WHEN w1.created_at <= w2.created_at THEN w2.id
        ELSE w1.id
      END AS loser_id
    FROM public.interactions i1
    JOIN public.interactions i2
      ON i2.person_id = i1.person_id
      AND i2.wedding_id <> i1.wedding_id
    JOIN public.weddings w1
      ON w1.id = i1.wedding_id
      AND w1.merged_into_id IS NULL
    JOIN public.weddings w2
      ON w2.id = i2.wedding_id
      AND w2.merged_into_id IS NULL
      AND w2.venue_id = w1.venue_id
    WHERE i1.person_id IS NOT NULL
      AND i1.wedding_id IS NOT NULL
      AND i2.wedding_id IS NOT NULL
  LOOP
    v_canonical_wedding := r.canonical_id;
    v_loser_wedding := r.loser_id;
    IF v_canonical_wedding = v_loser_wedding THEN CONTINUE; END IF;

    -- Reassign FK-referencing rows. Same introspection-guarded loop as
    -- Pass A so missing wedding_id columns are silently skipped.
    DECLARE
      v_t text;
      v_candidate_tables text[] := ARRAY[
        'interactions','drafts','engagement_events','tours','lost_deals',
        'admin_notifications','notifications','knowledge_gaps',
        'intelligence_extractions','tangential_signals','source_attribution',
        'error_logs','event_feedback','contracts','booked_vendors',
        'day_of_media','wedding_internal_notes','vendor_checklist',
        'messages','sage_conversations','planning_notes','checklist_items',
        'budget','guest_list','timeline','seating_tables',
        'seating_assignments','vendor_recommendations','inspo_gallery',
        'booked_dates','lead_score_history','draft_feedback',
        'wedding_lifecycle_events','people'
      ];
    BEGIN
      FOREACH v_t IN ARRAY v_candidate_tables LOOP
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = v_t
            AND column_name = 'wedding_id'
        ) THEN
          EXECUTE format('UPDATE public.%I SET wedding_id = $1 WHERE wedding_id = $2', v_t)
            USING v_canonical_wedding, v_loser_wedding;
        END IF;
      END LOOP;
    END;

    -- Tombstone the loser; trigger handles attribution / touchpoints / candidates.
    UPDATE public.weddings
      SET merged_into_id = v_canonical_wedding
      WHERE id = v_loser_wedding
        AND merged_into_id IS NULL;

    v_dupes_processed := v_dupes_processed + 1;
  END LOOP;
  RAISE NOTICE 'identity-backfill Pass B: merged % duplicate wedding rows', v_dupes_processed;
END;
$wedding_backfill$;

-- ============================================================================
-- Verification queries (read-only — uncomment to run)
-- ============================================================================
-- SELECT count(*) AS active_people_with_dupe_email FROM (
--   SELECT venue_id, lower(trim(email))
--   FROM public.people
--   WHERE email IS NOT NULL AND merged_into_id IS NULL
--   GROUP BY 1, 2
--   HAVING count(*) >= 2
-- ) x;
--
-- SELECT count(*) AS tombstoned_people FROM public.people WHERE merged_into_id IS NOT NULL;
-- SELECT count(*) AS tombstoned_weddings FROM public.weddings WHERE merged_into_id IS NOT NULL;
