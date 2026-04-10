-- Add 'snoozed' as a valid status for the client deduplication queue.
-- Allows users to "Review later" a potential duplicate pair without
-- fully merging or dismissing it.

ALTER TABLE client_match_queue DROP CONSTRAINT IF EXISTS client_match_queue_status_check;
ALTER TABLE client_match_queue ADD CONSTRAINT client_match_queue_status_check
  CHECK (status IN ('pending', 'merged', 'dismissed', 'snoozed'));
