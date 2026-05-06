-- ============================================
-- 218_wedding_website_share_token.sql
-- ============================================
--
-- Closes the guest-list enumeration oracle on /api/public/wedding-website.
-- Per 2026-05-06 audit Lens 8:
--
-- > "wedding_website public endpoint reads guest_list joined on people
-- >  and exposes first_name + last_name to any unauthenticated caller
-- >  who knows a venue's slug. The 'guest search' returns names by a
-- >  2-char prefix match. That's a guest-list enumeration oracle keyed
-- >  on a public slug."
--
-- Threat model: slugs are user-chosen and often predictable (e.g.
-- "smith-2027"). Anyone can scrape every wedding website's full guest
-- list with a small Python script.
--
-- Fix: split the public surface into two tiers.
--   - Tier 1 (public): rendering the wedding website HTML (sections,
--     theme, FAQ, registry, etc.). Slug-only, no token. This is meant
--     to be public — couples share the URL openly.
--   - Tier 2 (token-gated): guest search and RSVP submission. Requires
--     a share_token the couple's invitation links carry. Without the
--     token, the route returns 404 — no enumeration possible.
--
-- Schema:
--   share_token text — 32-char random hex (16 bytes). UNIQUE.
--   share_token_issued_at timestamptz — when issued.
--
-- Backfill: every existing row gets a fresh token at apply time. Any
-- pre-launch share-links already in circulation break. Acceptable
-- given pre-launch state (no paying customers, one design-partner
-- venue per audit context).
-- ============================================

ALTER TABLE public.wedding_website_settings
  ADD COLUMN IF NOT EXISTS share_token text NULL,
  ADD COLUMN IF NOT EXISTS share_token_issued_at timestamptz NULL;

-- Backfill existing rows with fresh tokens. encode() with gen_random_bytes
-- gives 32 hex chars from 16 bytes (128 bits of entropy — well above
-- guess-resistance threshold).
UPDATE public.wedding_website_settings
SET share_token = encode(gen_random_bytes(16), 'hex'),
    share_token_issued_at = NOW()
WHERE share_token IS NULL;

-- Now require it. Future inserts must populate.
ALTER TABLE public.wedding_website_settings
  ALTER COLUMN share_token SET NOT NULL;

-- Unique index — share_token is the only thing tying a guest invitation
-- back to a wedding's website. Collision must be impossible.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wedding_website_settings_share_token
  ON public.wedding_website_settings(share_token);

COMMENT ON COLUMN public.wedding_website_settings.share_token IS
  '32-char hex (16-byte) random token for the guest-facing share-link. '
  'Required by /api/public/wedding-website?action=search_guest and ?action=rsvp. '
  'Public website rendering does NOT require it (slug-only). Per audit Lens 8.';

COMMENT ON COLUMN public.wedding_website_settings.share_token_issued_at IS
  'When the current share_token was issued. Future rotation flow stamps '
  'this for invalidation policy.';

NOTIFY pgrst, 'reload schema';
