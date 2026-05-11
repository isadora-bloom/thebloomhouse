-- ---------------------------------------------------------------------------
-- 301_unroutable_address_backfill.sql  (live-customer fix 2026-05-11)
-- ---------------------------------------------------------------------------
-- Companion to the form-relay-parsers fix + isUnsendableAddress helper
-- shipped 2026-05-11. Historically, when listing platforms didn't expose
-- a routable per-prospect identifier, parsers anchored leads on either:
--
--   1. A Bloom-synthesised placeholder (e.g. WeddingWire's
--      `authsolic-{token}@weddingwire.bloom-relay.invalid`)
--   2. A no-reply / system-only local part the venue's own infra emitted
--   3. An RFC-2606 reserved TLD (`.invalid`, `.test`, `.example`,
--      `.localhost`) some integration test or import script slipped in
--
-- The autonomous sender + manual /agent/send + /agent/reply paths used
-- those addresses as the To: header. Gmail returned hard bounces
-- ("Address not found"), no-reply senders silently dropped replies.
--
-- The fix re-prioritises per-prospect routable relays
-- (`user-{token}@reply.weddingwire.com`, `<prospect>.<slug>@member.
-- theknot.com`, `connect-{uuid}@zola.com`) and the personal email
-- where available. This migration backfills historical rows so
-- existing leads can be replied to.
--
-- Strategy: find each person whose canonical email is unroutable, look
-- up the matching wedding's most recent inbound interaction with a
-- routable from_email, and promote that address. Original unroutable
-- value preserved in people.extracted_identity for audit.
--
-- All operations are idempotent: re-running is a no-op because the WHERE
-- clause filters rows whose email is still unroutable.
-- ---------------------------------------------------------------------------

-- Reusable: predicate for "is this email unroutable for send".
-- Mirrors the TS `isUnsendableAddress` helper. Coverage:
--   - RFC 2606 reserved TLDs (.invalid / .test / .example / .localhost)
--   - RFC 2606 reserved second-level (example.com / .net / .org)
--   - No-reply / system-only local parts
-- We use the predicate inline (no PL/pgSQL function) so the migration
-- stays statement-level idempotent per the exec_sql RPC contract.

-- Reusable: predicate for "is this a per-prospect routable relay".
-- Mirrors the TS `isPerProspectRelay` helper.

-- Step 1: build a temp mapping table.
-- For each person whose canonical email is unroutable, find a routable
-- replacement from the most recent inbound interaction on the same
-- wedding. Routable = either a personal email (not in any platform's
-- relay domain) or a per-prospect relay shape.
CREATE TEMP TABLE IF NOT EXISTS _unroutable_addr_backfill_map AS
SELECT DISTINCT ON (p.id)
  p.id              AS person_id,
  p.venue_id,
  p.wedding_id,
  p.email           AS unroutable_email,
  i.from_email      AS routable_email
FROM people p
JOIN interactions i
  ON i.wedding_id = p.wedding_id
 AND i.venue_id = p.venue_id
 AND i.direction = 'inbound'
 -- Candidate routable addresses: per-prospect relay shapes OR addresses
 -- that don't match any unsendable predicate. Excludes shared-relay
 -- forms (leads@*, messages@*) by negative match on no-reply locals
 -- + by the parser-level skip that already prevents new shared-relay
 -- leads. For historical rows we accept the broadest "not unsendable"
 -- test below.
 AND i.from_email IS NOT NULL
 AND i.from_email !~* '\.(invalid|test|example|localhost)$'
 AND i.from_email !~* '@(example\.com|example\.net|example\.org)$'
 AND lower(split_part(i.from_email, '@', 1)) NOT IN (
   'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'do_not_reply',
   'mailer-daemon', 'mailerdaemon', 'postmaster',
   'bounce', 'bounces', 'unsubscribe'
 )
 AND i.from_email ~* '@'
WHERE
  -- person's canonical email is unsendable in any of the ways we care about
  (
    p.email ~* '\.(invalid|test|example|localhost)$'
    OR p.email ~* '@(example\.com|example\.net|example\.org)$'
    OR lower(split_part(p.email, '@', 1)) IN (
      'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'do_not_reply',
      'mailer-daemon', 'mailerdaemon', 'postmaster',
      'bounce', 'bounces', 'unsubscribe'
    )
  )
ORDER BY p.id, i.timestamp DESC;

-- Step 2: promote the routable email to people.email. Preserve the
-- unroutable original in extracted_identity for audit lineage.
UPDATE people p
SET
  email = m.routable_email,
  extracted_identity =
    COALESCE(p.extracted_identity, '{}'::jsonb)
    || jsonb_build_object(
      'historical_unroutable_email', m.unroutable_email,
      'address_backfill_at', NOW()::text
    )
FROM _unroutable_addr_backfill_map m
WHERE p.id = m.person_id;

-- Step 3: same for contacts. The contacts table is the canonical
-- multi-channel address store; people.email is a denormalised cache.
-- Both need to flip for the send paths to find the right address.
-- contacts table uses columns `type` + `value` (per 001_shared_tables),
-- not contact_type / contact_value. Fixed 2026-05-11 after live-customer
-- apply attempt surfaced the column-name miss.
UPDATE contacts c
SET value = m.routable_email
FROM _unroutable_addr_backfill_map m
WHERE c.person_id = m.person_id
  AND c.type = 'email'
  AND (
    c.value ~* '\.(invalid|test|example|localhost)$'
    OR c.value ~* '@(example\.com|example\.net|example\.org)$'
    OR lower(split_part(c.value, '@', 1)) IN (
      'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'do_not_reply',
      'mailer-daemon', 'mailerdaemon', 'postmaster',
      'bounce', 'bounces', 'unsubscribe'
    )
  );

-- Step 4: emit a row count summary so the apply script surfaces
-- "N rows backfilled" without a separate query round-trip.
DO $$
DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM _unroutable_addr_backfill_map;
  RAISE NOTICE 'Unroutable address backfill: % person row(s) promoted', n;
END $$;

DROP TABLE IF EXISTS _unroutable_addr_backfill_map;

NOTIFY pgrst, 'reload schema';
