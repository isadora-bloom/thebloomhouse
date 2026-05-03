-- Migration 187: NULL out scheduling-tool / CRM "first-touch" sources
-- (T5-Rixey-TT adapter-as-facts cleanup).
--
-- Background
-- ----------
-- weddings.source is supposed to be the GENUINE first-touch acquisition
-- channel — the_knot / wedding_wire / website / instagram / referral /
-- google / etc. Pre-Stream-TT, several CRM-import adapters wrote
-- factual provenance values (the scheduling tool used / the CRM that
-- exported the row / "other" as a placeholder) into this column because
-- they had nothing better to put there. That short-circuited the lead-
-- source-derivation chain: a non-NULL `weddings.source` made the
-- derivation cron skip the row entirely, leaving Calendly's Q7 ("where
-- did you hear about us?"), email-domain analysis, and UTM tags
-- permanently unread.
--
-- For Rixey specifically:
--   - 417 Calendly events → ~239 Q7 answers in
--     interactions.extracted_identity.hear_source that the derivation
--     never got to read because weddings.source was already 'calendly'.
--   - HoneyBook coordinator-typed "Source" cells (e.g. "The Knot")
--     also got short-circuited because the adapter wrote 'honeybook' /
--     'other' / a canonicalised value before derivation could run.
--
-- Stream-TT refactored the adapters to write FACTS only (crm_source,
-- source_detail, source_provenance, interactions.extracted_identity)
-- and leave weddings.source NULL. This migration cleans up the legacy
-- writes from earlier adapter passes.
--
-- After this migration runs, deriveLeadSourceForAllVenues should be
-- fired immediately so the now-NULL rows get re-derived from Q7 +
-- email-domain + UTM in priority order.
--
-- Multi-venue safe: the WHERE clause is venue-agnostic; every venue
-- with affected rows benefits.
--
-- Idempotent: running twice is a no-op (the second pass UPDATEs zero
-- rows because the first pass already NULLed everything).

UPDATE public.weddings
SET source = NULL,
    -- Reset the derivation cursor so the daily cron re-attempts
    -- immediately rather than waiting for the 30-day re-attempt window
    -- (per migration 182's pagination scheme).
    lead_source_derivation_attempted_at = NULL
WHERE source IN (
  'calendly',
  'honeybook',
  'other',
  'web_form',
  'tour_scheduler',
  'generic_csv',
  'dubsado',
  'aisle_planner'
);

-- Audit trail row in lead_source_derivation_log so coordinators can see
-- why their leads briefly went un-attributed. The cron run that follows
-- this migration will overwrite each row with the derived value (or
-- 'no_signal' if the chain truly finds nothing).
INSERT INTO public.lead_source_derivation_log (
  venue_id,
  wedding_id,
  derived_source,
  priority_used,
  evidence,
  confidence,
  decided_by,
  reason
)
SELECT
  w.venue_id,
  w.id,
  NULL,
  -- priority_used CHECK is [0..6] per migration 177. Use 6 (no_signal)
  -- to mark "this row was reset; derivation must re-run".
  6,
  jsonb_build_object(
    'migration', '187_null_scheduling_tool_sources',
    'reason', 'adapter-as-facts cleanup; pre-Stream-TT adapters wrote scheduling-tool values into weddings.source. Reset to NULL so derivation can run.'
  ),
  'low',
  'auto',
  'migration_187_adapter_as_facts'
FROM public.weddings w
WHERE w.source IS NULL
  AND w.lead_source_derivation_attempted_at IS NULL
  -- Belt-and-braces guard: only log rows that were actually reset by
  -- this migration's UPDATE (lead_source_derivation_attempted_at IS
  -- NULL is the marker). On a second run with no resets, this INSERT
  -- still inserts no rows because the first run's INSERT didn't change
  -- attempted_at; we narrow further by requiring NO existing log row
  -- for this migration to make the second run truly idempotent.
  AND NOT EXISTS (
    SELECT 1 FROM public.lead_source_derivation_log lg
    WHERE lg.wedding_id = w.id
      AND lg.reason = 'migration_187_adapter_as_facts'
  );

COMMENT ON COLUMN public.weddings.source IS
  'GENUINE first-touch acquisition channel (the_knot, wedding_wire, '
  'website, instagram, referral, google, etc.). Set ONLY by the lead-'
  'source-derivation chain or by coordinator override. Per Stream-TT '
  'adapter-as-facts contract (2026-05-02), CRM-import adapters NEVER '
  'write to this column — they write factual provenance to crm_source '
  '/ source_detail / source_provenance and feed attribution data into '
  'interactions.extracted_identity for the derivation chain to read. '
  'Per migration 187 cleanup. Migration 123 dropped the CHECK constraint.';
