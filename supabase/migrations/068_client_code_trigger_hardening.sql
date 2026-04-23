-- ============================================================================
-- Migration 068: Harden auto_generate_client_code()
-- ============================================================================
--
-- CONTEXT
-- Migration 032 installed an AFTER INSERT trigger on weddings that generates
-- a client_code per new wedding. It has three problems that hurt real
-- venues onboarded outside the demo seed:
--
--   1. If venue_config.venue_prefix IS NULL the trigger RETURN NEWs and
--      silently skips. The setup page (src/app/(platform)/setup/page.tsx)
--      never writes venue_prefix, so every non-demo venue starts with no
--      prefix — coordinators see an empty /agent/codes page forever.
--
--   2. The MAX(seq)+1 + INSERT pattern is not atomic across concurrent
--      wedding inserts for the same venue. Two simultaneous inserts can
--      compute the same next seq; the second trips the unique index
--      idx_client_codes_venue_code, and because the code insert happens
--      inside an AFTER INSERT trigger, that rolls back the wedding itself.
--
--   3. Any exception in the trigger aborts the wedding insert. Code
--      generation should be best-effort, not load-bearing. A new couple
--      must land even if the code helper trips.
--
-- This migration:
--   - Derives venue_prefix from the venue name on the fly (initials,
--     uppercase, fallback to first 2 letters) when NULL, and persists it
--     back to venue_config so coordinators and later edits can see it.
--   - Acquires a row lock on the venue_config row (SELECT ... FOR UPDATE)
--     to serialize code generation per venue and close the seq race.
--   - Wraps the INSERT in an EXCEPTION handler so the wedding insert is
--     never rolled back by a code-generation failure.
-- ============================================================================

CREATE OR REPLACE FUNCTION auto_generate_client_code()
RETURNS TRIGGER AS $$
DECLARE
  v_prefix text;
  v_next_seq int;
  v_code text;
  v_venue_name text;
  v_words text[];
  v_first_initial text;
  v_last_initial text;
BEGIN
  -- Lock the venue_config row for this venue so concurrent wedding
  -- inserts serialize here and can't race on next_seq.
  SELECT venue_prefix INTO v_prefix
  FROM venue_config
  WHERE venue_id = NEW.venue_id
  FOR UPDATE;

  -- Derive a prefix from the venue name if missing. Prefer initials of
  -- the first and last significant word, uppercased. Fall back to the
  -- first two letters of the name. Persist the derived value so the
  -- coordinator can see and edit it later.
  IF v_prefix IS NULL THEN
    SELECT name INTO v_venue_name FROM venues WHERE id = NEW.venue_id;

    IF v_venue_name IS NOT NULL THEN
      -- Strip punctuation, split on whitespace, drop empties.
      v_words := regexp_split_to_array(
        regexp_replace(trim(v_venue_name), '[^A-Za-z0-9 ]', '', 'g'),
        '\s+'
      );

      IF array_length(v_words, 1) >= 2 THEN
        v_first_initial := upper(substring(v_words[1] FROM 1 FOR 1));
        v_last_initial  := upper(substring(v_words[array_length(v_words, 1)] FROM 1 FOR 1));
        v_prefix := v_first_initial || v_last_initial;
      ELSIF array_length(v_words, 1) = 1 AND length(v_words[1]) >= 2 THEN
        v_prefix := upper(substring(v_words[1] FROM 1 FOR 2));
      ELSIF array_length(v_words, 1) = 1 AND length(v_words[1]) = 1 THEN
        v_prefix := upper(v_words[1]) || 'X';
      END IF;
    END IF;

    -- Last-resort fallback: generic prefix. Better than silent skip.
    IF v_prefix IS NULL OR length(v_prefix) < 2 THEN
      v_prefix := 'VN';
    END IF;

    -- Persist so this only happens once per venue.
    UPDATE venue_config
      SET venue_prefix = v_prefix
      WHERE venue_id = NEW.venue_id;
  END IF;

  -- Best-effort code insert. If anything goes wrong (unique collision
  -- from historical bad data, type error, etc.), swallow it — the
  -- wedding row itself must still land.
  BEGIN
    SELECT COALESCE(MAX(SUBSTRING(code FROM '[0-9]+$')::int), 0) + 1
      INTO v_next_seq
    FROM client_codes
    WHERE venue_id = NEW.venue_id;

    v_code := v_prefix || '-' || LPAD(v_next_seq::text, 4, '0');

    INSERT INTO client_codes (id, venue_id, wedding_id, code, created_at)
    VALUES (gen_random_uuid(), NEW.venue_id, NEW.id, v_code, NOW());
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auto_generate_client_code: code insert failed for wedding % venue %: %',
      NEW.id, NEW.venue_id, SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger itself is unchanged — keep the same AFTER INSERT binding from
-- migration 032. Re-declaring would drop/recreate needlessly.
