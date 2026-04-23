-- ---------------------------------------------------------------------------
-- 069_seed_scheduling_tool_filters.sql
-- ---------------------------------------------------------------------------
-- Phase 1 v4 Task 3 fix: seed scheduling / booking-tool domains into
-- venue_email_filters so the reply-guard does not depend solely on the
-- `List-Unsubscribe` RFC header for tour-confirmation and booking-tool mail.
--
-- Why:
--   Today's guard chain (email-pipeline.ts > isMachineGenerated) catches
--   Calendly + HoneyBook because they send List-Unsubscribe in their
--   system mail. If either platform ever ships a variant without that
--   header, a Calendly "Your tour is confirmed" email would reach the
--   classifier and the `startTime` date could pollute wedding_date.
--   Belt-and-braces: seed their sender domains per venue.
--
-- Actions:
--   calendly.com           → ignore   (webhook is source of truth, email is noise)
--   acuityscheduling.com   → ignore   (same model as Calendly)
--   honeybook.com          → no_draft (booking tool may carry client signals)
--   dubsado.com            → no_draft (same rationale as HoneyBook)
--
-- Multi-venue: rows are seeded per venue so each coordinator can remove
-- any they legitimately want to hear from (a photography venue's own
-- HoneyBook invoices, for instance).
-- ---------------------------------------------------------------------------

INSERT INTO public.venue_email_filters (venue_id, pattern_type, pattern, action, source, note)
SELECT v.id, 'sender_domain', d.domain, d.action, 'manual', d.note
FROM public.venues v
CROSS JOIN (VALUES
  ('calendly.com',         'ignore',   'Calendly confirmation email — webhook is source of truth (seeded)'),
  ('acuityscheduling.com', 'ignore',   'Acuity Scheduling confirmation email (seeded)'),
  ('honeybook.com',        'no_draft', 'HoneyBook system mail — classify but do not draft (seeded)'),
  ('dubsado.com',          'no_draft', 'Dubsado system mail — classify but do not draft (seeded)')
) AS d(domain, action, note)
ON CONFLICT (venue_id, pattern_type, pattern) DO NOTHING;

NOTIFY pgrst, 'reload schema';
