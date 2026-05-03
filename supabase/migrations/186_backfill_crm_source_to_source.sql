-- Migration 186: backfill weddings.source from crm_source for HoneyBook /
-- Calendly imports stamped with the catch-all 'other' bucket.
--
-- T5-Rixey-SS Bug D. The HoneyBook adapter (`commitNormalisedRows`) used
-- to default `weddings.source` to 'other' when the canonicaliser couldn't
-- match the HoneyBook Source field to a known channel. Result: $394k of
-- HoneyBook revenue on Rixey landed under `source='other'` on the Source
-- Quality page (/intel/sources), masking the importer's actual contribution
-- behind a catch-all bucket. The adapter is fixed (commit alongside this
-- migration) — it now defaults to the importing CRM's name. This migration
-- backfills the existing rows.
--
-- Scope: only update rows where:
--   - source = 'other' (catch-all that hides the import)
--   - crm_source IS NOT NULL AND crm_source IN ('honeybook', 'calendly',
--     'dubsado', 'aisle_planner') (importers that have their own channel
--     identity worth surfacing — generic_csv stays 'other' since the
--     channel really is unknown for that path; web_form already has its
--     own canonicalisation that defaults correctly)
--
-- This ALSO restamps the legacy weddings.source so the
-- lead-source-derivation chain's new Priority 7 fallback (T5-Rixey-SS
-- Bug A, migration 185) can resolve these to 'honeybook' / 'calendly'
-- when the higher-priority signals miss. Net: Source Quality page +
-- lead_source distribution both see HoneyBook as a separate row.
--
-- Per Stream SS Bug D. Stream RR uses migration 184; SS reserves 185 + 186.
-- Idempotent — re-running this is a no-op since the WHERE clause matches
-- nothing after the first run.

-- Tour-scheduler / Calendly already writes 'calendly' as the adapter
-- fallback (see src/lib/services/crm-import/tour-scheduler.ts) so the
-- Calendly row count here should be small (only generic_csv-imported
-- Calendly rows where the importer didn't normalise). Still safe to run.

-- Match BOTH source='other' (older behaviour) AND source IS NULL (the
-- importer's actual current behaviour for imports without an explicit
-- channel). Net: every HoneyBook / Calendly / Dubsado / AislePlanner
-- import that doesn't carry a real first-touch ends up labelled with the
-- importing CRM's name.
UPDATE public.weddings
   SET source = crm_source
 WHERE (source = 'other' OR source IS NULL)
   AND crm_source IS NOT NULL
   AND crm_source IN ('honeybook', 'calendly', 'dubsado', 'aisle_planner');

-- Refresh the source_attribution rollup pre-emptively so the
-- coordinator-facing Source Quality page no longer shows the inflated
-- 'other' bucket on the next visit. The cron also refreshes daily; this
-- just shortens the gap.
--
-- Done lazily — we just truncate the per-venue rollup so the next cron
-- pass rebuilds. Avoids needing to invoke the Node refresh function from
-- SQL.
DELETE FROM public.source_attribution
 WHERE venue_id IN (
   SELECT DISTINCT venue_id
     FROM public.weddings
    WHERE crm_source IN ('honeybook', 'calendly', 'dubsado', 'aisle_planner')
 );
