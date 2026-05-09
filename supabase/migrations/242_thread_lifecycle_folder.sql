-- ---------------------------------------------------------------------------
-- 242_thread_lifecycle_folder.sql  (Inbox lifecycle folders)
-- ---------------------------------------------------------------------------
-- User feedback: "the inbox needs to do a much better job filtering messages
-- into folders. There should be new inquiries, potential clients, clients,
-- vendors, advertisers, other. Inquiries are never heard from before never
-- responded — as soon as they have responded or booked a tour they should go
-- into potential clients, booked into clients."
--
-- Today the inbox only has 4 tabs (All / Inquiries / Client / Unread) and
-- the classification is computed at render time from weddings.status. That
-- buckets every non-booked email under "Inquiries" with no distinction
-- between a cold first-touch and a couple actively replying back. Vendors
-- and advertisers (Knot / WeddingWire / SaaS sales / AI tools) have nowhere
-- to go and clutter the same list.
--
-- The fix is structural: stamp every interaction row with the lifecycle
-- folder its thread belongs to. The folder is a function of:
--   - weddings.status (booked → 'client')
--   - inbound/outbound counts on the gmail_thread_id
--   - presence of a tour engagement event
--   - sender role on the people row (vendor)
--   - sender domain (advertiser allow-list)
--
-- Six folders (closed set; growth requires its own migration):
--
--   new_inquiry      — first inbound from this lead, no outbound yet.
--                      Never been replied to, never replied themselves.
--   potential_client — couple has replied OR a tour event exists OR the
--                      wedding is past 'inquiry' stage but not booked.
--   client           — wedding is booked (weddings.status = 'booked' or
--                      'completed', or weddings.booked_at IS NOT NULL).
--   vendor           — sender is a known vendor (people.role='vendor').
--   advertiser       — cold outreach from ad platforms / SaaS sales /
--                      other venue solicitations (allow-list of domains).
--   other            — legal, internal team, partner, friend-of-venue,
--                      unclassified.
--
-- Writers populate the column at every email-pipeline write site:
--   - processIncomingEmail (inbound + self-loop outbound)
--   - /api/agent/send + /api/agent/reply + /api/agent/messages/reply
--   - the autonomous-sender approved-draft path (pipeline.ts)
--
-- Idempotent: each ALTER is conditional on information_schema; backfill
-- is gated on lifecycle_folder IS NULL so a re-run is a no-op.
--
-- Multi-venue safe: classification is per-row + per-venue via the
-- weddings.venue_id and people.venue_id joins.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- STEP 1 — interactions.lifecycle_folder column
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'interactions'
      AND column_name = 'lifecycle_folder'
  ) THEN
    ALTER TABLE public.interactions
      ADD COLUMN lifecycle_folder text
        CHECK (lifecycle_folder IN (
          'new_inquiry', 'potential_client', 'client',
          'vendor', 'advertiser', 'other'
        ));
  END IF;
END $$;

COMMENT ON COLUMN public.interactions.lifecycle_folder IS
  'Inbox lifecycle folder. Decided per-thread (every interaction in a thread carries the same value) by decideLifecycleFolder() in lib/services/inbox/lifecycle.ts. Six folders: new_inquiry / potential_client / client / vendor / advertiser / other. Recomputed on every inbound + outbound write so a thread moves between folders as the lead progresses.';

-- ---------------------------------------------------------------------------
-- STEP 2 — Index for the inbox folder filter
-- ---------------------------------------------------------------------------
-- Inbox query shape: SELECT ... FROM interactions WHERE venue_id = $1
-- AND type='email' AND lifecycle_folder = $2 ORDER BY timestamp DESC.
-- A composite (venue_id, lifecycle_folder) index keeps this cheap as
-- the venue's interaction count grows. Existing idx_interactions_venue_id
-- + idx_interactions_timestamp do not cover the lifecycle_folder filter.

CREATE INDEX IF NOT EXISTS idx_threads_lifecycle_folder
  ON public.interactions (venue_id, lifecycle_folder);

-- ---------------------------------------------------------------------------
-- STEP 3 — Backfill
-- ---------------------------------------------------------------------------
-- The backfill runs the same priority-ordered rule chain that the
-- TypeScript decideLifecycleFolder() applies in the live pipeline:
--
--   1. advertiser  — sender domain in advertiser allow-list AND no
--                    wedding link (we never want to demote a real lead
--                    that came in via a Knot relay).
--   2. vendor      — joined people.role = 'vendor'.
--   3. client      — wedding booked (status IN ('booked','completed')
--                    OR booked_at IS NOT NULL).
--   4. potential_client — wedding past 'inquiry', OR a tour event exists,
--                    OR thread has at least 1 outbound + 2 inbound from
--                    the lead (couple replied back).
--   5. new_inquiry — wedding status 'inquiry', exactly 1 inbound on the
--                    thread, 0 outbound. The shape of a virgin first-touch.
--   6. other       — anything left over (internal, legal, friend, junk).
--
-- The backfill builds the rule chain as a single CASE expression on a
-- per-row basis, joining to weddings + people + a thread_counts CTE
-- + an engagement_events EXISTS subquery so it's one pass over the
-- table. Multi-venue safe — every join carries venue_id implicitly via
-- the FK columns.

WITH thread_counts AS (
  SELECT
    venue_id,
    gmail_thread_id,
    SUM(CASE WHEN direction = 'inbound'  THEN 1 ELSE 0 END) AS inbound_count,
    SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_count
  FROM public.interactions
  WHERE gmail_thread_id IS NOT NULL
  GROUP BY venue_id, gmail_thread_id
),
tour_threads AS (
  -- A thread "has a tour event" if any interaction on the thread has
  -- a sibling engagement_event on the same wedding with a tour-class
  -- event_type. Cheaper to materialise once than re-evaluate per row.
  SELECT DISTINCT i.venue_id, i.gmail_thread_id
  FROM public.interactions i
  JOIN public.engagement_events ee
    ON ee.wedding_id = i.wedding_id
   AND ee.venue_id = i.venue_id
  WHERE i.gmail_thread_id IS NOT NULL
    AND ee.event_type IN ('tour_requested', 'tour_scheduled', 'tour_completed')
)
UPDATE public.interactions AS itx
SET lifecycle_folder = CASE
  -- 1) advertiser — known cold-outreach domain AND no wedding link.
  --    The allow-list mirrors ADVERTISER_DOMAINS in lib/services/inbox/
  --    lifecycle.ts. Keep both lists in lock-step when editing.
  WHEN itx.wedding_id IS NULL AND itx.from_email IS NOT NULL AND (
       itx.from_email ILIKE '%@theknot.com'
    OR itx.from_email ILIKE '%@mail.theknot.com'
    OR itx.from_email ILIKE '%@auth.theknot.com'
    OR itx.from_email ILIKE '%@member.theknot.com'
    OR itx.from_email ILIKE '%@weddingwire.com'
    OR itx.from_email ILIKE '%@mail.weddingwire.com'
    OR itx.from_email ILIKE '%@authsolic.com'
    OR itx.from_email ILIKE '%@zola.com'
    OR itx.from_email ILIKE '%@mail.zola.com'
    OR itx.from_email ILIKE '%@herecomestheguide.com'
    OR itx.from_email ILIKE '%@wedj.com'
    OR itx.from_email ILIKE '%@weddingspot.com'
    OR itx.from_email ILIKE '%@wedsites.com'
    OR itx.from_email ILIKE '%@joinleads.com'
    OR itx.from_email ILIKE '%@hubspot.com'
    OR itx.from_email ILIKE '%@salesforce.com'
    OR itx.from_email ILIKE '%@mailchimp.com'
    OR itx.from_email ILIKE '%@intercom.io'
    OR itx.from_email ILIKE '%@drift.com'
    OR itx.from_email ILIKE '%@outreach.io'
    OR itx.from_email ILIKE '%@apollo.io'
    OR itx.from_email ILIKE '%@zoominfo.com'
    OR itx.from_email ILIKE '%@lusha.com'
    OR itx.from_email ILIKE '%@seamless.ai'
    OR itx.from_email ILIKE '%@reply.io'
    OR itx.from_email ILIKE '%@linkedin.com'
    OR itx.from_email ILIKE '%@indeed.com'
    OR itx.from_email ILIKE '%@glassdoor.com'
  ) THEN 'advertiser'

  -- 2) vendor — joined people.role on the linked person OR the wedding.
  WHEN EXISTS (
    SELECT 1 FROM public.people p
    WHERE p.id = itx.person_id AND p.role = 'vendor'
  ) THEN 'vendor'

  -- 3) client — wedding booked.
  WHEN EXISTS (
    SELECT 1 FROM public.weddings w
    WHERE w.id = itx.wedding_id
      AND (w.status IN ('booked', 'completed') OR w.booked_at IS NOT NULL)
  ) THEN 'client'

  -- 4) potential_client — wedding past 'inquiry' (tour scheduled /
  --    completed / proposal sent), OR a tour event exists, OR the
  --    couple has replied back (>=2 inbound + >=1 outbound on the thread).
  WHEN EXISTS (
    SELECT 1 FROM public.weddings w
    WHERE w.id = itx.wedding_id
      AND w.status IN ('tour_scheduled', 'tour_completed', 'proposal_sent')
  ) THEN 'potential_client'
  WHEN EXISTS (
    SELECT 1 FROM tour_threads tt
    WHERE tt.venue_id = itx.venue_id
      AND tt.gmail_thread_id = itx.gmail_thread_id
  ) THEN 'potential_client'
  WHEN EXISTS (
    SELECT 1 FROM thread_counts tc
    WHERE tc.venue_id = itx.venue_id
      AND tc.gmail_thread_id = itx.gmail_thread_id
      AND tc.outbound_count >= 1
      AND tc.inbound_count  >= 2
  ) THEN 'potential_client'

  -- 5) new_inquiry — wedding still 'inquiry' AND the couple has not
  --    replied back yet. inbound_count <= 1 means the only inbound
  --    on the thread is the original inquiry / Knot relay. We do
  --    NOT require outbound_count = 0 here: per Isadora's rule,
  --    "never heard from before, never responded" means the COUPLE
  --    has not responded. Whether Sage has fired a nurture sequence
  --    is irrelevant. Without this relaxation, every Knot inquiry
  --    where Sage replied silently rolled into 'other'.
  WHEN EXISTS (
    SELECT 1 FROM public.weddings w
    WHERE w.id = itx.wedding_id
      AND w.status = 'inquiry'
  ) AND (
    itx.gmail_thread_id IS NULL
    OR EXISTS (
      SELECT 1 FROM thread_counts tc
      WHERE tc.venue_id = itx.venue_id
        AND tc.gmail_thread_id = itx.gmail_thread_id
        AND tc.inbound_count <= 1
    )
  ) THEN 'new_inquiry'

  -- 6) other — fallback.
  ELSE 'other'
END
WHERE itx.lifecycle_folder IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
