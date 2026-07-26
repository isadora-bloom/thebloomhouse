-- 387: public wedding-site password protection
--
-- Rixey lets a couple put a shared password on their public wedding website so
-- only invited guests can view it. Bloom had no equivalent. Store the password
-- on the settings row; the public read endpoint gates content on it.
--
-- Stored as plaintext deliberately: this is a low-stakes shared word the couple
-- hands out to guests (like a party door code), not an account credential, and
-- the couple needs to see/share the exact value in their builder. It is only
-- ever compared server-side and never returned to unauthenticated callers.

ALTER TABLE wedding_website_settings
  ADD COLUMN IF NOT EXISTS site_password text;

COMMENT ON COLUMN wedding_website_settings.site_password IS
  'Optional shared password gating the public site. NULL/empty = open. Plaintext shared code, not a credential; compared server-side only, never sent to unauthenticated clients.';
