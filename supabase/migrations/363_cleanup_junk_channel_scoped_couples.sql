-- ---------------------------------------------------------------------------
-- 363_cleanup_junk_channel_scoped_couples.sql
-- ---------------------------------------------------------------------------
-- One-time cleanup of low-quality channel-scoped couples the Tracer
-- minted before the mint gate (hasSufficientIdentity) was tightened.
--
-- Background
-- ----------
-- The pre-fix mint path treated a bare phone, or a bare email, as
-- enough identity to BE a couple. The result: rows whose
-- primary_contact_name is literally a phone number ("5713456253") or
-- the email address itself ("mstocks@rolva.org") — the display-name
-- fallback firing because there was no real name. These are not
-- couples an operator can act on.
--
-- This deletes exactly those: channel-scoped couples whose name is
-- the email address, or is phone-shaped. It is deliberately precise —
-- it does NOT touch:
--   * any couple with a real name (a named vendor mis-minted as a
--     couple keeps its row; it is hidden by the couples-list lifecycle
--     filter instead, and the author classifier is the real fix);
--   * Knot / channel-scoped couples with a proper "First L." name;
--   * resolved / booked couples (source_wedding_id-backed).
--
-- touchpoints.couple_id is ON DELETE SET NULL, so a deleted couple's
-- touchpoints survive as orphans (aggregate-only) — no signal is lost.
-- Idempotent: a re-run finds nothing once the rows are gone.
-- ---------------------------------------------------------------------------

DELETE FROM public.couples
WHERE lifecycle_state = 'channel_scoped'
  AND source_wedding_id IS NULL
  AND (
    -- name fell back to the email address
    (primary_contact_email IS NOT NULL
       AND lower(btrim(primary_contact_name)) = lower(btrim(primary_contact_email)))
    -- or name fell back to a raw phone number (digits / spaces / + ( ) -)
    OR primary_contact_name ~ '^[0-9 +()\-]{7,}$'
  );

NOTIFY pgrst, 'reload schema';
