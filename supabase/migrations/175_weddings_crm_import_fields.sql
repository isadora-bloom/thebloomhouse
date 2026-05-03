-- Migration 175: weddings table — extra CRM-import fields (T5-Rixey-GG /
-- Stream GG).
--
-- Stream FF promoted the HoneyBook adapter against ASSUMED column shape.
-- Then the real Q1 2026 Rixey HoneyBook export landed and shipped six
-- columns FF didn't anticipate: Total Project Value, Tax, Total Paid,
-- Gratuity, Refunded Amount, Team Members. Cramming all of them into
-- weddings.booking_value loses information coordinators care about
-- (was this $20k a refund-pending booking? was the $5k tip part of the
-- contract?). Stream GG splits these out so the financial detail
-- survives the import + the per-row import warnings get a place to live
-- for coordinator review.
--
-- Adds columns to public.weddings:
--   - tax_amount         integer (cents)  — tax portion of booking_value
--   - amount_paid        integer (cents)  — already-paid portion
--   - gratuity_amount    integer (cents)  — staff/coordinator gratuity
--   - refunded_amount    integer (cents)  — refunded portion
--   - crm_external_id    text             — provider's primary key (so we
--                                             can dedup re-imports + round-
--                                             trip back to HoneyBook /
--                                             Dubsado / etc. later)
--   - crm_team_members   jsonb            — provider-side team assignments
--                                             before user_profiles exist
--                                             for them
--                                             [{name, email, role}]
--   - import_warnings    jsonb            — per-row import-time issues for
--                                             coordinator review
--                                             [{field, issue, value}]
--
-- All cents columns are integer (Bloom convention — never decimal).
-- All columns nullable (NULL means "not provided by the source CRM" —
-- existing pipeline-ingested rows stay NULL forever, no backfill).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- Safe to re-apply.

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS tax_amount integer NULL;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS amount_paid integer NULL;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS gratuity_amount integer NULL;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS refunded_amount integer NULL;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS crm_external_id text NULL;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS crm_team_members jsonb NULL;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS import_warnings jsonb NULL;

-- Sanity checks: cents must be non-negative when present (drop + recreate
-- so re-applying the migration stays clean).
ALTER TABLE public.weddings
  DROP CONSTRAINT IF EXISTS weddings_tax_amount_nonneg;
ALTER TABLE public.weddings
  ADD CONSTRAINT weddings_tax_amount_nonneg
    CHECK (tax_amount IS NULL OR tax_amount >= 0);

ALTER TABLE public.weddings
  DROP CONSTRAINT IF EXISTS weddings_amount_paid_nonneg;
ALTER TABLE public.weddings
  ADD CONSTRAINT weddings_amount_paid_nonneg
    CHECK (amount_paid IS NULL OR amount_paid >= 0);

ALTER TABLE public.weddings
  DROP CONSTRAINT IF EXISTS weddings_gratuity_amount_nonneg;
ALTER TABLE public.weddings
  ADD CONSTRAINT weddings_gratuity_amount_nonneg
    CHECK (gratuity_amount IS NULL OR gratuity_amount >= 0);

ALTER TABLE public.weddings
  DROP CONSTRAINT IF EXISTS weddings_refunded_amount_nonneg;
ALTER TABLE public.weddings
  ADD CONSTRAINT weddings_refunded_amount_nonneg
    CHECK (refunded_amount IS NULL OR refunded_amount >= 0);

-- Index on (venue_id, crm_source, crm_external_id) so re-running an
-- import for the same venue + same provider can short-circuit on
-- already-imported rows.
CREATE INDEX IF NOT EXISTS idx_weddings_crm_external_id
  ON public.weddings (venue_id, crm_source, crm_external_id)
  WHERE crm_external_id IS NOT NULL;

-- Documentation.
COMMENT ON COLUMN public.weddings.tax_amount IS
  'Tax portion of booking_value, in cents. Populated by CRM-import '
  'adapters when the source CRM ships a separate Tax column (HoneyBook). '
  'NULL means the source CRM did not surface tax separately. '
  'Per T5-Rixey-GG / Stream GG.';

COMMENT ON COLUMN public.weddings.amount_paid IS
  'Already-paid portion of booking_value, in cents. Populated by '
  'CRM-import adapters from the source CRMs ''Total Paid'' column. '
  'Per T5-Rixey-GG / Stream GG.';

COMMENT ON COLUMN public.weddings.gratuity_amount IS
  'Staff/coordinator gratuity (tip) in cents. Populated by CRM-import '
  'adapters from the source CRM''s Gratuity column. May be > 0 even '
  'when amount_paid = 0 (gratuity recorded ahead of payment). '
  'Per T5-Rixey-GG / Stream GG.';

COMMENT ON COLUMN public.weddings.refunded_amount IS
  'Refunded portion of booking_value, in cents. Populated by CRM-import '
  'adapters from the source CRM''s Refunded Amount column. '
  'Per T5-Rixey-GG / Stream GG.';

COMMENT ON COLUMN public.weddings.crm_external_id IS
  'Provider''s primary key for this row (HoneyBook project_id, Dubsado '
  'project_id, Aisle Planner lead_id). Populated when the source export '
  'includes an ID column. Used for re-import dedup and future round-trip '
  'sync. Per T5-Rixey-GG / Stream GG.';

COMMENT ON COLUMN public.weddings.crm_team_members IS
  'Provider-side team assignments (coordinator / planner / venue staff) '
  'as a JSONB array of {name, email, role} objects. Populated by '
  'CRM-import adapters before matching user_profiles exist. Used to '
  'reconstruct ownership timelines and to seed user invitations. '
  'Per T5-Rixey-GG / Stream GG.';

COMMENT ON COLUMN public.weddings.import_warnings IS
  'Per-row import-time issues surfaced for coordinator review as a '
  'JSONB array of {field, issue, value} objects. Examples: missing '
  'partner email, unknown CRM status, ambiguous tax-inclusivity. '
  'Coordinators clear these by editing the row. '
  'Per T5-Rixey-GG / Stream GG.';
