-- Migration 167: split cultural_moments confirmation per-venue
--
-- Pre-this-migration: cultural_moments was a global table (no venue_id),
-- and `status` ('proposed' | 'confirmed' | 'dismissed' | 'archived')
-- was ALSO global. Effect: if Hawthorne Manor's coordinator confirmed
-- 'coastal grandmother', the correlation engine would lift it as
-- External Context for EVERY venue platform-wide. If Crestwood Farm
-- thought it was noise, dismissing it would yank it from Hawthorne too.
--
-- That's wrong for the multi-venue model. Cultural trends genuinely ARE
-- global ("coastal grandmother" is a real US-wide aesthetic shift, with
-- geo_scope for regional cuts), but each venue gets to decide whether
-- the moment matters for their correlation engine.
--
-- Split:
--   - cultural_moments stays global. Any venue (or admin) can propose;
--     status flips to 'confirmed' when ANY venue elevates it (admin-
--     summary-level rollup). The status column keeps its existing
--     semantics for back-compat / global rollup; downstream readers
--     migrate to the new per-venue table.
--   - venue_cultural_moment_state records each venue's INDEPENDENT
--     decision: confirmed (use it), dismissed (ignore it), snoozed
--     (revisit later).
--
-- Correlation engine, External Context loader, intel-brain context,
-- and the /intel/cultural-moments queue all migrate to read from the
-- new per-venue join — see Stream R notes.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, DROP/CREATE policies, INSERT
-- ON CONFLICT DO NOTHING for the demo backfill.

CREATE TABLE IF NOT EXISTS public.venue_cultural_moment_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  cultural_moment_id uuid NOT NULL REFERENCES public.cultural_moments(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('confirmed', 'dismissed', 'snoozed')),
  decided_by uuid NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  -- Optional rationale ("noise for our market", "core to our brand").
  -- Capped to 280 chars in the app layer; column is unbounded for
  -- migration safety.
  note text NULL,
  UNIQUE (venue_id, cultural_moment_id)
);

-- Read-time index: "what's confirmed for venue X?" is the hottest path
-- (correlation-engine + intel-brain query it on every cron tick).
CREATE INDEX IF NOT EXISTS idx_vcms_venue_state
  ON public.venue_cultural_moment_state (venue_id, state);

COMMENT ON TABLE public.venue_cultural_moment_state IS
  'owner:intel. Per-venue confirmation/dismissal of global cultural_moments. '
  'cultural_moments propose globally — any venue (or admin) can propose, and '
  'cultural_moments.status=''confirmed'' means at least one venue elevated it. '
  'venue_cultural_moment_state is the SOURCE OF TRUTH for whether a venue''s '
  'correlation engine + intel context should USE the moment. Reads: '
  'cultural_moments WHERE id IN (SELECT cultural_moment_id FROM '
  'venue_cultural_moment_state WHERE venue_id = $venue AND state = ''confirmed'').';

COMMENT ON COLUMN public.venue_cultural_moment_state.state IS
  'confirmed = venue uses this moment; dismissed = venue explicitly opted out; '
  'snoozed = revisit later (UI only, treated like ''not decided'' for engine reads).';

-- Touch trigger so updated_at-style staleness checks work without an
-- explicit column. We don't add updated_at — decided_at is the canonical
-- "when did this venue make this decision" field, and a re-decision is
-- a fresh upsert that stomps decided_at.

ALTER TABLE public.venue_cultural_moment_state ENABLE ROW LEVEL SECURITY;

-- Service role: full access. Cron tasks and backfill scripts use this.
DROP POLICY IF EXISTS "vcms_service" ON public.venue_cultural_moment_state;
CREATE POLICY "vcms_service" ON public.venue_cultural_moment_state
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated SELECT: only rows for venues the caller can see.
DROP POLICY IF EXISTS "vcms_select" ON public.venue_cultural_moment_state;
CREATE POLICY "vcms_select" ON public.venue_cultural_moment_state
  FOR SELECT TO authenticated
  USING (
    venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  );

-- Authenticated INSERT: must scope to the caller's visible venues.
DROP POLICY IF EXISTS "vcms_insert" ON public.venue_cultural_moment_state;
CREATE POLICY "vcms_insert" ON public.venue_cultural_moment_state
  FOR INSERT TO authenticated
  WITH CHECK (
    venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  );

-- Authenticated UPDATE: same scope. UPDATE is used when a venue flips
-- a previous decision (dismissed -> confirmed, etc.) via UPSERT.
DROP POLICY IF EXISTS "vcms_update" ON public.venue_cultural_moment_state;
CREATE POLICY "vcms_update" ON public.venue_cultural_moment_state
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  );

-- Authenticated DELETE: same scope. Coordinators who want to "un-decide"
-- (revert to "no opinion") can delete the row.
DROP POLICY IF EXISTS "vcms_delete" ON public.venue_cultural_moment_state;
CREATE POLICY "vcms_delete" ON public.venue_cultural_moment_state
  FOR DELETE TO authenticated
  USING (
    venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  );

-- =====================================================================
-- Demo seed backfill — preserve current behavior where every demo venue
-- sees the 6 confirmed cultural_moments rows (seeded in seed.sql).
--
-- INSERT ON CONFLICT DO NOTHING keeps this idempotent across re-runs and
-- across staging vs prod deploys: only fires for venues marked is_demo
-- and only for the 6 demo cultural_moments rows (id prefix 'cb010001').
-- Production venues + production-proposed moments are NOT touched.
-- =====================================================================
INSERT INTO public.venue_cultural_moment_state (
  venue_id, cultural_moment_id, state, decided_at, note
)
SELECT
  v.id AS venue_id,
  cm.id AS cultural_moment_id,
  'confirmed' AS state,
  COALESCE(cm.reviewed_at, cm.created_at) AS decided_at,
  'demo seed backfill' AS note
FROM public.venues v
CROSS JOIN public.cultural_moments cm
WHERE v.is_demo = true
  AND cm.status = 'confirmed'
  AND cm.id::text LIKE 'cb010001-%'
ON CONFLICT (venue_id, cultural_moment_id) DO NOTHING;
