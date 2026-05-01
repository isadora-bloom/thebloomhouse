-- Migration 125: per-venue forbidden topics (T1-J / B-21)
--
-- Per Playbook LIMB-16.4: forbidden topics, like marketing channels,
-- are venue-scoped business rules. The pre-migration shape was a
-- hardcoded global array in `src/config/escalation-keywords.ts`
-- (ESCALATION_KEYWORDS). checkEscalation(text) took no venue_id and
-- returned the same answer for every venue. That misses:
--   - venue-specific topics (their pricing structure, vendor disputes,
--     a specific family situation flagged by the coordinator)
--   - emerging concerns that need to escalate this week but not next
--   - regional/seasonal topics (force majeure mentions, weather
--     cancellations, insurance carriers a particular venue uses)
-- Coordinators have no surface to inject these without a code deploy.
--
-- Phase 1 (this migration): introduce the table. Service refactor
-- ships in the same commit; checkEscalation becomes
-- (text, venueId) and merges global defaults with per-venue rows.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS.
-- RLS mirrors candidate_identities (venue staff scoped via
-- user_profiles.venue_id).

CREATE TABLE IF NOT EXISTS public.venue_forbidden_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Free-text trigger phrase. Match is case-insensitive substring
  -- against the inbound message body, mirroring the global
  -- ESCALATION_KEYWORDS pattern in escalation-keywords.ts.
  keyword text NOT NULL,

  -- Optional grouping for the admin UI / audit. 'pricing', 'legal',
  -- 'family', 'vendor', 'medical', etc. Nullable on purpose — the
  -- coordinator may not bucket every entry, and we don't want a CHECK
  -- constraint blocking long-tail labels (per LIMB-16.2.4-A doctrine
  -- on enum-locking).
  category text,

  -- Optional human note explaining why this is forbidden for this
  -- venue. Surfaced in admin UI; not used by the matcher.
  reason text,

  -- Soft delete only; keep history for audit.
  deleted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A venue can't have two identical keywords (case-insensitive). The
  -- partial unique index excludes soft-deleted rows so a coordinator
  -- can re-add a previously-removed keyword without colliding.
  CONSTRAINT venue_forbidden_topics_keyword_nonempty
    CHECK (length(trim(keyword)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_forbidden_topics_venue_keyword
  ON public.venue_forbidden_topics (venue_id, lower(keyword))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_venue_forbidden_topics_venue
  ON public.venue_forbidden_topics (venue_id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.venue_forbidden_topics IS
  'Per-venue extension of the global ESCALATION_KEYWORDS list. '
  'checkEscalation(text, venueId) merges these with the global '
  'defaults at request time. Coordinators add venue-specific '
  'triggers via admin UI under /agent/forbidden-topics. Per Playbook '
  'LIMB-16.4 / T1-J B-21.';

ALTER TABLE public.venue_forbidden_topics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_forbidden_topics_select" ON public.venue_forbidden_topics;
CREATE POLICY "venue_forbidden_topics_select" ON public.venue_forbidden_topics
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "venue_forbidden_topics_insert" ON public.venue_forbidden_topics;
CREATE POLICY "venue_forbidden_topics_insert" ON public.venue_forbidden_topics
  FOR INSERT TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "venue_forbidden_topics_update" ON public.venue_forbidden_topics;
CREATE POLICY "venue_forbidden_topics_update" ON public.venue_forbidden_topics
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "venue_forbidden_topics_service" ON public.venue_forbidden_topics;
CREATE POLICY "venue_forbidden_topics_service" ON public.venue_forbidden_topics
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
