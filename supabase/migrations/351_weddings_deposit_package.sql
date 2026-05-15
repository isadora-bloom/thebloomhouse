-- ---------------------------------------------------------------------------
-- 351_weddings_deposit_package.sql
-- ---------------------------------------------------------------------------
-- Booked-couple CSV import was silently dropping commercial fields.
-- An audit of the HoneyBook adapter found that a booked-couple export
-- carries data Bloom had no column for:
--
--   deposit / retainer amount  -- no column existed
--   package / tier / collection -- no column existed
--
-- The other commercial fields a HoneyBook export carries already have
-- columns from earlier migrations and just needed the adapter wired
-- to them (tax_amount, amount_paid, gratuity_amount, refunded_amount
-- from migration 175; guest_count_estimate from migration 165). This
-- migration adds the two that were genuinely missing.
--
-- Money is stored in integer cents, matching booking_value / tax_amount
-- / amount_paid / gratuity_amount / refunded_amount.
--
-- Rerun safety: ADD COLUMN IF NOT EXISTS.
-- ---------------------------------------------------------------------------

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS deposit_amount integer;

COMMENT ON COLUMN public.weddings.deposit_amount IS
  'Deposit / retainer the couple paid to secure the booking, in integer '
  'cents. Captured from a CRM export deposit/retainer column.';

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS package_name text;

COMMENT ON COLUMN public.weddings.package_name IS
  'Package / tier / collection the couple booked, as named in the CRM '
  'export (free text — e.g. "Saturday Full Weekend", "Elopement").';
