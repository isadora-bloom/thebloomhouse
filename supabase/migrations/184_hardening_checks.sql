-- T5-Rixey-RR fixes #2 + #3: hardening CHECK constraints.
--
-- Two unrelated CHECKs landed in one migration because both are tiny
-- safety nets that prevent the same class of bug as Stream NN (silent
-- writer drift breaking downstream readers).
--
-- ---------------------------------------------------------------------------
-- #2: weddings monetary fields bounded to $0 .. $1M (in cents).
-- ---------------------------------------------------------------------------
--
-- Schema convention is "cents everywhere" (per migration 175 + crm-import
-- index). NN's bug #8 was that the data-import + generic-csv + portal
-- manual-create writers wrote DOLLARS into the cents columns, producing
-- the $51,432,396 phantom-revenue artifact. NN added a one-shot backfill
-- (181) and fixed the writers, but nothing schema-side prevents a future
-- writer from regressing.
--
-- The CHECK is a safety net, not a domain constraint:
--   - Real wedding venues book $5k-$50k typical, $100k high-end, $1M is
--     the absolute ceiling for Bloom's target market.
--   - $1M = 100,000,000 cents. A dollars-encoded write of $50,000 would
--     be 50000 (clearly low; CHECK passes). A cents-encoded write of
--     $50,000 = 5,000,000 cents (passes). A cents-encoded write of
--     $500,000 = 50,000,000 cents (passes). A 100x-confused write of
--     $50,000-as-cents = 5,000,000,000 cents → fails the CHECK with a
--     loud error.
--   - The pre-check at scripts/rixey-load/25-precheck-184.mjs verified
--     zero existing rows violate (all 5 fields, including the tax /
--     gratuity / refund / paid columns added in 175).
--
-- Negative values are also rejected — there's no business meaning for a
-- negative booking value, and a negative would silently corrupt
-- aggregations. (refund / lost-deal data goes in dedicated columns or
-- separate tables; weddings.refunded_amount tracks gross refund value
-- non-negatively.)

ALTER TABLE weddings
  ADD CONSTRAINT weddings_booking_value_bounds
  CHECK (booking_value IS NULL OR (booking_value >= 0 AND booking_value <= 100000000));

ALTER TABLE weddings
  ADD CONSTRAINT weddings_tax_amount_bounds
  CHECK (tax_amount IS NULL OR (tax_amount >= 0 AND tax_amount <= 100000000));

ALTER TABLE weddings
  ADD CONSTRAINT weddings_amount_paid_bounds
  CHECK (amount_paid IS NULL OR (amount_paid >= 0 AND amount_paid <= 100000000));

ALTER TABLE weddings
  ADD CONSTRAINT weddings_gratuity_amount_bounds
  CHECK (gratuity_amount IS NULL OR (gratuity_amount >= 0 AND gratuity_amount <= 100000000));

ALTER TABLE weddings
  ADD CONSTRAINT weddings_refunded_amount_bounds
  CHECK (refunded_amount IS NULL OR (refunded_amount >= 0 AND refunded_amount <= 100000000));

-- ---------------------------------------------------------------------------
-- #3: tangential_signals platform-required.
-- ---------------------------------------------------------------------------
--
-- NN's bug #2 fix added a `??` fallback so the correlation engine reads
-- `extracted_identity?.platform ?? source_platform`. Both are populated
-- by current writers (storefront-analytics-import + web-form intake +
-- platform extraction), but nothing schema-side guarantees ONE is
-- always set. A future writer that forgets both would silently break
-- the engine again — there's no SQL error, just zero-classified rows
-- collapsing into 'other_signals'.
--
-- This CHECK forces every insert to populate at least one path. The
-- pre-check confirmed all 2311 existing rows pass.

ALTER TABLE tangential_signals
  ADD CONSTRAINT tangential_signals_platform_required
  CHECK (
    source_platform IS NOT NULL
    OR (extracted_identity IS NOT NULL AND extracted_identity ? 'platform')
  );
