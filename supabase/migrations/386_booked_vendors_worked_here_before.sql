-- 386: restore Rixey's "worked here before?" vendor flag
--
-- arrival_time / departure_time / instagram already exist (migration 032). The
-- couple vendors page stopped exposing all four; this adds the one missing
-- column so the page can capture the full day-of logistics set again.
--
-- Nullable tri-state: true = worked at this venue before, null = unknown/unasked.

ALTER TABLE booked_vendors
  ADD COLUMN IF NOT EXISTS worked_here_before boolean;

COMMENT ON COLUMN booked_vendors.worked_here_before IS
  'Has this vendor worked at the venue before? true / null (unknown). Surfaced day-of so staff know who needs orienting.';
