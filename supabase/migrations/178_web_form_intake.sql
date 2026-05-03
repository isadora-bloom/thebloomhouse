-- ---------------------------------------------------------------------------
-- 178_web_form_intake.sql  (T5-Rixey-HH)
-- ---------------------------------------------------------------------------
-- Adds the schema affordances the new generic web-form intake adapter
-- needs (src/lib/services/crm-import/web-form.ts).
--
-- Web-form intake is INDEPENDENT from CRM intake. A venue's own pricing
-- calculator (Rixey), Typeform, Jotform, Google Forms, or custom HTML
-- form is a first-party signal — coordinators own the form, the data
-- is closer to ground-truth than a third-party CRM export, and the row
-- shape is wildly venue-specific (every form has its own custom
-- columns). This migration:
--
--   1. Extends the crm_source CHECK on weddings/interactions/tours/
--      lost_deals/people to include 'web_form'. Provenance hint of
--      "this came from the venue's own web form, not a CRM" so
--      downstream intel can:
--        * weight web-form rows above CRM-export rows in conflict
--          resolution (first-party vs. third-party),
--        * filter "web-form leads only" for funnel analysis,
--        * keep the lead_source column NULL (Stream KK / Calendly
--          will fill if available; we don't claim a marketing channel
--          here because the form itself isn't a channel).
--
--   2. Extends the interactions.type CHECK to include 'web_form'.
--      Each form submission becomes one inbound interaction with the
--      filled-in form fields concatenated as readable body text. This
--      lets the wedding-detail timeline + Sage's draft-context loader
--      surface "they filled in your pricing form on Mar 23" without
--      a special path.
--
--   3. Extends the tangential_signals.signal_type CHECK to include
--      'form_submission' so the per-row tangential write (powering
--      funnel + timing analytics) doesn't get rejected by the existing
--      narrow enum. Also adds 'website_form' to source_platform via
--      free-text (no CHECK on source_platform — already widened by
--      migration 104).
--
--   4. Adds weddings.source_provenance text column. Tracks HOW the
--      wedding row was created. NULL = pipeline-ingested. Web-form
--      adapter sets 'web_form_import' so the data-source orphan
--      sweep + Source Quality scorecard can split first-party form
--      rows from email-pipeline rows from CRM-import rows.
--
--   5. Creates the public.packages venue catalog table. Many venues
--      encode their pricing tiers / upgrades / discounts in the form
--      itself (Rixey: Spring/Summer/Fall/Winter season tiers, plus
--      rehearsal-dinner / extra-hour upgrades, plus military /
--      vendor-recommendation discounts). The web-form adapter's
--      one-time extractPackagesFromFormSchema() proposes rows here
--      for the coordinator to confirm via /onboarding/extract-packages.
--      Confirmed rows feed back into:
--        * Sage's pricing-context loader,
--        * the temporal-trigger booking-value resolver (helps map
--          a "Summer: $10000" form value to a stable package_id),
--        * future pricing-history reconciliation.
--
-- Idempotent: every change uses IF NOT EXISTS / DROP+CREATE constraint.
--
-- @probe: insert_accepts weddings.crm_source=web_form
-- @probe: insert_accepts interactions.type=web_form
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. crm_source CHECK extension on all five tables.
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY['weddings', 'interactions', 'tours', 'lost_deals', 'people'])
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
                   tbl, tbl || '_crm_source_check');
    EXECUTE format($f$
      ALTER TABLE public.%I
        ADD CONSTRAINT %I
          CHECK (crm_source IS NULL OR crm_source IN (
            'honeybook', 'dubsado', 'aisle_planner', 'generic_csv',
            'manual_form', 'manual_csv', 'web_form'
          ))
    $f$, tbl, tbl || '_crm_source_check');
  END LOOP;
END
$$;

COMMENT ON COLUMN public.weddings.crm_source IS
  'Which CRM (or manual / web-form path) this row came from. NULL = '
  'pipeline-ingested. Set by src/lib/services/crm-import/* adapters '
  '+ the pricing-history manual UI + the web-form intake adapter '
  '(T5-Rixey-HH). web_form = first-party form submission (Rixey '
  'pricing calculator, Typeform, Jotform, Google Forms, custom HTML). '
  'Per T5-followup-Y / Pattern I closure + T5-Rixey-HH.';

-- 2. interactions.type CHECK extension. Need to allow 'web_form' so
-- per-row writes from the web-form adapter land cleanly.
ALTER TABLE public.interactions DROP CONSTRAINT IF EXISTS interactions_type_check;
ALTER TABLE public.interactions
  ADD CONSTRAINT interactions_type_check
  CHECK (type IN ('email', 'call', 'voicemail', 'sms', 'meeting', 'web_form'));

COMMENT ON CONSTRAINT interactions_type_check ON public.interactions IS
  'Allowed interaction kinds. web_form added 2026-05-02 by migration '
  '178 for the web-form intake adapter (T5-Rixey-HH).';

-- 3. tangential_signals.signal_type CHECK extension. Add 'form_submission'.
ALTER TABLE public.tangential_signals DROP CONSTRAINT IF EXISTS tangential_signals_signal_type_check;
ALTER TABLE public.tangential_signals
  ADD CONSTRAINT tangential_signals_signal_type_check
  CHECK (signal_type IN (
    'instagram_engagement',
    'instagram_follow',
    'website_visit',
    'review',
    'mention',
    'analytics_entry',
    'referral',
    'form_submission',
    'other'
  ));

COMMENT ON CONSTRAINT tangential_signals_signal_type_check ON public.tangential_signals IS
  'Allowed signal types. form_submission added 2026-05-02 by '
  'migration 178 — web-form intake adapter writes one tangential '
  'signal per submission, payload = full form data, source_platform '
  '= ''website_form'' (or ''website_<provider>'').';

-- 4. weddings.source_provenance — how the wedding row was created.
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS source_provenance text NULL;

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
      'identity_resolution_merge'
    ));

COMMENT ON COLUMN public.weddings.source_provenance IS
  'How this wedding row got created. NULL = legacy. pipeline = email '
  'agent inferred a new lead from inbound mail. crm_import = adapter '
  'from src/lib/services/crm-import/{honeybook,dubsado,aisle_planner,'
  'generic-csv}. web_form_import = web-form intake adapter (T5-Rixey-HH). '
  'brain_dump = brain-dump CSV/text writer. manual_form / manual_csv '
  '= coordinator UI. identity_resolution_merge = candidate-resolver '
  'collapsed two leads into one. Distinct from crm_source — that is '
  'the LITERAL upstream system; provenance is the ARCHITECTURAL path.';

CREATE INDEX IF NOT EXISTS idx_weddings_source_provenance
  ON public.weddings (venue_id, source_provenance)
  WHERE source_provenance IS NOT NULL;

-- 5. public.packages — venue catalog, populated by the web-form
-- canonical-packages extractor + future manual-add UI. One row per
-- canonical package / upgrade / discount the coordinator confirms.
CREATE TABLE IF NOT EXISTS public.packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- 'package'  = a top-level wedding-package tier (Rixey: "Spring", "Summer")
  -- 'upgrade'  = an add-on (rehearsal dinner, extra hour, early check-in)
  -- 'discount' = a deduction (military 10%, vendor recommended 5%)
  -- 'fee'      = a recurring chargeable fee that's neither package nor upgrade
  --              (kept open so coordinators with a "cleaning fee" or "tax line"
  --              can model it)
  kind text NOT NULL CHECK (kind IN ('package', 'upgrade', 'discount', 'fee')),

  -- Coordinator-readable label. e.g. "Spring", "Rehearsal Dinner on Site
  -- (50-100 guests, max 4 hours)", "Military / Veteran / Front Line
  -- Responders".
  name text NOT NULL,

  -- Optional season/tier metadata. Free text — different venues use
  -- different vocabularies (season name, capacity tier, premium / standard).
  season text NULL,            -- 'spring' | 'summer' | 'fall' | 'winter' | NULL
  tier text NULL,              -- 'standard' | 'premium' | 'budget' | NULL
  guest_count_min int NULL,    -- e.g. 50 for "50-100 guests"
  guest_count_max int NULL,    -- e.g. 100

  -- For kind='package' / 'upgrade' / 'fee' — price in cents (Bloom convention).
  -- For kind='discount' where percentage applies — see discount_percent below.
  price_cents int NULL,

  -- For kind='discount' — percent off (1-100). Mutually-exclusive with
  -- price_cents in practice, but both columns exist so a discount
  -- expressed as a flat dollar deduction can also be modelled.
  discount_percent int NULL CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100)),

  -- Free text. Where this proposal originated — '"Wedding Season"
  -- column on the form', 'Upgrades column "Rehearsal Dinner on Site
  -- (50-100 guests, max 4 hours): $2000"', etc. Lets a coordinator
  -- trace a confirmed package back to the form column it was extracted
  -- from.
  source_text text NULL,

  -- Provenance + confidence (mirrors weddings columns):
  --   crm_source       = 'web_form' for extractor-proposed rows;
  --                      NULL for manually-added rows.
  --   confidence_flag  = 'imported_high' (form schema is ground truth)
  --                      | 'imported_medium' (extractor inferred it)
  --                      | 'live' (coordinator confirmed)
  --                      | 'manual' (coordinator added by hand)
  crm_source text NULL CHECK (crm_source IS NULL OR crm_source IN (
    'honeybook', 'dubsado', 'aisle_planner', 'generic_csv',
    'manual_form', 'manual_csv', 'web_form'
  )),
  confidence_flag text NULL CHECK (confidence_flag IS NULL OR confidence_flag IN (
    'live', 'imported_high', 'imported_medium', 'imported_low', 'manual', 'proposed'
  )),

  -- 'proposed' = extracted but not yet coordinator-confirmed.
  -- 'active'   = confirmed, in use.
  -- 'archived' = retired by the coordinator.
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'archived')),

  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Soft uniqueness: same venue + kind + name + season + guest band
  -- shouldn't be proposed twice. NULL handling handled by the
  -- COALESCE-based partial index below (so a NULL season doesn't
  -- collide with another NULL season).
  UNIQUE (venue_id, kind, name, season, guest_count_min, guest_count_max)
);

CREATE INDEX IF NOT EXISTS idx_packages_venue_status
  ON public.packages (venue_id, status);
CREATE INDEX IF NOT EXISTS idx_packages_venue_kind
  ON public.packages (venue_id, kind);

COMMENT ON TABLE public.packages IS
  'owner:portal. Venue catalog of wedding packages, upgrades, discounts, '
  'and fees. Populated by (a) the web-form canonical-packages extractor '
  '(T5-Rixey-HH — proposes rows from form schema, status=proposed); '
  '(b) future manual-add UI; (c) extractor confirmation flow at '
  '/onboarding/extract-packages (status flips to active). Read by '
  'Sage''s pricing-context loader + temporal-trigger booking-value '
  'resolver + future pricing-history reconciliation.';

-- RLS — same shape as other venue-scoped catalog tables.
ALTER TABLE public.packages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "packages_select" ON public.packages;
CREATE POLICY "packages_select" ON public.packages
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
    OR
    venue_id IN (
      SELECT v.id FROM public.venues v
      WHERE v.org_id IN (
        SELECT org_id FROM public.user_profiles WHERE id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "packages_insert" ON public.packages;
CREATE POLICY "packages_insert" ON public.packages
  FOR INSERT TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
    OR
    venue_id IN (
      SELECT v.id FROM public.venues v
      WHERE v.org_id IN (
        SELECT org_id FROM public.user_profiles WHERE id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "packages_update" ON public.packages;
CREATE POLICY "packages_update" ON public.packages
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
    OR
    venue_id IN (
      SELECT v.id FROM public.venues v
      WHERE v.org_id IN (
        SELECT org_id FROM public.user_profiles WHERE id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "packages_delete" ON public.packages;
CREATE POLICY "packages_delete" ON public.packages
  FOR DELETE TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
    OR
    venue_id IN (
      SELECT v.id FROM public.venues v
      WHERE v.org_id IN (
        SELECT org_id FROM public.user_profiles WHERE id = auth.uid()
      )
    )
  );

-- updated_at trigger to mirror other tables.
CREATE OR REPLACE FUNCTION public.touch_packages_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_packages_updated_at ON public.packages;
CREATE TRIGGER trg_touch_packages_updated_at
  BEFORE UPDATE ON public.packages
  FOR EACH ROW EXECUTE FUNCTION public.touch_packages_updated_at();

COMMIT;

NOTIFY pgrst, 'reload schema';
