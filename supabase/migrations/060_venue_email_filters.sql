-- ============================================================================
-- Migration 060: Per-venue inbox filters
-- ============================================================================
--
-- Lets each venue decide which senders to drop before the classifier runs and
-- which senders to classify-but-not-draft. Replaces a hard-coded global list
-- with per-tenant config so Rixey's noise isn't Hawthorne's noise.
--
-- pattern_type:
--   sender_exact  — full email match (e.g. notifications@calendly.com)
--   sender_domain — domain suffix match (e.g. mailchimp.com, mcsv.net)
--   gmail_label   — Gmail label id/name (e.g. CATEGORY_PROMOTIONS)
--
-- action:
--   ignore   — drop before classifier. Nothing stored in interactions.
--   no_draft — classify + persist interaction, but don't generate a draft.
--              Keeps intelligence data, just stops Sage from replying.
--
-- source:
--   manual   — venue staff added it by hand
--   learned  — nightly job promoted it based on N consecutive non-inquiry
--              classifications from the same sender/domain
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.venue_email_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  pattern_type text NOT NULL CHECK (pattern_type IN ('sender_exact', 'sender_domain', 'gmail_label')),
  pattern text NOT NULL CHECK (length(trim(pattern)) > 0),
  action text NOT NULL DEFAULT 'ignore' CHECK (action IN ('ignore', 'no_draft')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'learned')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, pattern_type, pattern)
);

CREATE INDEX IF NOT EXISTS venue_email_filters_venue_id_idx
  ON public.venue_email_filters (venue_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Policy style mirrors migration 058: scalar subquery against user_profiles,
-- joined via venues.org_id. Split per operation (no FOR ALL) to match the
-- rest of the codebase and keep the parser happy in the Supabase editor.
ALTER TABLE public.venue_email_filters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_email_filters_select" ON public.venue_email_filters;
DROP POLICY IF EXISTS "venue_email_filters_insert" ON public.venue_email_filters;
DROP POLICY IF EXISTS "venue_email_filters_update" ON public.venue_email_filters;
DROP POLICY IF EXISTS "venue_email_filters_delete" ON public.venue_email_filters;

-- Anyone in the venue's org can read.
CREATE POLICY "venue_email_filters_select" ON public.venue_email_filters
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT id FROM public.venues
      WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
    )
  );

-- Coordinators, managers, and admins in the venue's org can write.
CREATE POLICY "venue_email_filters_insert" ON public.venue_email_filters
  FOR INSERT TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT id FROM public.venues
      WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
    )
    AND (SELECT role FROM public.user_profiles WHERE id = auth.uid())
        IN ('super_admin', 'org_admin', 'venue_manager', 'coordinator')
  );

CREATE POLICY "venue_email_filters_update" ON public.venue_email_filters
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT id FROM public.venues
      WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
    )
    AND (SELECT role FROM public.user_profiles WHERE id = auth.uid())
        IN ('super_admin', 'org_admin', 'venue_manager', 'coordinator')
  )
  WITH CHECK (
    venue_id IN (
      SELECT id FROM public.venues
      WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
    )
  );

CREATE POLICY "venue_email_filters_delete" ON public.venue_email_filters
  FOR DELETE TO authenticated
  USING (
    venue_id IN (
      SELECT id FROM public.venues
      WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
    )
    AND (SELECT role FROM public.user_profiles WHERE id = auth.uid())
        IN ('super_admin', 'org_admin', 'venue_manager', 'coordinator')
  );

-- ── Seed: common bulk-ESP domains ───────────────────────────────────────────
-- Return-path / envelope-from domains used by marketing platforms. Seeded
-- per venue rather than hard-coded in code so venues can remove any they
-- actually want to hear from.
INSERT INTO public.venue_email_filters (venue_id, pattern_type, pattern, action, source, note)
SELECT v.id, 'sender_domain', d.domain, 'ignore', 'manual', 'Bulk email infrastructure (seeded)'
FROM public.venues v
CROSS JOIN (VALUES
  ('mailchimpapp.com'),
  ('mcsv.net'),
  ('rsgsv.net'),
  ('sendgrid.net'),
  ('amazonses.com'),
  ('mailgun.org'),
  ('klaviyomail.com'),
  ('hubspotemail.net'),
  ('constantcontact.com'),
  ('cmail19.com'),
  ('cmail20.com'),
  ('email.mailchimpapp.com')
) AS d(domain)
ON CONFLICT (venue_id, pattern_type, pattern) DO NOTHING;

-- Gmail's Promotions + Social as removable label filters (also excluded at
-- the Gmail fetch layer via the `q` param in gmail.ts, but keeping them as
-- rows makes them visible in the settings UI).
INSERT INTO public.venue_email_filters (venue_id, pattern_type, pattern, action, source, note)
SELECT v.id, 'gmail_label', l.label, 'ignore', 'manual', 'Gmail auto-category (seeded)'
FROM public.venues v
CROSS JOIN (VALUES
  ('CATEGORY_PROMOTIONS'),
  ('CATEGORY_SOCIAL')
) AS l(label)
ON CONFLICT (venue_id, pattern_type, pattern) DO NOTHING;

NOTIFY pgrst, 'reload schema';
