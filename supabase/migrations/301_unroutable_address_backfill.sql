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
-- 2026-05-11 design rewrite: TEMP tables don't persist between separate
-- SQL-editor statements (each runs in its own session). The two UPDATE
-- statements below each rebuild the same per-person mapping inline as
-- a CTE so nothing depends on session-scoped state.
--
-- All operations are idempotent: re-running on already-promoted rows
-- is a no-op because the WHERE clauses filter to rows whose canonical
-- email is still unroutable.
-- ---------------------------------------------------------------------------

-- Step 1: promote the routable email to people.email. CTE builds the
-- (person_id -> routable_from_email) map inline from the most recent
-- inbound interaction on the same wedding whose from_email passes the
-- "not unsendable" filter (real TLD + not a no-reply local part).
UPDATE people p
SET email = m.routable_email
FROM (
  SELECT DISTINCT ON (p2.id)
    p2.id              AS person_id,
    i.from_email       AS routable_email
  FROM people p2
  JOIN interactions i
    ON i.wedding_id = p2.wedding_id
   AND i.venue_id = p2.venue_id
   AND i.direction = 'inbound'
   AND i.from_email IS NOT NULL
   AND i.from_email ~* '@'
   AND i.from_email !~* '\.(invalid|test|example|localhost)$'
   AND i.from_email !~* '@(example\.com|example\.net|example\.org)$'
   AND lower(split_part(i.from_email, '@', 1)) NOT IN (
     'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'do_not_reply',
     'mailer-daemon', 'mailerdaemon', 'postmaster',
     'bounce', 'bounces', 'unsubscribe'
   )
  WHERE
    p2.email IS NOT NULL
    AND (
      p2.email ~* '\.(invalid|test|example|localhost)$'
      OR p2.email ~* '@(example\.com|example\.net|example\.org)$'
      OR lower(split_part(p2.email, '@', 1)) IN (
        'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'do_not_reply',
        'mailer-daemon', 'mailerdaemon', 'postmaster',
        'bounce', 'bounces', 'unsubscribe'
      )
    )
  ORDER BY p2.id, i.timestamp DESC
) m
WHERE p.id = m.person_id;

-- Step 2: same promotion for contacts. Same inline CTE shape so the
-- two UPDATEs are independent / can run in any order / each is safe to
-- re-run on its own.
UPDATE contacts c
SET value = m.routable_email
FROM (
  SELECT DISTINCT ON (p2.id)
    p2.id              AS person_id,
    i.from_email       AS routable_email
  FROM people p2
  JOIN interactions i
    ON i.wedding_id = p2.wedding_id
   AND i.venue_id = p2.venue_id
   AND i.direction = 'inbound'
   AND i.from_email IS NOT NULL
   AND i.from_email ~* '@'
   AND i.from_email !~* '\.(invalid|test|example|localhost)$'
   AND i.from_email !~* '@(example\.com|example\.net|example\.org)$'
   AND lower(split_part(i.from_email, '@', 1)) NOT IN (
     'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'do_not_reply',
     'mailer-daemon', 'mailerdaemon', 'postmaster',
     'bounce', 'bounces', 'unsubscribe'
   )
  ORDER BY p2.id, i.timestamp DESC
) m
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

NOTIFY pgrst, 'reload schema';
