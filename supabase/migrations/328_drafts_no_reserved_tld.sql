-- Migration 328 — refuse reserved-TLD addresses at the drafts insert
-- boundary.
--
-- Background: 2026-05-12, the Zack Hunter / WeddingWire trace surfaced
-- a class of bug where drafts get stamped with synthetic .invalid
-- placeholders (e.g. `authsolic-<token>@weddingwire.bloom-relay.invalid`).
-- The autonomous sender's `isUnsendableAddress` guard correctly refuses
-- to send those, but the drafts still surface in the inbox UI as
-- "Replying to authsolic-…invalid" forever. The application-side fix
-- (pipeline.ts plumbing `replyToEmail` through + skipping unsendable
-- drafts) is committed in bcec77c. This migration is the lockdown
-- layer: future writers cannot regress because the database itself
-- rejects the insert.
--
-- RFC 2606 reserves four TLDs for documentation / testing / never-
-- routable use: .invalid, .test, .example, .localhost. Mirror the
-- runtime check in `isUnsendableAddress` (body-extract.ts:149) as a
-- table-level CHECK so any bypass path fails LOUD instead of leaving
-- a permanent zombie draft.

ALTER TABLE drafts
  ADD CONSTRAINT drafts_to_email_no_reserved_tld
  CHECK (
    to_email IS NULL
    OR to_email !~* '\.(invalid|test|example|localhost)$'
  )
  NOT VALID;

-- NOT VALID skips the historical-row scan so this is safe to apply
-- against a live table with existing offenders. Newly inserted /
-- updated rows must satisfy the check. The pre-existing .invalid
-- drafts (Zack Hunter et al) stay in place and get cleaned up via
-- a follow-up sweep / coordinator action.
--
-- To clean up existing offenders in a backfill window, the operator
-- can run:
--   UPDATE drafts SET status = 'manual_via_platform'
--   WHERE to_email ~* '\.(invalid|test|example|localhost)$'
--     AND status = 'pending';
-- (or DELETE them outright if the inbox surfaces the inbound
-- separately, which it does — drafts.interaction_id remains).
