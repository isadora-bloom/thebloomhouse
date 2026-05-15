-- ---------------------------------------------------------------------------
-- 349_identity_first_resurrection_blacklist.sql
-- ---------------------------------------------------------------------------
-- Phase E §9 — resurrection dispute support.
--
-- Anchor: IDENTITY-FIRST-ARCHITECTURE.md §9 ("Resurrection dispute
-- flow") + §9 Don't skip #3 ("I will skip the blacklist. Then the
-- same Ghost re-resurrects every week and Susan rejects it every
-- week and loses trust.").
--
-- When the Forwards Linker lands a high-tier match on a Ghost couple
-- it resurrects them (lifecycle_state ghost -> resolved). If the
-- operator disputes that ("recycled email", "different couple same
-- name", "phone number reassigned"), the disputed identifier is
-- written here so a future signal carrying the SAME identifier never
-- re-resurrects the SAME ghost.
--
-- Scope of a blacklist row
-- ------------------------
-- Keyed on (venue_id, couple_id, identifier). The identifier is the
-- normalised email or phone that triggered the bad resurrection.
-- identifier_kind records which. A blacklist hit means "this
-- identifier must not resurrect this specific ghost" — it does NOT
-- block the identifier globally (a recycled email genuinely belongs
-- to a different couple now, and that couple should still match).
--
-- Rerun safety: CREATE TABLE IF NOT EXISTS + idempotent index +
-- DROP POLICY IF EXISTS. Safe to run multiple times.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resurrection_blacklist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id        uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  couple_id       uuid NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  identifier      text NOT NULL,
  identifier_kind text NOT NULL CHECK (identifier_kind IN ('email','phone','other')),
  reason          text,
  operator_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE resurrection_blacklist IS
  'Per-(ghost couple, identifier) suppression list. A disputed resurrection '
  'writes a row here so the same identifier never re-resurrects the same '
  'ghost. See IDENTITY-FIRST-ARCHITECTURE.md §9.';

-- One row per (venue, couple, identifier) — re-rejecting the same
-- pairing is a no-op via ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS uq_resurrection_blacklist_triple
  ON resurrection_blacklist (venue_id, couple_id, lower(identifier));

CREATE INDEX IF NOT EXISTS ix_resurrection_blacklist_lookup
  ON resurrection_blacklist (venue_id, lower(identifier));

-- ---------------------------------------------------------------------------
-- RLS — mirrors the couples policy pattern from migration 346.
-- ---------------------------------------------------------------------------

ALTER TABLE resurrection_blacklist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "resurrection_blacklist_select" ON public.resurrection_blacklist;
CREATE POLICY "resurrection_blacklist_select" ON public.resurrection_blacklist
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

DROP POLICY IF EXISTS "resurrection_blacklist_modify" ON public.resurrection_blacklist;
CREATE POLICY "resurrection_blacklist_modify" ON public.resurrection_blacklist
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

DROP POLICY IF EXISTS "resurrection_blacklist_service" ON public.resurrection_blacklist;
CREATE POLICY "resurrection_blacklist_service" ON public.resurrection_blacklist
  FOR ALL TO service_role USING (true) WITH CHECK (true);
