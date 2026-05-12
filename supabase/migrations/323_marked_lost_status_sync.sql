-- ---------------------------------------------------------------------------
-- 323_marked_lost_status_sync.sql
-- ---------------------------------------------------------------------------
-- Inbound symmetry to migration 314's trg_weddings_cascade_lost.
--
-- Migration 314 enforces: weddings.status -> 'lost' cancels pending drafts.
-- That is the outbound half. It does NOT close the inverse direction: an
-- engagement_events row of event_type='marked_lost' has no structural
-- guarantee that weddings.status flipped to 'lost' in the same write.
--
-- The canonical writer (markAsLost at src/lib/services/heat-mapping.ts:1401)
-- does both halves inside Promise.all, but Promise.all is best-effort:
-- a single failing branch leaves the others committed, the status
-- update can silently lose. Crystal Fuller (RM-0480) is the first
-- observed case: a 'marked_lost' engagement event exists, status is
-- still 'tour_scheduled'. Same shape would also occur if any non-
-- canonical writer ever inserted a marked_lost event without going
-- through markAsLost.
--
-- Fix: AFTER INSERT trigger on engagement_events. Any path that inserts
-- a marked_lost event now flips weddings.status to 'lost' and fills
-- lost_at / lost_reason if those are NULL. The trigger then cascades
-- through trg_weddings_cascade_lost (mig 314), which cancels pending
-- drafts. Bidirectional consistency restored.
--
-- Status guard: only fires when status is NOT already in ('lost',
-- 'cancelled'). Avoids reopen-then-relose flapping and avoids
-- overwriting a manually-set 'cancelled' status.
--
-- Retro-repair (Step 2): runs AFTER trigger creation so legacy
-- mismatched rows flow through the new trigger AND through mig 314's
-- draft-cancellation cascade in one pass.
--
-- Idempotent. No transaction wrapper (Wave 23 rule).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 - Trigger function + AFTER INSERT trigger on engagement_events
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_status_on_marked_lost()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_type = 'marked_lost' AND NEW.wedding_id IS NOT NULL THEN
    UPDATE public.weddings
       SET status = 'lost',
           lost_at = COALESCE(lost_at, NEW.occurred_at, now()),
           lost_reason = COALESCE(lost_reason, NULLIF(NEW.metadata->>'reason', '')),
           updated_at = now()
     WHERE id = NEW.wedding_id
       AND status NOT IN ('lost', 'cancelled');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_engagement_events_marked_lost_sync ON public.engagement_events;
CREATE TRIGGER trg_engagement_events_marked_lost_sync
  AFTER INSERT ON public.engagement_events
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_status_on_marked_lost();

COMMENT ON FUNCTION public.sync_status_on_marked_lost() IS
  'Inbound half of the lost-mark invariant. Any insert of '
  '''marked_lost'' into engagement_events flips weddings.status to ''lost'' '
  'and fills lost_at / lost_reason if NULL. Paired with mig 314 '
  'trg_weddings_cascade_lost (outbound: status=lost cancels pending drafts). '
  'Together they enforce engagement_events.event_type=''marked_lost'' '
  '<=> weddings.status=''lost''. Migration 323.';

-- ============================================================================
-- STEP 2 - Retro-repair: fix legacy weddings where the invariant is broken
-- ============================================================================
-- Runs AFTER the trigger above so each repaired row flows through
-- trg_weddings_cascade_lost (mig 314) and cancels any still-pending
-- drafts that belong to a wedding that was effectively lost weeks ago.
-- Idempotent: only touches rows that actually violate the invariant.

UPDATE public.weddings w
SET status = 'lost',
    lost_at = COALESCE(w.lost_at,
      (SELECT MIN(occurred_at) FROM public.engagement_events
       WHERE wedding_id = w.id AND event_type = 'marked_lost')),
    updated_at = now()
WHERE w.status NOT IN ('lost', 'cancelled')
  AND EXISTS (
    SELECT 1 FROM public.engagement_events
    WHERE wedding_id = w.id AND event_type = 'marked_lost'
  );

NOTIFY pgrst, 'reload schema';
