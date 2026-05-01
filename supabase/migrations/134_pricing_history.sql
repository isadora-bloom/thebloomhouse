-- Migration 134: pricing_history + auto-logger trigger (T2-B Phase 2 / LIMB-16.2.3)
--
-- Per Playbook Part 16.2.3 / INS-19.5.2 (pricing elasticity insight):
-- changes to a venue's pricing are causally important for downstream
-- analysis. A coordinator who notices "tour-to-book conversion
-- dropped after May" needs the pricing-change history to know
-- whether they raised the base price on May 1.
--
-- Pre-T2-B Phase 2 there was no schema for this; pricing changes
-- were lost silently into the venue_config row's mtime. This
-- migration adds:
--   1. pricing_history table — append-only audit row per change
--   2. AFTER UPDATE trigger on venue_config that auto-logs base_price
--      + capacity changes (the two most-frequently-tuned pricing
--      inputs)
--   3. Service-side write path for non-trigger-tracked changes (tier
--      structure changes, calculator-config edits, etc.) — writers
--      call recordPricingChange() in src/lib/services/pricing-history.ts
--
-- Idempotent: CREATE TABLE / TRIGGER IF NOT EXISTS / OR REPLACE.

CREATE TABLE IF NOT EXISTS public.pricing_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Which pricing input changed. Free-form so future calculator-config
  -- edits can log granular field names. Common values:
  --   'base_price', 'capacity', 'tier_structure', 'weekday_discount',
  --   'peak_season_multiplier', 'add_on_<name>', 'minimum_spend'.
  field_name text NOT NULL CHECK (length(trim(field_name)) > 0),

  -- Old + new values as jsonb so structural changes (tier
  -- restructuring, multi-field rate changes) can be captured
  -- alongside simple numeric edits. Numeric changes go in as
  -- {"value": 12000}.
  old_value jsonb,
  new_value jsonb,

  -- WHO made the change. NULL for trigger-fired rows where we couldn't
  -- determine the auth context (background imports, cron, raw SQL).
  -- The service-side helper (recordPricingChange) populates this from
  -- the request auth context.
  changed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,

  -- WHY. Free text — 'admin UI edit', 'seasonal adjustment',
  -- 'CRM import', 'pricing review meeting 2026-04'.
  context text,

  -- Optional coordinator note explaining the change. INS-19.5.2
  -- elasticity insight reads this to weight whether the change was
  -- demand-side ('matched competitor pricing') vs supply-side
  -- ('renovation increased capacity'). Null until coordinator
  -- annotates.
  notes text,

  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_history_venue_changed
  ON public.pricing_history (venue_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_pricing_history_field
  ON public.pricing_history (venue_id, field_name, changed_at DESC);

COMMENT ON TABLE public.pricing_history IS
  'Append-only audit of venue pricing changes. AFTER UPDATE trigger '
  'on venue_config auto-logs base_price + capacity changes; service-'
  'side writers call recordPricingChange for richer / non-trigger '
  'fields. Read by INS-19.5.2 pricing elasticity insight + the '
  'anomaly hypothesis prompt. Per Playbook LIMB-16.2.3.';

ALTER TABLE public.pricing_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pricing_history_select" ON public.pricing_history;
CREATE POLICY "pricing_history_select" ON public.pricing_history
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

-- pricing_history is append-only at the application level; allow
-- INSERT for authenticated venue users so the service-side writer
-- can run with user auth, and ALL for service_role for the trigger.
DROP POLICY IF EXISTS "pricing_history_insert" ON public.pricing_history;
CREATE POLICY "pricing_history_insert" ON public.pricing_history
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

DROP POLICY IF EXISTS "pricing_history_service" ON public.pricing_history;
CREATE POLICY "pricing_history_service" ON public.pricing_history
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- AFTER UPDATE trigger on venue_config: auto-log base_price +
-- capacity changes. Idempotent — same UPDATE running twice on the
-- same row produces one row per (real) value change.
CREATE OR REPLACE FUNCTION public.log_venue_pricing_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.base_price IS DISTINCT FROM OLD.base_price THEN
    INSERT INTO public.pricing_history (venue_id, field_name, old_value, new_value, context)
    VALUES (
      NEW.venue_id,
      'base_price',
      jsonb_build_object('value', OLD.base_price),
      jsonb_build_object('value', NEW.base_price),
      'venue_config trigger'
    );
  END IF;
  IF NEW.capacity IS DISTINCT FROM OLD.capacity THEN
    INSERT INTO public.pricing_history (venue_id, field_name, old_value, new_value, context)
    VALUES (
      NEW.venue_id,
      'capacity',
      jsonb_build_object('value', OLD.capacity),
      jsonb_build_object('value', NEW.capacity),
      'venue_config trigger'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_config_pricing_history ON public.venue_config;
CREATE TRIGGER trg_venue_config_pricing_history
  AFTER UPDATE OF base_price, capacity ON public.venue_config
  FOR EACH ROW
  EXECUTE FUNCTION public.log_venue_pricing_change();

COMMENT ON FUNCTION public.log_venue_pricing_change() IS
  'AFTER UPDATE trigger: appends a pricing_history row whenever '
  'venue_config.base_price or .capacity changes. Captures '
  'value-only deltas; structural pricing edits (tier restructuring) '
  'flow through service-side recordPricingChange instead. Per '
  'Playbook LIMB-16.2.3 / INS-19.5.2.';
