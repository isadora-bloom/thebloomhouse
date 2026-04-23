-- ---------------------------------------------------------------------------
-- 075_client_file_fields.sql
-- ---------------------------------------------------------------------------
-- Phase 2 Task 16: round out the client file data structure.
--
-- Audit 2026-04-22 found these gaps against the Task 16 spec:
--   * weddings.requested_date  — the date the couple ASKED about, distinct
--     from wedding_date (the actual booked/planned day). Rule:
--     requested_date NEVER affects availability, matching the four-date
--     classification rule. wedding_date is the booked day; requested_date
--     is pipeline context.
--   * weddings.friction_tags   — coordinator-set jsonb array of strings
--     capturing "this couple was difficult about X". Feeds Phase 4 Task 43
--     (problem-couple early warning). Kept as free-form array rather than
--     enum so venues can coin their own vocabulary.
--   * weddings.referred_by     — free-text name/email of the referrer.
--     source already tracks the platform; this tracks the person.
--   * tours.attendees          — jsonb array of attendee types (couple,
--     parents, planner, friends). Feeds Phase 4 Task 41 tour-attendee
--     intelligence.
--   * tours.transcript         — text placeholder for Omi integration in
--     Phase 7. Not populated today; schema ready so uploads land cleanly.
--
-- Multi-venue: every column is on a venue-scoped table. No cross-venue
-- leakage possible.
-- ---------------------------------------------------------------------------

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS requested_date date,
  ADD COLUMN IF NOT EXISTS friction_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS referred_by text;

COMMENT ON COLUMN public.weddings.requested_date IS
  'The date the couple asked about in their inquiry. Distinct from wedding_date (actual booked day). Must never be used to mark availability — Phase 1 date-classification rule.';

COMMENT ON COLUMN public.weddings.friction_tags IS
  'Coordinator-set array of free-text tags capturing friction/difficulty signals ("slow to reply", "combative", "scope creep"). Feeds Phase 4 problem-couple early warning. Shape: ["tag1", "tag2"].';

COMMENT ON COLUMN public.weddings.referred_by IS
  'Free-text name or email of the person who referred this couple. The `source` column tracks the platform; this tracks the individual referrer.';

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS transcript text;

COMMENT ON COLUMN public.tours.attendees IS
  'Array of attendee role tokens from: couple, partner1, partner2, parents, friends, planner, wedding_party, other. Phase 4 Task 41 computes booking rates per attendee combination.';

COMMENT ON COLUMN public.tours.transcript IS
  'Tour transcript text (future Omi integration — Phase 7). Populated by the transcript upload flow once Omi Dev Kit 2 is wired; unused in Phase 2.';

-- GIN indexes for the jsonb arrays so querying "any wedding with friction
-- tag X" and "tours where attendees included parents" stays fast as data
-- grows.
CREATE INDEX IF NOT EXISTS idx_weddings_friction_tags
  ON public.weddings USING GIN (friction_tags);

CREATE INDEX IF NOT EXISTS idx_tours_attendees
  ON public.tours USING GIN (attendees);

-- requested_date queries (e.g. "what dates have been asked about but not
-- booked this quarter") benefit from a plain B-tree.
CREATE INDEX IF NOT EXISTS idx_weddings_requested_date
  ON public.weddings (venue_id, requested_date)
  WHERE requested_date IS NOT NULL;

NOTIFY pgrst, 'reload schema';
