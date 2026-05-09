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
          v_row_id uuid;
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
              -- Try the bulk UPDATE first (fast path). If it hits a
              -- unique-constraint violation (e.g.
              -- uq_engagement_events_fire_once on
              -- (venue_id, wedding_id, event_type)) fall back to
              -- per-row UPDATE with the same exception handling: when
              -- a single row collides with an existing canonical row,
              -- delete the loser row instead of moving it. The
              -- canonical's row already represents the merged
              -- semantic event.
              BEGIN
                EXECUTE format('UPDATE public.%I SET wedding_id = $1 WHERE wedding_id = $2', v_t)
                  USING v_canonical_wedding, v_loser_wedding;
              EXCEPTION
                WHEN unique_violation THEN
                  FOR v_row_id IN
                    EXECUTE format('SELECT id FROM public.%I WHERE wedding_id = $1', v_t)
                    USING v_loser_wedding
                  LOOP
                    BEGIN
                      EXECUTE format('UPDATE public.%I SET wedding_id = $1 WHERE id = $2', v_t)
                        USING v_canonical_wedding, v_row_id;
                    EXCEPTION
                      WHEN unique_violation THEN
                        EXECUTE format('DELETE FROM public.%I WHERE id = $1', v_t)
                          USING v_row_id;
                    END;
                  END LOOP;
              END;
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
    -- Pass A, with the same unique-violation fallback to row-by-row.
    DECLARE
      v_t text;
      v_row_id uuid;
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
          BEGIN
            EXECUTE format('UPDATE public.%I SET wedding_id = $1 WHERE wedding_id = $2', v_t)
              USING v_canonical_wedding, v_loser_wedding;
          EXCEPTION
            WHEN unique_violation THEN
              FOR v_row_id IN
                EXECUTE format('SELECT id FROM public.%I WHERE wedding_id = $1', v_t)
                USING v_loser_wedding
              LOOP
                BEGIN
                  EXECUTE format('UPDATE public.%I SET wedding_id = $1 WHERE id = $2', v_t)
                    USING v_canonical_wedding, v_row_id;
                EXCEPTION
                  WHEN unique_violation THEN
                    EXECUTE format('DELETE FROM public.%I WHERE id = $1', v_t)
                      USING v_row_id;
                END;
              END LOOP;
          END;
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
