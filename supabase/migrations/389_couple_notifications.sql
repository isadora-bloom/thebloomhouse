-- 389: couple-facing notifications
--
-- Rixey gave couples a notification bell (new messages, planning reminders) with
-- unread state. Bloom couples had nothing — they only learned of a venue reply by
-- opening the messages section. This wedding-scoped feed backs a bell in the
-- couple top bar. Producers call createCoupleNotification (lib/services).

CREATE TABLE IF NOT EXISTS couple_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_couple_notifications_wedding
  ON couple_notifications (wedding_id, read, created_at DESC);

COMMENT ON TABLE couple_notifications IS
  'Couple-facing notification feed (per wedding). Backs the bell in the couple top bar. type e.g. new_message / planning_reminder; link is a relative couple-portal path.';
