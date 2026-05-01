-- Migration 131: marketing_channels per-venue registry (T2-B Phase 2 / LIMB-16.2.4-A)
--
-- Pre-T2-B Phase 2 the only place a marketing channel could live was
-- a hardcoded const + DB CHECK constraint at three layers
-- (CANONICAL_SOURCES + weddings.source CHECK + wedding_touchpoints
-- .source CHECK + auto_send_rules.source CHECK). Phase 1 / T1-J B-21
-- (migration 123) dropped weddings.source CHECK; Phase 2 introduces
-- the proper venue-scoped channel registry doctrine has been calling
-- for since Playbook Part 16.2.4-A.
--
-- A row in marketing_channels = "this venue actively markets through
-- this channel." Coordinators add long-tail channels (regional bridal
-- magazines, bridal expos, partner referrals, podcast appearances)
-- without code deploys. /intel/sources reads this table to build the
-- channel-mix dashboard. Future ROI calc reads marketing_spend +
-- attribution_events grouped by channel_key.
--
-- The `key` column is the canonical key the rest of the system uses
-- (weddings.source / wedding_touchpoints.source / attribution_events
-- .source_platform). normalize-source.ts continues to map raw inputs
-- ("knot.com" → "the_knot") onto these keys; missing keys fall
-- through to the per-venue admin UI.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, RLS DROP/CREATE.

CREATE TABLE IF NOT EXISTS public.marketing_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Canonical key. Lowercase / underscored. Matches the values the
  -- rest of the system writes ('the_knot', 'wedding_wire', 'instagram',
  -- 'direct', 'referral', 'podcast_X', 'regional_magazine_Y', etc.).
  key text NOT NULL,

  -- Display name. UI uses this in scorecards / dropdowns.
  label text NOT NULL,

  -- Optional grouping. Helps the source-quality dashboard cluster
  -- digital vs print vs partnership channels.
  category text CHECK (
    category IS NULL
    OR category IN (
      'platform',     -- Knot/WW/Zola/HCG
      'social',       -- IG/FB/Pinterest/TikTok
      'search',       -- Google Business / SEO
      'print',        -- Magazines, brochures
      'event',        -- Bridal expos, open houses
      'referral',     -- Partner / preferred-vendor / past-couple
      'direct',       -- Venue's own website
      'paid',         -- Ad campaigns
      'other'
    )
  ),

  -- Per-venue activation. A coordinator may add a channel to track
  -- historical attribution while not actively marketing through it
  -- now. is_active=false rows still appear in /intel/sources but
  -- aren't surfaced as "primary channels."
  is_active boolean NOT NULL DEFAULT true,

  -- Free-form notes for the coordinator (their cadence, contact info,
  -- contract terms). Shown in admin UI but not used by intel.
  notes text,

  -- Soft delete only — preserves attribution history.
  deleted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketing_channels_key_nonempty CHECK (length(trim(key)) > 0),
  CONSTRAINT marketing_channels_label_nonempty CHECK (length(trim(label)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_channels_venue_key
  ON public.marketing_channels (venue_id, lower(key))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_channels_venue_active
  ON public.marketing_channels (venue_id, is_active)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.marketing_channels IS
  'Per-venue marketing channel registry. Replaces the global '
  'CANONICAL_SOURCES const + DB CHECK constraint pattern per '
  'Playbook 16.2.4-A. Coordinators add long-tail channels via '
  '/portal/marketing-channels-config without code deploys. '
  'wedding.source / attribution_events.source_platform write '
  '`key` values from this table; normalize-source.ts maps raw '
  'platform-side strings onto canonical keys at write time.';

ALTER TABLE public.marketing_channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_channels_select" ON public.marketing_channels;
CREATE POLICY "marketing_channels_select" ON public.marketing_channels
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

DROP POLICY IF EXISTS "marketing_channels_modify" ON public.marketing_channels;
CREATE POLICY "marketing_channels_modify" ON public.marketing_channels
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
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

DROP POLICY IF EXISTS "marketing_channels_service" ON public.marketing_channels;
CREATE POLICY "marketing_channels_service" ON public.marketing_channels
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_marketing_channels" ON public.marketing_channels;
CREATE POLICY "demo_anon_select_marketing_channels" ON public.marketing_channels
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

CREATE OR REPLACE FUNCTION public.marketing_channels_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_marketing_channels_updated_at ON public.marketing_channels;
CREATE TRIGGER trg_marketing_channels_updated_at
  BEFORE UPDATE ON public.marketing_channels
  FOR EACH ROW
  EXECUTE FUNCTION public.marketing_channels_touch_updated_at();
