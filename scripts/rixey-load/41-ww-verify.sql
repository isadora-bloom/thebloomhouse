-- Stream WW verification queries.
--
-- Replace :rixey with the Rixey venue id.
--   RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
--
-- Run after 40-ww-calendly-reimport.ts (extracted_identity backfill)
-- and 42-ww-rederive.ts (lead_source re-derivation), then again
-- after 43-ww-refresh-attribution.ts.

-- 1) Count of meeting interactions with extracted_identity.hear_source.
--    Expect >= 239 (Q7 answer rate from the 417 Calendly events).
SELECT COUNT(*) AS interactions_with_hear_source
FROM interactions
WHERE venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND type = 'meeting'
  AND crm_source = 'generic_csv'
  AND extracted_identity ? 'hear_source';

-- 2) Distribution of hear_source values.
SELECT extracted_identity ->> 'hear_source' AS hear_source,
       COUNT(*) AS n
FROM interactions
WHERE venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND type = 'meeting'
  AND crm_source = 'generic_csv'
  AND extracted_identity ? 'hear_source'
GROUP BY 1
ORDER BY 2 DESC;

-- 3) Sample 5 rows.
SELECT id, timestamp, subject, extracted_identity ->> 'hear_source' AS hear_source
FROM interactions
WHERE venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND type = 'meeting'
  AND crm_source = 'generic_csv'
  AND extracted_identity ? 'hear_source'
ORDER BY timestamp DESC
LIMIT 5;

-- 4) Active weddings: NULL lead_source count (pre/post derivation).
SELECT COUNT(*) AS null_lead_source
FROM weddings
WHERE venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND merged_into_id IS NULL
  AND lead_source IS NULL;

-- 5) Active weddings: distribution by lead_source (the canonical
--    attribution column post-Stream-TT). After the WW backfill +
--    re-derive, expect The Knot / Google / Wedding Wire / Word of
--    Mouth to dominate.
SELECT COALESCE(lead_source, '(NULL)') AS lead_source,
       COUNT(*) AS n
FROM weddings
WHERE venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND merged_into_id IS NULL
GROUP BY 1
ORDER BY 2 DESC;

-- 6) Booked / completed weddings by lead_source.
SELECT COALESCE(lead_source, '(NULL)') AS lead_source,
       COUNT(*) AS bookings
FROM weddings
WHERE venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND merged_into_id IS NULL
  AND status IN ('booked', 'completed')
GROUP BY 1
ORDER BY 2 DESC;

-- 7) Audit trail — the latest derivation_log rows for migration_187
--    weddings should now show priority_used=2 (Q7 picked up).
SELECT priority_used, derived_source, COUNT(*) AS n
FROM lead_source_derivation_log
WHERE venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND decided_by = 'auto'
GROUP BY 1, 2
ORDER BY 1, 3 DESC;

-- 8) source_attribution rollup (post 43-ww-refresh-attribution.ts).
--    Should now reflect the new lead_source distribution since the
--    rollup reads lead_source first (T5-Rixey-WW patch).
SELECT period_start, source, inquiries, tours, bookings, revenue, roi
FROM source_attribution
WHERE venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
ORDER BY period_start, revenue DESC;
