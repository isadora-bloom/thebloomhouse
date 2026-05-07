-- ============================================================================
-- 222: OWNER PRESENCE (note to couples + photo)
--
-- Tier-B audit #50 (Owner presence in app) + #51 (Note-from-owner surface).
-- Couples have been telling us they feel "outsourced to a chatbot" because
-- the only entity they interact with daily is Sage. Showing a real owner
-- (name, photo, a short personal note) restores the feeling that there's
-- a human on the other side of the venue.
--
-- Two columns on venue_config (couple-facing copy lives here, parallel to
-- portal_tagline; venue_ai_config is reserved for AI persona settings):
--
--   owner_note_to_couples: free text. Renders as a card on the couple
--                          dashboard "A note from {owner_name}". Short
--                          multi-paragraph welcome / what-to-expect /
--                          personal touch. Safe to read across the whole
--                          portal so couples can copy/paste or forward.
--
--   owner_photo_url:       public URL to a photo of the venue owner.
--                          Square or near-square recommended. Optional
--                          (card renders without the photo when null).
--
-- The owner's NAME already lives at venue_ai_config.owner_name (it's used
-- by the AI persona builder), so this migration doesn't duplicate it.
-- The dashboard card reads owner_name from venue_ai_config and the note
-- + photo from venue_config.
-- ============================================================================

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS owner_note_to_couples text,
  ADD COLUMN IF NOT EXISTS owner_photo_url text;

COMMENT ON COLUMN public.venue_config.owner_note_to_couples IS
  'Couple-facing welcome note from the venue owner. Rendered on the couple dashboard as a card titled "A note from {owner_name}". Free-form multi-paragraph text. Safe across the whole portal; couples may copy/forward.';

COMMENT ON COLUMN public.venue_config.owner_photo_url IS
  'Public URL to a photo of the venue owner. Rendered on the couple dashboard owner-note card. Square / near-square recommended. Optional; the card renders text-only when null.';

NOTIFY pgrst, 'reload schema';
