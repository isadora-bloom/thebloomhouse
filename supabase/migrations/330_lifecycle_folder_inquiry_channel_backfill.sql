-- 330_lifecycle_folder_inquiry_channel_backfill.sql
--
-- 2026-05-12 — Companion to migration 329 + the step-0 inquiry-channel
-- override added to decideLifecycleFolder() the same day.
--
-- Migration 329 fixed interactions.intent_class. The inbox UI reads from
-- the SEPARATE lifecycle_folder column. Two live cases caught the gap:
--   - Keeley Tate (Knot intake) → lifecycle_folder = 'vendor'
--   - Hassan Abidi (Calendly tour) → lifecycle_folder = 'vendor'
-- Both should be in 'new_inquiry' (Knot) / 'potential_client' (Calendly
-- if a tour event exists) / 'client' (if booked).
--
-- Root cause: form-relay + scheduling senders had no channel-level
-- short-circuit in the rule chain. Either people.role was stamped
-- 'vendor' upstream, or the Haiku folder-AI returned 'vendor' from
-- body vocabulary ("amazing tour planned for you" / "Interested
-- Services: Tables and chairs, Linens...").
--
-- This migration repairs every thread where ANY interaction lands on a
-- form-relay or scheduling-tool from_email AND the thread's folder is
-- NOT already a legitimate inquiry-stage value. The whole thread is
-- updated together — every interaction with the same gmail_thread_id
-- carries the same folder, per the rule encoded in
-- updateThreadLifecycleFolder.
--
-- Statement-level idempotent (no BEGIN/COMMIT — exec_sql rejects those;
-- see feedback_migration_no_transaction_wrapper).

-- ---------------------------------------------------------------------------
-- Affected threads: gmail_thread_id values where at least one inbound
-- came from a form-relay / scheduling-tool sender AND the current
-- lifecycle_folder is misclassified.
-- ---------------------------------------------------------------------------

WITH affected_threads AS (
  SELECT DISTINCT i.venue_id, i.gmail_thread_id
  FROM public.interactions i
  WHERE i.gmail_thread_id IS NOT NULL
    AND i.from_email IS NOT NULL
    AND (
      i.from_email ILIKE '%@theknot.com'
      OR i.from_email ILIKE '%@knotemail.com'
      OR i.from_email ILIKE '%@member.theknot.com'
      OR i.from_email ILIKE '%@mail.theknot.com'
      OR i.from_email ILIKE '%@auth.theknot.com'
      OR i.from_email ILIKE '%@weddingwire.com'
      OR i.from_email ILIKE '%@mail.weddingwire.com'
      OR i.from_email ILIKE '%@authsolic.com'
      OR i.from_email ILIKE '%@theknotww.com'
      OR i.from_email ILIKE '%@herecomestheguide.com'
      OR i.from_email ILIKE '%@zola.com'
      OR i.from_email ILIKE '%@mail.zola.com'
      OR i.from_email ILIKE '%@calendly.com'
      OR i.from_email ILIKE '%@calendlymail.com'
      OR i.from_email ILIKE '%@acuityscheduling.com'
    )
    AND EXISTS (
      -- Only touch threads that are CURRENTLY in a wrong folder.
      -- Skips threads already correctly classified to keep this idempotent.
      SELECT 1 FROM public.interactions j
      WHERE j.venue_id = i.venue_id
        AND j.gmail_thread_id = i.gmail_thread_id
        AND j.lifecycle_folder NOT IN ('new_inquiry', 'potential_client', 'client')
    )
),
-- Resolve thread → wedding state. A thread can in principle touch
-- multiple weddings; pick the most-recently-updated wedding for the
-- folder decision. In practice each gmail_thread_id maps to one wedding.
thread_state AS (
  SELECT
    at.venue_id,
    at.gmail_thread_id,
    (
      SELECT w.status
      FROM public.interactions ii
      JOIN public.weddings w ON w.id = ii.wedding_id
      WHERE ii.venue_id = at.venue_id
        AND ii.gmail_thread_id = at.gmail_thread_id
      ORDER BY w.updated_at DESC NULLS LAST
      LIMIT 1
    ) AS wedding_status,
    (
      SELECT w.booked_at
      FROM public.interactions ii
      JOIN public.weddings w ON w.id = ii.wedding_id
      WHERE ii.venue_id = at.venue_id
        AND ii.gmail_thread_id = at.gmail_thread_id
      ORDER BY w.updated_at DESC NULLS LAST
      LIMIT 1
    ) AS booked_at,
    EXISTS (
      SELECT 1
      FROM public.interactions ii
      JOIN public.engagement_events ee
        ON ee.wedding_id = ii.wedding_id
       AND ee.venue_id = ii.venue_id
      WHERE ii.venue_id = at.venue_id
        AND ii.gmail_thread_id = at.gmail_thread_id
        AND ee.event_type IN ('tour_requested', 'tour_scheduled', 'tour_completed')
    ) AS has_tour_event
  FROM affected_threads at
)
UPDATE public.interactions itx
SET lifecycle_folder = CASE
  -- client: booked.
  WHEN ts.wedding_status IN ('booked', 'completed') OR ts.booked_at IS NOT NULL
    THEN 'client'
  -- potential_client: past inquiry, or tour event exists on the thread.
  WHEN ts.wedding_status IN ('tour_scheduled', 'tour_completed', 'proposal_sent')
    OR ts.has_tour_event
    THEN 'potential_client'
  -- default: new_inquiry. Form-relay / scheduling-tool senders are
  -- inquiry-stage by channel definition.
  ELSE 'new_inquiry'
END
FROM thread_state ts
WHERE itx.venue_id = ts.venue_id
  AND itx.gmail_thread_id = ts.gmail_thread_id;

-- ---------------------------------------------------------------------------
-- Standalone (no gmail_thread_id) interactions from inquiry-stage channels.
-- Same folder logic via direct wedding_id join. Rare path — most form-
-- relay + scheduling sends do carry a thread id — but worth handling so
-- the class is fully closed.
-- ---------------------------------------------------------------------------

UPDATE public.interactions itx
SET lifecycle_folder = CASE
  WHEN w.status IN ('booked', 'completed') OR w.booked_at IS NOT NULL
    THEN 'client'
  WHEN w.status IN ('tour_scheduled', 'tour_completed', 'proposal_sent')
    THEN 'potential_client'
  WHEN EXISTS (
    SELECT 1 FROM public.engagement_events ee
    WHERE ee.wedding_id = itx.wedding_id
      AND ee.venue_id = itx.venue_id
      AND ee.event_type IN ('tour_requested', 'tour_scheduled', 'tour_completed')
  ) THEN 'potential_client'
  ELSE 'new_inquiry'
END
FROM public.weddings w
WHERE itx.wedding_id = w.id
  AND itx.gmail_thread_id IS NULL
  AND itx.from_email IS NOT NULL
  AND itx.lifecycle_folder NOT IN ('new_inquiry', 'potential_client', 'client')
  AND (
    itx.from_email ILIKE '%@theknot.com'
    OR itx.from_email ILIKE '%@knotemail.com'
    OR itx.from_email ILIKE '%@member.theknot.com'
    OR itx.from_email ILIKE '%@mail.theknot.com'
    OR itx.from_email ILIKE '%@auth.theknot.com'
    OR itx.from_email ILIKE '%@weddingwire.com'
    OR itx.from_email ILIKE '%@mail.weddingwire.com'
    OR itx.from_email ILIKE '%@authsolic.com'
    OR itx.from_email ILIKE '%@theknotww.com'
    OR itx.from_email ILIKE '%@herecomestheguide.com'
    OR itx.from_email ILIKE '%@zola.com'
    OR itx.from_email ILIKE '%@mail.zola.com'
    OR itx.from_email ILIKE '%@calendly.com'
    OR itx.from_email ILIKE '%@calendlymail.com'
    OR itx.from_email ILIKE '%@acuityscheduling.com'
  );
