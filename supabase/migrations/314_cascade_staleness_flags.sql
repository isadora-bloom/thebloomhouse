-- ---------------------------------------------------------------------------
-- 307_cascade_staleness_flags.sql
-- ---------------------------------------------------------------------------
-- Pattern 2 from BLOOM-PATTERNS-ZOOM-OUT.md: cascade triggers on state
-- change. This migration adds the schema needed for two of the six
-- cascades (pricing, personality) and the Postgres trigger that catches
-- the lost-mark cascade regardless of which writer flips status.
--
-- Why these columns
-- -----------------
-- Pending drafts carry assumptions about the venue at the moment they
-- were generated. When the assumption changes — pricing updated, AI
-- personality dialed — those drafts can become stale. The pending-queue
-- UI needs a way to surface "this draft was generated against old
-- pricing; regenerate before sending." Both flags are nullable
-- timestamps so the coordinator UI can show "stale since X" and the
-- regenerator can sort by staleness recency.
--
-- cancelled_reason carries the why for a draft that flipped to
-- status='rejected' via the lost-mark cascade. Keeps the audit trail
-- without re-using feedback_notes (which carries coordinator-written
-- feedback for the learning loop).
--
-- Trigger
-- -------
-- on_wedding_status_lost fires when weddings.status transitions to
-- 'lost'. Cancels every pending draft for that wedding and stamps
-- cancelled_reason='wedding_lost'. Postgres-side catches all paths
-- (pipeline auto-status, signal-inference, lifecycle override, manual
-- coordinator edit) — JS-side instrumentation would have to chase
-- every writer.
--
-- Idempotent: each ADD COLUMN uses IF NOT EXISTS. Trigger uses
-- DROP-then-CREATE. No transaction wrapper.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — drafts staleness flags + cancelled_reason
-- ============================================================================

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS pricing_stale_at timestamptz;

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS personality_stale_at timestamptz;

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS cancelled_reason text;

COMMENT ON COLUMN public.drafts.pricing_stale_at IS
  'When set, the draft was generated before the most recent pricing change. '
  'Coordinator UI surfaces a "regenerate to refresh pricing" prompt. '
  'Cleared on regenerate. Cascade Pattern 2 (migration 314).';

COMMENT ON COLUMN public.drafts.personality_stale_at IS
  'When set, the draft was generated against a personality config older '
  'than the current venue_ai_config. Coordinator UI surfaces a '
  '"regenerate to refresh voice" prompt. Cleared on regenerate. Cascade '
  'Pattern 2 (migration 314).';

COMMENT ON COLUMN public.drafts.cancelled_reason IS
  'Why a draft transitioned to status=rejected via a cascade (rather '
  'than coordinator reject with feedback). Example values: '
  '''wedding_lost'' | ''pricing_invalidated'' | ''personality_changed''. '
  'Distinct from feedback_notes (coordinator-written learning input). '
  'Cascade Pattern 2 (migration 314).';

-- Partial index so "find every stale draft for venue X" stays fast.
CREATE INDEX IF NOT EXISTS idx_drafts_stale
  ON public.drafts (venue_id, created_at DESC)
  WHERE pricing_stale_at IS NOT NULL OR personality_stale_at IS NOT NULL;

-- ============================================================================
-- STEP 2 — Trigger: weddings.status='lost' cancels pending drafts
-- ============================================================================
-- Catches all paths that flip status to lost: signal-inference,
-- lifecycle override, pipeline auto-status, coordinator direct edit.
-- Only fires on the OLD → 'lost' transition (not lost → lost re-saves).
-- Idempotent: drafts already not in 'pending' are left alone.

CREATE OR REPLACE FUNCTION public.cascade_wedding_lost()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'lost'
     AND (OLD.status IS DISTINCT FROM 'lost')
  THEN
    UPDATE public.drafts
       SET status = 'rejected',
           cancelled_reason = 'wedding_lost'
     WHERE wedding_id = NEW.id
       AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_weddings_cascade_lost ON public.weddings;
CREATE TRIGGER trg_weddings_cascade_lost
  AFTER UPDATE OF status ON public.weddings
  FOR EACH ROW
  EXECUTE FUNCTION public.cascade_wedding_lost();

NOTIFY pgrst, 'reload schema';
