-- ---------------------------------------------------------------------------
-- 305_agency_spend_channel_linkage.sql  (Wave 6E — agency linkage)
-- ---------------------------------------------------------------------------
-- Migration 304 landed the agency entity + engagement. This migration
-- wires it into the existing spend / channel substrates so the ROI
-- compute path can answer "which agency does this spend belong to?"
-- and "which agency manages this channel?" without re-architecting
-- the existing Wave 6A/6D pipeline.
--
-- Adds:
--   - marketing_spend_records.agency_id (nullable FK)
--     Per-row tag identifying which agency the spend was paid to or
--     managed by. NULL = unattributed (the org spent directly, or
--     the row predates agency tracking).
--
--   - marketing_channels.managed_by_agency_id (nullable FK)
--     Per-channel tag. When set, every attribution_event sourced from
--     this channel rolls up under the agency in TBH Reports.
--
-- Idempotent: ALTER ... ADD COLUMN IF NOT EXISTS + DROP/CREATE indexes.
-- No BEGIN/COMMIT wrapper (exec_sql RPC rejects them — see Wave 23
-- doctrine in feedback_migration_no_transaction_wrapper memory).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — marketing_spend_records.agency_id
-- ============================================================================
-- ON DELETE SET NULL so deleting an agency doesn't blow away historical
-- spend records. The spend row keeps its other columns; only the
-- agency association drops.

ALTER TABLE public.marketing_spend_records
  ADD COLUMN IF NOT EXISTS agency_id uuid
  REFERENCES public.marketing_agencies(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.marketing_spend_records.agency_id IS
  'Wave 6E. Optional FK to marketing_agencies. When set, indicates '
  'this spend row was paid to or managed by the named agency. NULL = '
  'no agency context (direct spend, pre-tracking, or in-house). '
  'TBH agency-ROI rollups GROUP BY agency_id. ON DELETE SET NULL so '
  'agency deletion preserves spend history.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_records_agency
  ON public.marketing_spend_records (agency_id, spend_date DESC)
  WHERE agency_id IS NOT NULL;

COMMENT ON INDEX public.idx_marketing_spend_records_agency IS
  'Wave 6E. Hot-path: "total spend to Hawthorn in last 90 days", '
  'agency P&L rollup. Partial index — agency_id IS NOT NULL skips '
  'the (large) unattributed-spend tail.';

-- ============================================================================
-- STEP 2 — marketing_channels.managed_by_agency_id
-- ============================================================================
-- When a channel is "managed" by an agency, every attribution_event
-- sourced from that channel rolls up under the agency. Same FK
-- semantics: SET NULL on agency delete to preserve channel rows.

ALTER TABLE public.marketing_channels
  ADD COLUMN IF NOT EXISTS managed_by_agency_id uuid
  REFERENCES public.marketing_agencies(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.marketing_channels.managed_by_agency_id IS
  'Wave 6E. Optional FK to marketing_agencies. When set, every '
  'attribution_event whose source_platform matches this channel''s '
  'key rolls up under the named agency in TBH Reports. The agency '
  '"manages" the channel — they''re the ones making decisions about '
  'spend / creative / targeting. ON DELETE SET NULL.';

CREATE INDEX IF NOT EXISTS idx_marketing_channels_managed_by_agency
  ON public.marketing_channels (managed_by_agency_id)
  WHERE managed_by_agency_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX public.idx_marketing_channels_managed_by_agency IS
  'Wave 6E. "Which channels does this agency manage?" reverse '
  'lookup. Used by agency-detail page + ROI compute.';

NOTIFY pgrst, 'reload schema';
