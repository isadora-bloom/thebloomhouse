-- Combined migration bundle: 242 + 243 + 244
-- Apply by pasting into Supabase Dashboard > SQL Editor > New Query > Run
-- Project: jsxxgwprxuqgcauzlxcb (the bloom house)
-- Idempotent: safe to re-run.

-- ============================================
-- MIGRATION 242: inbox lifecycle folders
-- ============================================
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

  -- 5) new_inquiry — wedding still 'inquiry', thread has exactly 1
  --    inbound and 0 outbound (or no thread id yet — the very first
  --    email landing without a Gmail-thread association).
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
        AND tc.outbound_count = 0
        AND tc.inbound_count <= 1
    )
  ) THEN 'new_inquiry'

  -- 6) other — fallback.
  ELSE 'other'
END
WHERE itx.lifecycle_folder IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================
-- MIGRATION 243: brand_assets extended
-- ============================================
-- ---------------------------------------------------------------------------
-- 243_brand_assets_extended.sql  (Brand assets reuse + couple portal exposure)
-- ---------------------------------------------------------------------------
-- User feedback (Isadora, 2026-05-08):
--   "i like the idea of having a place to upload say 10 different photos
--    that sage could use to respond to emails if they fit (like one of
--    ceremony, one of the tent etc) and i think the original purpose was
--    to have a place i could upload watercolour images, floor plans etc
--    that could go on the couples portal so they could download things
--    for their favors, programs etc"
--
-- Today brand_assets exists (migration 024) but is orphaned: only the
-- coordinator Settings page reads/writes it, and the schema is just
-- (asset_type, label, url). No way to teach Sage which photo to attach
-- to which email, no way to expose a sketch to a couple.
--
-- This migration extends the table so a single asset row can power both
-- (a) Sage's email auto-attach matching and (b) the couple portal
-- Resources page download list. One source of truth, two consumers.
--
-- Columns added:
--   caption           — coordinator-written one-liner. Sage matching
--                       reads this when picking a photo for a reply.
--   category          — internal taxonomy distinct from asset_type
--                       (which is media-type). Lets Sage pick a
--                       'ceremony' photo for a ceremony-question email.
--   couple_facing     — whether the asset shows on the couple portal.
--   couple_category   — categorization shown to couples (favors,
--                       programs, decor, planning, other).
--   sage_eligible     — whether Sage may auto-attach this in emails.
--                       Defaults off so we never accidentally send a
--                       blueprint or contract draft to a prospect.
--   file_size_bytes
--   mime_type         — populated when the asset is uploaded via the
--                       new file-upload path. NULL on legacy URL-paste
--                       rows so the UI can render "external image" badges.
--
-- Idempotent — every ALTER guarded with IF NOT EXISTS. Multi-venue safe;
-- the venue_id FK is unchanged.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- STEP 1 — column additions
-- ---------------------------------------------------------------------------

ALTER TABLE public.brand_assets
  ADD COLUMN IF NOT EXISTS caption text,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS couple_facing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS couple_category text,
  ADD COLUMN IF NOT EXISTS sage_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS file_size_bytes integer,
  ADD COLUMN IF NOT EXISTS mime_type text;

COMMENT ON COLUMN public.brand_assets.caption IS
  'Coordinator-written one-liner describing what is shown. Used by Sage matching.';
COMMENT ON COLUMN public.brand_assets.category IS
  'Internal taxonomy for Sage matching (ceremony / tent / reception / detail / aerial / venue_exterior / staff / other). Distinct from asset_type which is media-type.';
COMMENT ON COLUMN public.brand_assets.couple_facing IS
  'Whether this asset shows up on the couple portal Resources page.';
COMMENT ON COLUMN public.brand_assets.couple_category IS
  'Categorization shown to couples (favors / programs / decor / planning / other).';
COMMENT ON COLUMN public.brand_assets.sage_eligible IS
  'Whether Sage can pick this asset for email auto-attach.';
COMMENT ON COLUMN public.brand_assets.file_size_bytes IS
  'Bytes — populated when uploaded via the new file-upload path; NULL for URL-only legacy rows.';
COMMENT ON COLUMN public.brand_assets.mime_type IS
  'MIME — populated when uploaded via the new file-upload path; NULL for URL-only legacy rows.';

-- ---------------------------------------------------------------------------
-- STEP 2 — CHECK constraints (allow NULL on both)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brand_assets_category_check'
  ) THEN
    ALTER TABLE public.brand_assets
      ADD CONSTRAINT brand_assets_category_check
      CHECK (category IS NULL OR category IN (
        'ceremony', 'tent', 'reception', 'detail',
        'aerial', 'venue_exterior', 'staff', 'other'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brand_assets_couple_category_check'
  ) THEN
    ALTER TABLE public.brand_assets
      ADD CONSTRAINT brand_assets_couple_category_check
      CHECK (couple_category IS NULL OR couple_category IN (
        'favors', 'programs', 'decor', 'planning', 'other'
      ));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- STEP 3 — indexes
-- ---------------------------------------------------------------------------
-- Couple portal Resources query: WHERE venue_id = $1 AND couple_facing = true.
-- Sage auto-attach query:        WHERE venue_id = $1 AND sage_eligible = true.
-- Two narrow composite indexes keep both fast as the table grows.

CREATE INDEX IF NOT EXISTS idx_brand_assets_venue_couple_facing
  ON public.brand_assets (venue_id, couple_facing)
  WHERE couple_facing = true;

CREATE INDEX IF NOT EXISTS idx_brand_assets_venue_sage_eligible
  ON public.brand_assets (venue_id, sage_eligible)
  WHERE sage_eligible = true;

-- ---------------------------------------------------------------------------
-- STEP 4 — couple portal RLS read policy
-- ---------------------------------------------------------------------------
-- Couple users (people.user_id = auth.uid()) can SELECT brand_assets
-- flagged couple_facing for their venue. Coordinator/super_admin keep
-- their existing wider policies from migration 024.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'brand_assets'
      AND policyname = 'couple_read_brand_assets'
  ) THEN
    DROP POLICY "couple_read_brand_assets" ON public.brand_assets;
  END IF;
END $$;

CREATE POLICY "couple_read_brand_assets" ON public.brand_assets
  FOR SELECT
  TO authenticated
  USING (
    couple_facing = true
    AND venue_id IN (
      SELECT w.venue_id FROM public.weddings w
      JOIN public.people p ON p.wedding_id = w.id
      WHERE p.user_id = auth.uid()
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================
-- MIGRATION 244: auto-attach photos toggle
-- ============================================
-- ---------------------------------------------------------------------------
-- 244_auto_attach_photos.sql  (Sage email auto-attach opt-in toggle)
-- ---------------------------------------------------------------------------
-- Pairs with migration 243 (brand_assets.sage_eligible / category / caption /
-- mime_type) and the matchAssetsForEmail service. When the venue flips this
-- toggle on, the email pipeline calls the asset matcher at the send boundary
-- to optionally attach 0-2 venue photos to the outbound reply.
--
-- Default OFF: coordinators must opt in. Even with the column flipped on,
-- the matcher only attaches when at least one brand_assets row is marked
-- sage_eligible AND the AI matcher decides a photo would clearly add value.
-- "Empty list is the right answer most of the time" is enforced at the
-- prompt layer too.
--
-- Surfaced in /settings as a single toggle near other automation toggles
-- (separate from the brand-assets section the migration 243 sibling owns).

ALTER TABLE venue_config
  ADD COLUMN IF NOT EXISTS auto_attach_photos boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN venue_config.auto_attach_photos IS
  'When true, the email-send path runs matchAssetsForEmail before each '
  'outbound reply (autonomous + coordinator-approved). Off by default. '
  'Source: migration 244 / Sage email auto-attach.';
