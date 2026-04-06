-- ============================================
-- 019: GUEST DATA FIXES
-- Fix column naming, add missing plus-one fields,
-- link allergies to guests, add RSVP configuration
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. Add missing plus-one columns to guest_list
-- ---------------------------------------------------------------------------
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS plus_one_rsvp text,
  ADD COLUMN IF NOT EXISTS plus_one_meal_choice text,
  ADD COLUMN IF NOT EXISTS plus_one_dietary text;

-- Add meal_choice as alias/replacement for meal_preference
-- (keep meal_preference for backward compat, add meal_choice)
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS meal_choice text;

-- Add has_plus_one as alias for plus_one boolean
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS has_plus_one boolean DEFAULT false;

-- Add phone and email directly on guest_list (not just on people table)
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text;

-- Add accommodation tracking per guest
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS accommodation text;

-- ---------------------------------------------------------------------------
-- 2. Link allergy_registry to guest_list
-- ---------------------------------------------------------------------------
ALTER TABLE allergy_registry
  ADD COLUMN IF NOT EXISTS guest_id uuid REFERENCES guest_list(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_allergy_registry_guest ON allergy_registry(guest_id);

-- ---------------------------------------------------------------------------
-- 3. RSVP Configuration — what fields to ask on public RSVP form
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rsvp_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),

  -- Which fields to show on public RSVP
  ask_meal_choice boolean DEFAULT true,
  ask_dietary boolean DEFAULT true,
  ask_allergies boolean DEFAULT false,
  ask_phone boolean DEFAULT false,
  ask_email boolean DEFAULT false,
  ask_address boolean DEFAULT false,
  ask_hotel boolean DEFAULT false,
  ask_shuttle boolean DEFAULT false,
  ask_accessibility boolean DEFAULT false,
  ask_song_request boolean DEFAULT false,
  ask_message boolean DEFAULT false,

  -- Allow "maybe" as RSVP option
  allow_maybe boolean DEFAULT false,

  -- Custom questions (JSONB array of {label, type: 'text'|'select'|'boolean', options?: string[]})
  custom_questions jsonb DEFAULT '[]',

  -- RSVP deadline
  rsvp_deadline date,

  -- Confirmation messages
  attending_message text DEFAULT 'Thank you for confirming! We can''t wait to celebrate with you.',
  declined_message text DEFAULT 'We''ll miss you! Thank you for letting us know.',

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);

-- ---------------------------------------------------------------------------
-- 4. Guest RSVP responses — stores answers to custom/optional questions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rsvp_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  guest_id uuid NOT NULL REFERENCES guest_list(id) ON DELETE CASCADE,

  -- Standard optional fields
  phone text,
  email text,
  address text,
  hotel_name text,
  shuttle_needed boolean,
  accessibility_needs text,
  song_request text,
  message_to_couple text,
  allergies text,

  -- Custom question answers (JSONB: {question_label: answer})
  custom_answers jsonb DEFAULT '{}',

  responded_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rsvp_responses_guest ON rsvp_responses(guest_id);
CREATE INDEX IF NOT EXISTS idx_rsvp_responses_wedding ON rsvp_responses(venue_id, wedding_id);

-- ---------------------------------------------------------------------------
-- 5. Per-guest care flags (lightweight, queryable by other pages)
-- ---------------------------------------------------------------------------
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS needs_accessibility boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS accessibility_notes text,
  ADD COLUMN IF NOT EXISTS staying_overnight boolean,
  ADD COLUMN IF NOT EXISTS needs_shuttle boolean DEFAULT false;
