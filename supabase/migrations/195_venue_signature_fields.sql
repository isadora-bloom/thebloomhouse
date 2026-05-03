-- ============================================================================
-- Migration 195 (T5-Rixey-FFF): venue-templated signature fields.
-- ============================================================================
--
-- Bug 4 root cause: outbound drafts were closing with strings like
--
--   Warmly,
--   Sage 🌿
--   Digital Concierge to Isadora Martin-Dye
--   Rixey Manor
--   A Historic Virginia Wedding Venue for Modern Love
--   www.rixeymanor.com | 540-212-4545
--   And yes, you can text
--
-- The AI name leak ("Sage") was the obvious problem and has been
-- patched separately (migration 162 backfilled ai_name = "<venue>
-- Concierge"). But the rest of the block is just as venue-specific
-- and was being IMPROVISED by the model from the personality prompt
-- context (owner_name, venue_name, coordinator_phone). That works for
-- Rixey — the values look right because the AI inferred them from
-- correct surrounding context — but for any other venue the model
-- either invents a tagline or omits it inconsistently across drafts.
--
-- Five new fields make the signature deterministic per venue:
--
--   ai_role_title         — full role label as it should read on the
--                            second line of the sign-off block. Free
--                            text so a venue can pick the formal
--                            "AI Concierge to Isadora Martin-Dye" or
--                            the casual "Concierge bot for Hawthorne".
--                            Universal-rules already requires the AI
--                            disclosure to live in ai_role (CHECK-
--                            constrained on venue_ai_config.ai_role,
--                            migration 059); ai_role_title is the
--                            longer customer-facing rendition.
--
--   signature_tagline     — single-line venue tagline shown under the
--                            venue name. Distinct from
--                            venue_config.portal_tagline which is the
--                            COUPLE-portal tagline ("Your dream
--                            wedding starts here"); this one is the
--                            external-facing tagline ("A Historic
--                            Virginia Wedding Venue for Modern Love").
--
--   signature_website     — URL or domain string ("www.rixeymanor.com").
--                            We do not derive this from venues.slug
--                            because the marketing domain often
--                            differs (rixeymanor.com vs the_app_slug).
--
--   signature_phone       — phone number string. Falls back to
--                            venue_config.coordinator_phone in code if
--                            null, but explicit override here lets a
--                            venue use a marketing line in outbound
--                            email and a different ops line for
--                            coordinator-personal communication.
--
--   signature_text_capable — boolean. When true, the sign-off block
--                            appends "And yes, you can text" as a
--                            final line. Defaults false because not
--                            every venue's number is text-capable.
--
-- Backfill: Rixey gets its current production values populated so the
-- visible draft signature in production stays identical after the
-- prompt-templating change. Other venues land NULL / false and their
-- sign-off block degrades gracefully (skips missing lines) until they
-- visit /settings/personality and fill them in.
--
-- Idempotent: each ALTER guards on column existence; backfill UPDATE
-- targets only rows where the field is currently NULL so re-running
-- the migration cannot stomp coordinator edits.
-- ============================================================================

ALTER TABLE public.venue_ai_config
  ADD COLUMN IF NOT EXISTS ai_role_title          text,
  ADD COLUMN IF NOT EXISTS signature_tagline      text,
  ADD COLUMN IF NOT EXISTS signature_website      text,
  ADD COLUMN IF NOT EXISTS signature_phone        text,
  ADD COLUMN IF NOT EXISTS signature_text_capable boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venue_ai_config.ai_role_title IS
  'Customer-facing role label rendered on the second line of the outbound sign-off block. Free-text but should contain "AI" to honour universal-rules disclosure. Example: "AI Concierge to Isadora Martin-Dye". Distinct from ai_role (CHECK-constrained one of "AI assistant"/"AI concierge"/etc, migration 059) which drives the in-prompt persona.';

COMMENT ON COLUMN public.venue_ai_config.signature_tagline IS
  'Single-line venue tagline shown directly under the venue name in outbound sign-offs. Externally-facing — distinct from venue_config.portal_tagline which is the couple-portal login tagline. Example: "A Historic Virginia Wedding Venue for Modern Love".';

COMMENT ON COLUMN public.venue_ai_config.signature_website IS
  'Marketing URL displayed in the sign-off contact line. Not derived from venues.slug because the marketing domain typically differs from the application slug. Display-only string; not parsed.';

COMMENT ON COLUMN public.venue_ai_config.signature_phone IS
  'Phone number displayed in the sign-off contact line. Falls back to venue_config.coordinator_phone when null so legacy venues without this override still render a phone line.';

COMMENT ON COLUMN public.venue_ai_config.signature_text_capable IS
  'When true, the outbound sign-off block appends "And yes, you can text" as a final line. Default false because not every venue phone number can receive SMS.';

-- ----------------------------------------------------------------------------
-- Backfill known Rixey values so production drafts stay identical post-cut.
-- ----------------------------------------------------------------------------
-- Rixey venue id is a stable UUID (see scripts/rixey-load/02-venue-config.mjs).
-- Update via the venues.slug = 'rixey' join so the migration is portable
-- across environments without hard-coding the UUID.

UPDATE public.venue_ai_config c
   SET ai_role_title          = COALESCE(c.ai_role_title,          'AI Concierge to Isadora Martin-Dye'),
       signature_tagline      = COALESCE(c.signature_tagline,      'A Historic Virginia Wedding Venue for Modern Love'),
       signature_website      = COALESCE(c.signature_website,      'www.rixeymanor.com'),
       signature_phone        = COALESCE(c.signature_phone,        '540-212-4545'),
       signature_text_capable = COALESCE(c.signature_text_capable, true),
       updated_at             = NOW()
  FROM public.venues v
 WHERE c.venue_id = v.id
   AND v.slug IN ('rixey', 'rixey-manor', 'rixeymanor');

-- ----------------------------------------------------------------------------
-- Sanity log: how many venues remain without a signature_tagline. Not an
-- error — most demo venues will be empty and that is fine; the sign-off
-- builder skips missing lines gracefully. The notice surfaces during
-- migration runs so an operator can decide whether to backfill more.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  empty_count integer;
BEGIN
  SELECT COUNT(*)
    INTO empty_count
    FROM public.venue_ai_config c
    JOIN public.venues v ON v.id = c.venue_id
   WHERE v.is_demo IS NOT TRUE
     AND (c.signature_tagline IS NULL OR trim(c.signature_tagline) = '');

  IF empty_count > 0 THEN
    RAISE NOTICE
      '[195] % non-demo venue(s) have no signature_tagline. Sign-off block will skip the tagline line until they fill it in via /settings/personality.',
      empty_count;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
