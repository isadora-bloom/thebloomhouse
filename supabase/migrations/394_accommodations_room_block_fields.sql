-- 394: accommodations room-block + contact fields
--
-- W11 schema-truth fix (2026-09-08). The public wedding website
-- (/w/[slug], AccommodationsSection) has had a fully-built UI for
-- hotel phone numbers, price range, room-block codes/deadlines and
-- notes since it shipped — src/app/w/[slug]/page.tsx's Accommodation
-- interface has always carried them. The accommodations table never
-- got the columns, so the public wedding-website API selected them
-- anyway, 400'd, and took the ENTIRE website payload down with it
-- (timeline, weddings, rsvp_config included, since they were fetched
-- in the same Promise.all). src/app/api/public/wedding-website/route.ts
-- was patched to select only the real columns and return these fields
-- as null pending this migration; once applied, wire the select back
-- up (drop the explicit null overrides) and add matching admin-side
-- edit fields to whatever owns accommodations settings so venues can
-- fill them in.

ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS price_range text;
ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS block_code text;
ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS block_deadline date;
ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS notes text;
