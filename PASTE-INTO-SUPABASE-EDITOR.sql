
-- ============================================================================
-- ▶ 215_pricing_v2.sql
-- ============================================================================
-- Pricing v2: capacity-gated 5-tier model.
-- Replaces 3-tier feature-gated model (starter/intelligence/enterprise).
-- Mapping: starter→solo, intelligence→growth, enterprise→enterprise.
--
-- Key model shift: every tier now gets every feature. Capacity is the only
-- differentiator. Founding member program (25-venue cap, 50% off for 24mo)
-- and pre-opening rollover (auto-flip to Solo 30 days after first paid wedding)
-- are also tracked here.

BEGIN;

-- 1. Drop the old check constraint
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_plan_tier_check;

-- user_profiles.plan_tier may not exist in this schema (only venues +
-- organisations carry tier in migration 001). Guard the constraint drop.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_profiles'
      AND column_name = 'plan_tier'
  ) THEN
    EXECUTE 'ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_plan_tier_check';
  END IF;
END$$;

-- 2. Migrate existing tier values
UPDATE venues SET plan_tier = 'solo' WHERE plan_tier = 'starter';
UPDATE venues SET plan_tier = 'growth' WHERE plan_tier = 'intelligence';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_profiles'
      AND column_name = 'plan_tier'
  ) THEN
    EXECUTE $sql$UPDATE user_profiles SET plan_tier = 'solo' WHERE plan_tier = 'starter'$sql$;
    EXECUTE $sql$UPDATE user_profiles SET plan_tier = 'growth' WHERE plan_tier = 'intelligence'$sql$;
  END IF;
END$$;

-- 3. Add the new check constraint with 5 tiers
ALTER TABLE venues ADD CONSTRAINT venues_plan_tier_check
  CHECK (plan_tier IN ('pre_opening', 'solo', 'growth', 'multi', 'enterprise'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_profiles'
      AND column_name = 'plan_tier'
  ) THEN
    EXECUTE $sql$ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_plan_tier_check
      CHECK (plan_tier IN ('pre_opening', 'solo', 'growth', 'multi', 'enterprise'))$sql$;
  END IF;
END$$;

-- 4. Default changes from 'starter' to 'solo'
ALTER TABLE venues ALTER COLUMN plan_tier SET DEFAULT 'solo';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_profiles'
      AND column_name = 'plan_tier'
  ) THEN
    EXECUTE $sql$ALTER TABLE user_profiles ALTER COLUMN plan_tier SET DEFAULT 'solo'$sql$;
  END IF;
END$$;

-- 5. New tracking columns for capacity caps + founding member + pre-opening rollover
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS inquiry_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inquiry_count_this_period INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_founding_member BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS founding_member_signup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS founding_member_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_opening_first_paid_wedding_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_opening_grace_until TIMESTAMPTZ;

COMMENT ON COLUMN venues.inquiry_period_start IS
  'Start of the current monthly billing period for inquiry-cap tracking. Resets to now() on tier upgrade or month boundary.';
COMMENT ON COLUMN venues.inquiry_count_this_period IS
  'Number of new inquiries received in the current period. Compared against tier cap. Reset by cron at period boundary.';
COMMENT ON COLUMN venues.is_founding_member IS
  'TRUE if signed up during the 25-venue Founding Member program. Locks 50% off rate for 24 months.';
COMMENT ON COLUMN venues.founding_member_expires_at IS
  '24-month expiry of founding member rate. After this, tier auto-bills at standard rate.';
COMMENT ON COLUMN venues.pre_opening_first_paid_wedding_at IS
  'When the pre-opening venue completed its first paid wedding. Triggers 30-day grace + auto-rollover to Solo.';
COMMENT ON COLUMN venues.pre_opening_grace_until IS
  'End of 30-day grace period after first paid wedding. After this, billing flips to Solo (Founding if program open, else standard).';

-- 6. Founding member counter table — single row, used to enforce the 25-venue cap atomically
CREATE TABLE IF NOT EXISTS founding_member_counter (
  id INTEGER PRIMARY KEY DEFAULT 1,
  count INTEGER NOT NULL DEFAULT 0,
  cap INTEGER NOT NULL DEFAULT 25,
  closes_at TIMESTAMPTZ NOT NULL DEFAULT '2026-12-31T23:59:59Z',
  CONSTRAINT founding_member_counter_singleton CHECK (id = 1)
);
INSERT INTO founding_member_counter (id, count, cap) VALUES (1, 0, 25)
  ON CONFLICT (id) DO NOTHING;

-- 7. Index for the inquiry-cap reset cron
CREATE INDEX IF NOT EXISTS venues_inquiry_period_start_idx
  ON venues (inquiry_period_start);

COMMIT;

-- ============================================================================
-- ▶ 217_vendor_portal_token_expiry.sql
-- ============================================================================
-- ============================================
-- 217_vendor_portal_token_expiry.sql
-- ============================================
--
-- Adds optional token expiry columns to vendor_recommendations and
-- booked_vendors so leaked / stale vendor portal links can be aged
-- out. Per 2026-05-06 audit Lens 8: "/api/public/vendor-portal token-
-- only, no rate limit, no expiry. portal_token is 16 random bytes hex
-- (entropy fine); revocation is by null-ing portal_token."
--
-- Schema decision: NULL expires_at = no expiry (backward-compatible
-- with every token issued before this migration). New tokens issued
-- via coordinator UI populate both columns. The /api/public/vendor-
-- portal route reads expires_at and rejects if it's set AND past.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================

ALTER TABLE public.vendor_recommendations
  ADD COLUMN IF NOT EXISTS portal_token_issued_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS portal_token_expires_at timestamptz NULL;

COMMENT ON COLUMN public.vendor_recommendations.portal_token_issued_at IS
  'When the current portal_token was issued. NULL on rows that predate '
  'migration 217 — those tokens never expire automatically. Coordinator '
  're-issue stamps both this and portal_token_expires_at.';

COMMENT ON COLUMN public.vendor_recommendations.portal_token_expires_at IS
  'Optional auto-expiry. NULL means token never expires. The /api/public/'
  'vendor-portal route rejects tokens whose expires_at is non-null and '
  'in the past. Default policy from coordinator UI: 12 months from issue.';

ALTER TABLE public.booked_vendors
  ADD COLUMN IF NOT EXISTS portal_token_issued_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS portal_token_expires_at timestamptz NULL;

COMMENT ON COLUMN public.booked_vendors.portal_token_issued_at IS
  'See vendor_recommendations.portal_token_issued_at.';

COMMENT ON COLUMN public.booked_vendors.portal_token_expires_at IS
  'See vendor_recommendations.portal_token_expires_at.';

-- Index supports the per-token lookup-with-expiry-check the route runs
-- on every request. Partial index (NOT NULL) keeps it small — the
-- common case is no-expiry rows we don't need to scan.
CREATE INDEX IF NOT EXISTS idx_vendor_recommendations_portal_token_expiry
  ON public.vendor_recommendations(portal_token_expires_at)
  WHERE portal_token_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_booked_vendors_portal_token_expiry
  ON public.booked_vendors(portal_token_expires_at)
  WHERE portal_token_expires_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 218_wedding_website_share_token.sql
-- ============================================================================
-- ============================================
-- 218_wedding_website_share_token.sql
-- ============================================
--
-- Closes the guest-list enumeration oracle on /api/public/wedding-website.
-- Per 2026-05-06 audit Lens 8:
--
-- > "wedding_website public endpoint reads guest_list joined on people
-- >  and exposes first_name + last_name to any unauthenticated caller
-- >  who knows a venue's slug. The 'guest search' returns names by a
-- >  2-char prefix match. That's a guest-list enumeration oracle keyed
-- >  on a public slug."
--
-- Threat model: slugs are user-chosen and often predictable (e.g.
-- "smith-2027"). Anyone can scrape every wedding website's full guest
-- list with a small Python script.
--
-- Fix: split the public surface into two tiers.
--   - Tier 1 (public): rendering the wedding website HTML (sections,
--     theme, FAQ, registry, etc.). Slug-only, no token. This is meant
--     to be public — couples share the URL openly.
--   - Tier 2 (token-gated): guest search and RSVP submission. Requires
--     a share_token the couple's invitation links carry. Without the
--     token, the route returns 404 — no enumeration possible.
--
-- Schema:
--   share_token text — 32-char random hex (16 bytes). UNIQUE.
--   share_token_issued_at timestamptz — when issued.
--
-- Backfill: every existing row gets a fresh token at apply time. Any
-- pre-launch share-links already in circulation break. Acceptable
-- given pre-launch state (no paying customers, one design-partner
-- venue per audit context).
-- ============================================

ALTER TABLE public.wedding_website_settings
  ADD COLUMN IF NOT EXISTS share_token text NULL,
  ADD COLUMN IF NOT EXISTS share_token_issued_at timestamptz NULL;

-- Backfill existing rows with fresh tokens. encode() with gen_random_bytes
-- gives 32 hex chars from 16 bytes (128 bits of entropy — well above
-- guess-resistance threshold).
UPDATE public.wedding_website_settings
SET share_token = encode(gen_random_bytes(16), 'hex'),
    share_token_issued_at = NOW()
WHERE share_token IS NULL;

-- Now require it. Future inserts must populate.
ALTER TABLE public.wedding_website_settings
  ALTER COLUMN share_token SET NOT NULL;

-- Unique index — share_token is the only thing tying a guest invitation
-- back to a wedding's website. Collision must be impossible.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wedding_website_settings_share_token
  ON public.wedding_website_settings(share_token);

COMMENT ON COLUMN public.wedding_website_settings.share_token IS
  '32-char hex (16-byte) random token for the guest-facing share-link. '
  'Required by /api/public/wedding-website?action=search_guest and ?action=rsvp. '
  'Public website rendering does NOT require it (slug-only). Per audit Lens 8.';

COMMENT ON COLUMN public.wedding_website_settings.share_token_issued_at IS
  'When the current share_token was issued. Future rotation flow stamps '
  'this for invalidation policy.';

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 219_wedding_injection_block.sql
-- ============================================================================
-- ============================================
-- 219_wedding_injection_block.sql
-- ============================================
--
-- Persists prompt-injection signals across the wedding lifecycle so
-- auto-send protection extends to follow-up sequences. Round-3 audit
-- caught a ghost-surface gap:
--
-- > follow-up-sequences.ts:353 calls checkAutoSendEligible without
-- > injectionSuspected. Follow-ups are scheduled outbound nudges; the
-- > original inbound's injection signal is not propagated forward. A
-- > coordinator-uninvolved follow-up sequence on a wedding whose first
-- > inbound was injection-flagged will still auto-send.
--
-- Approach:
--   - weddings.auto_send_blocked_at  : timestamptz, set when any
--     inbound on this wedding tripped containsInjectionAttempt. NULL
--     = clean. Coordinator can clear by setting NULL.
--   - weddings.auto_send_block_reason: text, captures the trigger
--     ('injection_subject', 'injection_body') for forensic review.
--
-- email-pipeline.ts will stamp these on detection. follow-up-
-- sequences.ts will read them and pass injectionSuspected accordingly.
-- A coordinator UI to clear is Tier-B (separate PR).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS auto_send_blocked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS auto_send_block_reason text NULL;

COMMENT ON COLUMN public.weddings.auto_send_blocked_at IS
  'When any inbound on this wedding tripped a prompt-injection signal '
  '(containsInjectionAttempt). NULL means no signal recorded. Auto-'
  'send eligibility (autonomous-sender.ts checkAutoSendEligible) reads '
  'this and treats non-null as injectionSuspected for ALL drafts on '
  'the wedding, including follow-up sequences. Coordinator clears via '
  'a Tier-B UI (set NULL).';

COMMENT ON COLUMN public.weddings.auto_send_block_reason IS
  'Free-text reason captured at the moment of block. Examples: '
  '"injection_subject", "injection_body". Audit-only — used by ops '
  'to triage false positives.';

-- Index supports the eligibility-time read (lookup by id is already
-- the primary key). No additional index needed.

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 220_share_token_default_and_rls.sql
-- ============================================================================
-- ============================================
-- 220_share_token_default_and_rls.sql
-- ============================================
--
-- Two round-4 audit fixes on wedding_website_settings:
--
-- F1 — share_token had no DEFAULT.
--   Mig 218 added share_token NOT NULL and backfilled existing rows,
--   but new INSERTs from src/app/_couple-pages/website/page.tsx upsert
--   without supplying a token. Brand-new couples (who haven't published
--   their wedding website yet) hit a NOT NULL violation on first save,
--   AND the round-3 read-only checklist Share button silently fails
--   because the row doesn't exist with a token. Fix: add a default that
--   mints a fresh 32-char hex (16-byte) token on insert.
--
-- F3 — share_token leaks cross-couple via permissive RLS.
--   Mig 038 created auth_select_wedding_website_settings as
--   USING(true) for authenticated. Any logged-in couple can read any
--   other couple's share_token. Closing this means scoping the SELECT
--   policy to the user's own wedding (via user_profiles.wedding_id).
--
-- Idempotent: ALTER COLUMN SET DEFAULT, DROP POLICY IF EXISTS,
-- CREATE POLICY.
--
-- 2026-05-07 fixup: this migration originally referenced
-- user_profiles.wedding_id in the F3 SELECT policy, but the column was
-- only added later in mig 226 (couple-role RLS pathway). Apply order
-- inverted, so re-running 220 against a fresh schema would fail with
-- "column up.wedding_id does not exist". Added the column-add inline
-- here so 220 is self-contained. Mig 226 then layers helper functions
-- + the broader couple_read/write policy set on top of this column.
-- The IF NOT EXISTS guard makes both migrations idempotent in either
-- order.
-- ============================================

-- ----------------------------------------------------------------------
-- F0: prerequisite — user_profiles.wedding_id (originally mig 226)
-- ----------------------------------------------------------------------

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_wedding ON public.user_profiles(wedding_id);

COMMENT ON COLUMN public.user_profiles.wedding_id IS
  'For role=couple users: the wedding they registered for. NULL for coordinator / org_admin / super_admin / pending-invite rows. Drives the couple_read RLS predicates.';

-- ----------------------------------------------------------------------
-- F1: share_token DEFAULT
-- ----------------------------------------------------------------------

ALTER TABLE public.wedding_website_settings
  ALTER COLUMN share_token SET DEFAULT encode(gen_random_bytes(16), 'hex');

COMMENT ON COLUMN public.wedding_website_settings.share_token IS
  '32-char hex (16-byte) random token for the guest-facing share-link. '
  'Auto-minted on INSERT via the column DEFAULT (mig 220). Required by '
  '/api/public/wedding-website action=search_guest, action=rsvp, and '
  'action=checklist. Public website rendering does NOT require it '
  '(slug-only). Per audit Lens 8 + round-3 follow-up #44.';

-- Belt-and-suspenders: the issued_at column should also auto-stamp on
-- token mint. Existing rows backfilled by 218; new inserts get NOW().
ALTER TABLE public.wedding_website_settings
  ALTER COLUMN share_token_issued_at SET DEFAULT NOW();

-- ----------------------------------------------------------------------
-- F3: tighten authenticated SELECT to wedding-scoped reads
-- ----------------------------------------------------------------------

-- Drop the wide-open authenticated SELECT introduced in 038.
DROP POLICY IF EXISTS "auth_select_wedding_website_settings"
  ON public.wedding_website_settings;
DROP POLICY IF EXISTS "wedding_website_settings_authenticated_select"
  ON public.wedding_website_settings;
DROP POLICY IF EXISTS "venue_isolation"
  ON public.wedding_website_settings;

-- Authenticated couples can read ONLY their own wedding's settings.
-- Coordinators (platform roles) read via the user_visible_venue_ids()
-- function for their venue/org scope. Super_admins bypass via
-- is_super_admin().
CREATE POLICY "wedding_website_settings_authenticated_select"
  ON public.wedding_website_settings
  FOR SELECT TO authenticated
  USING (
    -- Couple users: must match their wedding_id.
    wedding_id IN (
      SELECT up.wedding_id FROM public.user_profiles up
       WHERE up.id = auth.uid() AND up.wedding_id IS NOT NULL
    )
    -- OR coordinators: venue scope via user_visible_venue_ids() (mig 141)
    OR venue_id IN (SELECT public.user_visible_venue_ids())
    -- OR platform team
    OR public.is_super_admin()
  );

-- Authenticated INSERT/UPDATE: same scoping. Couples can only edit
-- their own wedding's settings; coordinators their venue's; admins any.
DROP POLICY IF EXISTS "auth_modify_wedding_website_settings"
  ON public.wedding_website_settings;
DROP POLICY IF EXISTS "wedding_website_settings_authenticated_modify"
  ON public.wedding_website_settings;

CREATE POLICY "wedding_website_settings_authenticated_modify"
  ON public.wedding_website_settings
  FOR ALL TO authenticated
  USING (
    wedding_id IN (
      SELECT up.wedding_id FROM public.user_profiles up
       WHERE up.id = auth.uid() AND up.wedding_id IS NOT NULL
    )
    OR venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  )
  WITH CHECK (
    wedding_id IN (
      SELECT up.wedding_id FROM public.user_profiles up
       WHERE up.id = auth.uid() AND up.wedding_id IS NOT NULL
    )
    OR venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  );

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 221_venue_logistics_fields.sql
-- ============================================================================
-- ============================================================================
-- 221: VENUE LOGISTICS FIELDS
--
-- Adds the four columns that the couple-portal /venue-info page already
-- accommodates as optional render blocks (mig 008 added the address; this
-- adds the rest of the day-of logistics surface). Tier-B audit #52
-- ("Walkthrough/parking/where-to-enter logistics").
--
-- Once populated, the existing /couple/[slug]/venue-info page renders:
--   - Parking section (parking_instructions, multi-line text)
--   - Where to enter section (entry_instructions, multi-line text)
--   - Day-of contact card (name + tap-to-call phone)
--
-- All four columns nullable so existing venues aren't disrupted; new venues
-- prompted to populate during onboarding (separate follow-up; this migration
-- is schema-only).
-- ============================================================================

ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS parking_instructions text,
  ADD COLUMN IF NOT EXISTS entry_instructions text,
  ADD COLUMN IF NOT EXISTS day_of_contact_name text,
  ADD COLUMN IF NOT EXISTS day_of_contact_phone text;

COMMENT ON COLUMN venues.parking_instructions IS 'Multi-line plain text. Free-form parking guidance for guests/couples (lot location, valet, overflow). Surfaced on couple portal /venue-info.';
COMMENT ON COLUMN venues.entry_instructions IS 'Multi-line plain text. Where to enter on the day (which gate, accessible entrance, vendor entrance). Surfaced on couple portal /venue-info.';
COMMENT ON COLUMN venues.day_of_contact_name IS 'Name of the day-of coordinator point-of-contact for this venue (e.g. "Sarah from Bloom House"). Distinct from any individual coordinator user account; this is the published name couples and vendors should ask for on arrival.';
COMMENT ON COLUMN venues.day_of_contact_phone IS 'Phone number couples and vendors should call on the day. tel: link rendered on the couple-portal venue-info card.';

-- ============================================================================
-- ▶ 222_owner_note_and_photo.sql
-- ============================================================================
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

-- ============================================================================
-- ▶ 223_packages_description.sql
-- ============================================================================
-- ============================================================================
-- 223: PACKAGES (couple-facing description)
--
-- Tier-B audit #54 (Package contents per couple). The packages catalog
-- table (mig 178) tracks name + price_cents + season metadata, but has
-- no field for "what's actually included in this package": the prose
-- a coordinator would write to a couple to remind them what they booked.
--
-- Distinction from existing fields:
--   - `name`        = short tier label ("Spring", "Premium", "All-Inclusive")
--   - `notes`       = INTERNAL coordinator notes (not couple-facing)
--   - `source_text` = provenance trace ("from form column X")
--   - `description` = COUPLE-FACING prose listing what's included.
--                     Surfaced on the couple dashboard package card and
--                     /booking page. Free text; multi-paragraph okay.
--
-- Nullable; venues that haven't filled this in render the card as
-- name-only ("You booked: Spring Package") with a note that the details
-- live in their contract. No backfill.
-- ============================================================================

ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN public.packages.description IS
  'Couple-facing prose describing what is included in this package / upgrade / discount / fee. Multi-paragraph free text. Distinct from `notes` (internal coordinator notes) and `source_text` (provenance trace). Surfaced on the couple dashboard package card and /booking page. Nullable; venues without a description render the card as name-only.';

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 224_checklist_assigned_to.sql
-- ============================================================================
-- ============================================================================
-- 224: CHECKLIST_ITEMS (assigned_to)
--
-- Tier-B audit #56. Couples planning together need to be able to say
-- "Sarah handles flowers, James handles vendors, Mom is on rehearsal
-- dinner." Without this column the checklist is a flat list with no
-- ownership signal.
--
-- Free-text rather than an FK to `people` for three reasons:
--   1. Couples assign tasks to NON-people-table entities all the time
--      ("Mom", "Sarah's brother", "the planner"). An FK forces a person
--      row that doesn't otherwise exist.
--   2. The display shape is always a short name string. A people FK
--      would require a join on every checklist read.
--   3. Couples can change their minds quickly. Cheaper to type a new
--      name than to add/remove people rows.
--
-- Renderer treats the value as opaque: first 24 chars rendered as a
-- chip on the checklist item, no normalization. Empty string === null.
-- Whitespace trimmed at the API boundary, not in SQL.
-- ============================================================================

ALTER TABLE public.checklist_items
  ADD COLUMN IF NOT EXISTS assigned_to text;

COMMENT ON COLUMN public.checklist_items.assigned_to IS
  'Free-text name of who owns this task. Couple-controlled. Examples: "Sarah", "James", "Mom", "both of us". Nullable. Renderer truncates to ~24 chars on the checklist UI.';

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 225_drop_wide_open_anon_select.sql
-- ============================================================================
-- ============================================================================
-- 225: DROP WIDE-OPEN ANON SELECT POLICIES (round-6 #2a)
--
-- Migration 027 added 49 `CREATE POLICY "anon_select_<table>" ... USING (true)`
-- policies to make the demo couple portal work back when the demo was the
-- only thing reachable. The intent was always demo-only, but the predicate
-- (`USING (true)`) leaks every row to anyone with the anon key.
--
-- Migration 064 fixed THE READ side of the demo path with narrower
-- `demo_anon_select` policies gated on `venue_id IN (is_demo=true)` /
-- `wedding_id IN (...)`. But Postgres OR's permissive policies, so the
-- wide-open 027 policies remained the actual gate; mig 064's narrowing
-- has been dead-weight ever since.
--
-- Migration 147 closed the equivalent leak on the WRITE side (anon_insert /
-- anon_update / anon_delete) but explicitly left the SELECT policies
-- untouched. Round-6 audit (2026-05-07) caught this gap; it had been live
-- as a real leak for ~3 weeks.
--
-- Why it's safe to drop now:
--   - No real (non-demo) couples are using the portal yet (Rixey is the
--     only production venue and she's coordinator-authed). Dropping these
--     SELECT policies removes anon access to all venues' couple-portal
--     data; no real user is broken.
--   - The demo path (Hawthorne / Crestwood) still works via mig 064's
--     `demo_anon_select` policies, which are scoped to `is_demo = true`.
--   - Coordinators / org_admin / super_admin all read via the
--     authenticated role, gated by mig 006's `venue_isolation` and
--     mig 058's org policies. Untouched.
--
-- After this migration, the anon role can SELECT only:
--   - rows where `venue_id` matches an is_demo venue (mig 064 step 1)
--   - rows where `wedding_id` traces to an is_demo venue (mig 064 step 2)
--   - venues / weddings / organisations / venue_groups themselves where
--     the demo flag is set (mig 064 steps 3-6)
--
-- Pre-existing wide-open SELECT policies that survive this migration are
-- listed at the bottom for human review. None should remain on
-- couple-portal-reachable tables; if any do, that's the next round of
-- this work.
-- ============================================================================

DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    -- All 49 tables touched by mig 027.
    'checklist_items',
    'guest_list',
    'seating_tables',
    'seating_assignments',
    'sage_conversations',
    'contracts',
    'messages',
    'vendor_recommendations',
    'inspo_gallery',
    'timeline',
    'venue_config',
    'venue_ai_config',
    'wedding_detail_config',
    'onboarding_progress',
    'wedding_website_settings',
    'budget_items',
    'budget_payments',
    'wedding_config',
    'couple_budget',
    'guest_meal_options',
    'guest_tags',
    'guest_tag_assignments',
    'bar_planning',
    'bar_recipes',
    'bar_shopping_list',
    'decor_inventory',
    'bedroom_assignments',
    'shuttle_schedule',
    'guest_care_notes',
    'staffing_assignments',
    'portal_section_config',
    'wedding_details',
    'wedding_tables',
    'wedding_party',
    'ceremony_order',
    'makeup_schedule',
    'rehearsal_dinner',
    'wedding_worksheets',
    'photo_library',
    'borrow_catalog',
    'borrow_selections',
    'accommodations',
    'allergy_registry',
    'rsvp_config',
    'rsvp_responses',
    'section_finalisations',
    'booked_vendors',
    'storefront',
    'venue_assets',
    'venue_resources'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    -- Skip non-existent tables silently. Some may have been renamed or
    -- never created in this environment.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_table
    ) THEN
      RAISE NOTICE '[225] Skipping non-existent table: %', v_table;
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS "anon_select_%I" ON public.%I', v_table, v_table);
  END LOOP;
END $$;

-- ============================================================================
-- Verification: count remaining wide-open SELECT policies on the anon role
-- across the public schema. The number should be small (or zero) and any
-- non-zero results are flagged for human review.
-- ============================================================================

DO $$
DECLARE
  v_remaining int;
  v_row record;
BEGIN
  SELECT COUNT(*) INTO v_remaining
    FROM pg_policies
   WHERE schemaname = 'public'
     AND 'anon' = ANY(roles)
     AND cmd = 'SELECT'
     AND qual = 'true';

  RAISE NOTICE '[225] Wide-open anon SELECT policies remaining on public schema: %', v_remaining;

  IF v_remaining > 0 THEN
    FOR v_row IN
      SELECT tablename, policyname
        FROM pg_policies
       WHERE schemaname = 'public'
         AND 'anon' = ANY(roles)
         AND cmd = 'SELECT'
         AND qual = 'true'
    LOOP
      RAISE NOTICE '[225] Surviving wide-open: %.%', v_row.tablename, v_row.policyname;
    END LOOP;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 226_couple_role_rls.sql
-- ============================================================================
-- ============================================================================
-- 226: COUPLE-ROLE RLS PATHWAY (Tier-A #2b)
--
-- Closes the gap that round-6 audit surfaced and the user confirmed needs
-- to land BEFORE the first non-demo couple is onboarded:
--
--   Today: a couple registers via /api/couple/register, which creates a
--   user_profiles row with role='couple' and venue_id=<their wedding's
--   venue>. They sign in. Their browser supabase client has a real
--   authenticated session. But every existing RLS policy is built
--   around "user_profiles.venue_id = row.venue_id" — so a couple at
--   venue X can read EVERY wedding at venue X, not just their own.
--
-- This migration adds wedding-level scoping for the couple role. The
-- shape mirrors mig 064 (demo path) so the two paths read symmetrically.
--
-- Layers:
--   1. user_profiles gets a `wedding_id` column (nullable FK).
--   2. Helper SQL functions that resolve the auth user's wedding_id /
--      venue_id (couple role only). SECURITY DEFINER so they bypass
--      the calling user's policies on user_profiles itself.
--   3. couple_read SELECT policies on every wedding_id-scoped table.
--   4. couple_read SELECT policies on the small set of venue_id-scoped
--      tables couples need (venue_config for branding, venue_ai_config
--      for owner_name, packages for catalog).
--   5. couple_write UPDATE/INSERT/DELETE policies on the explicit set
--      of tables couples are expected to write (checklist_items,
--      budget_items, guest_list, sage_conversations, etc.). Writes are
--      gated by both `wedding_id = couple_user_wedding_id()` and an
--      assertion that role='couple' (so a misconfigured user_profiles
--      row can't escalate).
--
-- Out of scope (intentional):
--   - Couples writing to venues, venue_config, venue_ai_config, packages.
--     Read-only for couples; coordinator role retains write via mig 058.
--   - Couples reading interactions, drafts, gmail_*, weddings_journal_*,
--     anything coordinator-internal. Hard NO; their wedding row gives
--     them the "their wedding" view, not the agent timeline.
--   - Cross-wedding data (anonymised industry stats / anomalies). Couples
--     never need that surface; coordinator scope only.
--
-- Idempotent: column add uses IF NOT EXISTS, function uses CREATE OR REPLACE,
-- policy adds DROP IF EXISTS first. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. user_profiles.wedding_id
--
-- Nullable: coordinator / org_admin / super_admin rows have wedding_id NULL
-- (they're venue-scoped). Couple rows have wedding_id set at registration.
-- FK with ON DELETE SET NULL so deleting a wedding doesn't cascade-delete
-- the auth user (the auth user is a real Supabase auth.users row that
-- shouldn't disappear because their wedding was deleted; admin can
-- re-link or hard-delete via auth.admin.deleteUser).
-- ----------------------------------------------------------------------------

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_wedding ON public.user_profiles(wedding_id);

COMMENT ON COLUMN public.user_profiles.wedding_id IS
  'For role=''couple'' users: the wedding they registered for. NULL for coordinator / org_admin / super_admin / pending-invite rows. Drives the couple_read RLS predicates.';

-- ----------------------------------------------------------------------------
-- 2. Helper functions
--
-- SECURITY DEFINER + STABLE means the function runs as the function owner
-- (the postgres / supabase_admin role) and is cacheable per query. This
-- bypasses any RLS on user_profiles when resolving the lookup, so even a
-- restrictive user_profiles policy doesn't break the helpers.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.couple_user_wedding_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT wedding_id
    FROM public.user_profiles
   WHERE id = auth.uid()
     AND role = 'couple'
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.couple_user_venue_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT venue_id
    FROM public.user_profiles
   WHERE id = auth.uid()
     AND role = 'couple'
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.couple_user_wedding_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.couple_user_wedding_id() TO authenticated;

REVOKE ALL ON FUNCTION public.couple_user_venue_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.couple_user_venue_id() TO authenticated;

COMMENT ON FUNCTION public.couple_user_wedding_id() IS
  'Resolves the calling auth user''s wedding_id when role=couple. Returns NULL for non-couple users. Used in couple_read RLS predicates.';

-- ----------------------------------------------------------------------------
-- 3. couple_read policies on wedding_id-scoped tables
--
-- Walks every public table that has a wedding_id column and adds (or
-- replaces) a `couple_read` policy gating SELECT to authenticated couples
-- whose user_profile.wedding_id matches the row.
-- ----------------------------------------------------------------------------

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'wedding_id'
      AND c.table_name NOT IN (
        -- Coordinator-internal: do NOT expose to couples.
        -- 2026-05-07 (round-7 audit): added attribution_parity_log,
        -- booked_data_recovery_log, event_feedback*, after they were
        -- caught leaking via the original list. Long-term direction is
        -- to invert this to an opt-in allowlist; for now the list is
        -- maintained additively. Mig 228 dropped the leaked policies
        -- on already-applied schemas.
        'gmail_connections',
        'gmail_tokens',
        'team_invitations',
        'drafts',                  -- AI draft outbox; coordinator surface
        'interactions',            -- email/SMS audit trail; coordinator
        'engagement_events',       -- behavioural signals; coordinator
        'lead_score_history',      -- internal scoring; coordinator
        'lost_deals',              -- internal pipeline; coordinator
        'admin_notifications',     -- coordinator notifs
        'planning_notes',          -- AI-extracted notes; coordinator
        'activity_log',            -- audit log; coordinator
        'wedding_journey_narratives', -- internal narrative
        'attribution_events',      -- internal attribution
        'attribution_parity_log',  -- internal attribution scoring (round-7)
        'candidate_identities',    -- internal identity resolution
        'wedding_touchpoints',     -- internal multi-touch
        'voice_training_responses', -- internal voice DNA
        're_engagement_actions',   -- internal winback
        'follow_up_sequences',     -- internal cron sequences
        'identity_reconciliation_log',
        'web_form_submissions',
        'storefront_analytics',
        'booked_data_recovery_log', -- internal recovery audit (round-7)
        'event_feedback',          -- internal post-event feedback (round-7)
        'event_feedback_vendors'   -- internal vendor scoring (round-7)
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "couple_read" ON public.%I', t.table_name);
    EXECUTE format($p$CREATE POLICY "couple_read" ON public.%I
      FOR SELECT TO authenticated
      USING (wedding_id = public.couple_user_wedding_id())$p$, t.table_name);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 4. couple_read policies on the venue_id-scoped tables couples need
--
-- These are the venue-scoped tables that couple-portal pages legitimately
-- read for branding / Sage persona / package catalog. Anything else stays
-- coordinator-only.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "couple_read" ON public.venue_config;
CREATE POLICY "couple_read" ON public.venue_config
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.venue_ai_config;
CREATE POLICY "couple_read" ON public.venue_ai_config
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.packages;
CREATE POLICY "couple_read" ON public.packages
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.venues;
CREATE POLICY "couple_read" ON public.venues
  FOR SELECT TO authenticated
  USING (id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.weddings;
CREATE POLICY "couple_read" ON public.weddings
  FOR SELECT TO authenticated
  USING (id = public.couple_user_wedding_id());

-- knowledge_base is venue-scoped and couples need to read it for Sage
-- to surface answers + for the resources page.
DROP POLICY IF EXISTS "couple_read" ON public.knowledge_base;
CREATE POLICY "couple_read" ON public.knowledge_base
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

-- vendor_recommendations: venue-scoped catalog the couple-portal
-- preferred-vendors page surfaces.
DROP POLICY IF EXISTS "couple_read" ON public.vendor_recommendations;
CREATE POLICY "couple_read" ON public.vendor_recommendations
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

-- inspo_gallery / borrow_catalog / venue_assets / venue_resources:
-- venue-scoped, couple-portal pages display.
DROP POLICY IF EXISTS "couple_read" ON public.inspo_gallery;
CREATE POLICY "couple_read" ON public.inspo_gallery
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.borrow_catalog;
CREATE POLICY "couple_read" ON public.borrow_catalog
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.venue_assets;
CREATE POLICY "couple_read" ON public.venue_assets
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.venue_resources;
CREATE POLICY "couple_read" ON public.venue_resources
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.bar_recipes;
CREATE POLICY "couple_read" ON public.bar_recipes
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

DROP POLICY IF EXISTS "couple_read" ON public.portal_section_config;
CREATE POLICY "couple_read" ON public.portal_section_config
  FOR SELECT TO authenticated
  USING (venue_id = public.couple_user_venue_id());

-- ----------------------------------------------------------------------------
-- 5. couple_write policies
--
-- Couples can write to a curated subset of wedding-scoped tables. Each
-- gate enforces TWO predicates: wedding_id matches their user_profile,
-- AND the calling user's role is 'couple' (defense-in-depth — a future
-- bug that lets a coordinator user_profile pick up a wedding_id field
-- shouldn't accidentally let them write through couple paths).
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_table text;
  v_has_wedding boolean;
  v_tables text[] := ARRAY[
    -- The wedding_id-scoped tables couples are expected to write.
    -- Mirror the surface area mig 147 grants to demo anon, minus
    -- coordinator-internal tables.
    --
    -- 2026-05-07 fixup: not every table in this list actually has
    -- wedding_id. guest_tag_assignments uses guest_id → guest_list.
    -- The DO block now checks information_schema before writing the
    -- policy and skips tables without wedding_id (handled below the
    -- loop with explicit per-table policies).
    'checklist_items',
    'guest_list',
    'seating_tables',
    'seating_assignments',
    'sage_conversations',
    'contracts',
    'messages',
    'timeline',
    'onboarding_progress',
    'wedding_website_settings',
    'budget_items',
    'budget_payments',
    'wedding_config',
    'couple_budget',
    'guest_meal_options',
    'guest_tags',
    'guest_tag_assignments',
    'bar_planning',
    'bar_shopping_list',
    'decor_inventory',
    'bedroom_assignments',
    'shuttle_schedule',
    'guest_care_notes',
    'staffing_assignments',
    'wedding_details',
    'wedding_tables',
    'wedding_party',
    'ceremony_order',
    'makeup_schedule',
    'rehearsal_dinner',
    'wedding_worksheets',
    'photo_library',
    'borrow_selections',
    'accommodations',
    'allergy_registry',
    'rsvp_config',
    'rsvp_responses',
    'section_finalisations',
    'booked_vendors'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_table
    ) THEN
      RAISE NOTICE '[226] Skipping non-existent table: %', v_table;
      CONTINUE;
    END IF;

    -- 2026-05-07 fix: column-existence check. Tables that join via a
    -- different FK (guest_tag_assignments → guest_list, etc.) can't
    -- use the simple wedding_id predicate; they get an explicit
    -- policy block below the loop.
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = v_table
         AND column_name = 'wedding_id'
    ) INTO v_has_wedding;

    IF NOT v_has_wedding THEN
      RAISE NOTICE '[226] Skipping % (no wedding_id column; needs custom policy)', v_table;
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS "couple_insert" ON public.%I', v_table);
    EXECUTE format($p$CREATE POLICY "couple_insert" ON public.%I
      FOR INSERT TO authenticated
      WITH CHECK (
        wedding_id = public.couple_user_wedding_id()
        AND EXISTS (
          SELECT 1 FROM public.user_profiles
           WHERE id = auth.uid() AND role = 'couple'
        )
      )$p$, v_table);

    EXECUTE format('DROP POLICY IF EXISTS "couple_update" ON public.%I', v_table);
    EXECUTE format($p$CREATE POLICY "couple_update" ON public.%I
      FOR UPDATE TO authenticated
      USING (
        wedding_id = public.couple_user_wedding_id()
        AND EXISTS (
          SELECT 1 FROM public.user_profiles
           WHERE id = auth.uid() AND role = 'couple'
        )
      )
      WITH CHECK (
        wedding_id = public.couple_user_wedding_id()
        AND EXISTS (
          SELECT 1 FROM public.user_profiles
           WHERE id = auth.uid() AND role = 'couple'
        )
      )$p$, v_table);

    EXECUTE format('DROP POLICY IF EXISTS "couple_delete" ON public.%I', v_table);
    EXECUTE format($p$CREATE POLICY "couple_delete" ON public.%I
      FOR DELETE TO authenticated
      USING (
        wedding_id = public.couple_user_wedding_id()
        AND EXISTS (
          SELECT 1 FROM public.user_profiles
           WHERE id = auth.uid() AND role = 'couple'
        )
      )$p$, v_table);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 5b. Tables without wedding_id — explicit policies via FK join.
--
-- guest_tag_assignments: many-to-many join between guest_list (which
-- carries wedding_id) and guest_tags. Couples write to this table when
-- they tag guests; gate on guest_id → guest_list.wedding_id.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "couple_read" ON public.guest_tag_assignments;
CREATE POLICY "couple_read" ON public.guest_tag_assignments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.guest_list g
       WHERE g.id = guest_tag_assignments.guest_id
         AND g.wedding_id = public.couple_user_wedding_id()
    )
  );

DROP POLICY IF EXISTS "couple_insert" ON public.guest_tag_assignments;
CREATE POLICY "couple_insert" ON public.guest_tag_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.guest_list g
       WHERE g.id = guest_tag_assignments.guest_id
         AND g.wedding_id = public.couple_user_wedding_id()
    )
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
       WHERE id = auth.uid() AND role = 'couple'
    )
  );

DROP POLICY IF EXISTS "couple_delete" ON public.guest_tag_assignments;
CREATE POLICY "couple_delete" ON public.guest_tag_assignments
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.guest_list g
       WHERE g.id = guest_tag_assignments.guest_id
         AND g.wedding_id = public.couple_user_wedding_id()
    )
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
       WHERE id = auth.uid() AND role = 'couple'
    )
  );

-- ----------------------------------------------------------------------------
-- 6. people table — wedding-scoped, but couples need to read AND update
-- (their own contact info, partner names, etc.).
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "couple_read" ON public.people;
CREATE POLICY "couple_read" ON public.people
  FOR SELECT TO authenticated
  USING (wedding_id = public.couple_user_wedding_id());

DROP POLICY IF EXISTS "couple_update" ON public.people;
CREATE POLICY "couple_update" ON public.people
  FOR UPDATE TO authenticated
  USING (
    wedding_id = public.couple_user_wedding_id()
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
       WHERE id = auth.uid() AND role = 'couple'
    )
  )
  WITH CHECK (
    wedding_id = public.couple_user_wedding_id()
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
       WHERE id = auth.uid() AND role = 'couple'
    )
  );

-- ----------------------------------------------------------------------------
-- 7. Verification: list the couple_read / couple_write policies created.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_read_count int;
  v_write_count int;
BEGIN
  SELECT COUNT(*) INTO v_read_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname = 'couple_read';

  SELECT COUNT(*) INTO v_write_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('couple_insert', 'couple_update', 'couple_delete');

  RAISE NOTICE '[226] couple_read policies: %', v_read_count;
  RAISE NOTICE '[226] couple_insert/update/delete policies: %', v_write_count;
END $$;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 227_auto_send_shadow_mode.sql
-- ============================================================================
-- ============================================================================
-- 227: AUTO-SEND SHADOW MODE (Tier-B #67A)
--
-- Lets a venue's auto-send rule observe its OWN behaviour for a probationary
-- period before going live. While shadow_mode=true, checkAutoSendEligible
-- runs the full decision chain BUT records the result in
-- auto_send_shadow_decisions instead of firing. The coordinator reviews
-- the log and promotes the rule to live with one click once they've
-- watched N consecutive correct calls.
--
-- Defaults:
--   - New rules: shadow_mode = true, enabled = true. The combination
--     means "the rule is configured but it's only watching, not firing."
--   - Existing rows: shadow_mode = false (preserves current behaviour).
--   - When enabled = false, shadow_mode is irrelevant (rule is fully off).
--
-- Promotion is a single UPDATE: shadow_mode = false. No data migration.
-- ============================================================================

ALTER TABLE public.auto_send_rules
  ADD COLUMN IF NOT EXISTS shadow_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shadow_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS graduated_at timestamptz,
  ADD COLUMN IF NOT EXISTS graduated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.auto_send_rules.shadow_mode IS
  'When true, the eligibility decision is computed and logged to auto_send_shadow_decisions but the draft is NOT actually sent. Coordinator promotes to live by setting shadow_mode=false. Default false on existing rows so legacy behaviour is preserved; new rules default true via application code (so onboarding gets a probationary period).';

COMMENT ON COLUMN public.auto_send_rules.shadow_started_at IS
  'Timestamp when shadow_mode was last set true. Used by the review UI to age the shadow log ("watching for 3 days").';

COMMENT ON COLUMN public.auto_send_rules.graduated_at IS
  'Timestamp when shadow_mode was set false (promoted to live). NULL for rules that never shadowed.';

COMMENT ON COLUMN public.auto_send_rules.graduated_by IS
  'user_profiles.id of the coordinator who promoted the rule. NULL for legacy auto-graduated rules or service-role flips.';

-- ============================================================================
-- auto_send_shadow_decisions: log of eligibility decisions while shadow
--
-- One row per call to checkAutoSendEligible while the matching rule is in
-- shadow_mode. Captures the decision the rule WOULD have made so the
-- coordinator can review accuracy before promoting.
--
-- Includes the full decision-input snapshot so retro analysis is possible
-- ("the rule said eligible at confidence 0.78; was that right?"). Inputs
-- are intentionally denormalised — joining back to the source draft would
-- be cleaner but couples might be deleted before review.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.auto_send_shadow_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.auto_send_rules(id) ON DELETE SET NULL,
  draft_id uuid REFERENCES public.drafts(id) ON DELETE SET NULL,
  wedding_id uuid REFERENCES public.weddings(id) ON DELETE SET NULL,
  thread_id text,

  -- Decision snapshot
  context_type text NOT NULL,
  source text,
  confidence_score numeric NOT NULL,
  injection_suspected boolean NOT NULL DEFAULT false,
  would_have_sent boolean NOT NULL,
  reason text NOT NULL,

  -- Coordinator review
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  review_verdict text CHECK (review_verdict IS NULL OR review_verdict IN ('correct', 'wrong_send', 'wrong_block')),
  review_note text,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_decisions_venue_created
  ON public.auto_send_shadow_decisions(venue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_decisions_rule
  ON public.auto_send_shadow_decisions(rule_id);
CREATE INDEX IF NOT EXISTS idx_shadow_decisions_unreviewed
  ON public.auto_send_shadow_decisions(venue_id, reviewed_at)
  WHERE reviewed_at IS NULL;

COMMENT ON TABLE public.auto_send_shadow_decisions IS
  'Log of auto-send eligibility decisions made while the matching auto_send_rule was in shadow_mode. Coordinator reviews and approves/rejects each decision via /agent/auto-send-shadow before promoting the rule. INV: writes only when shadow_mode=true.';

COMMENT ON COLUMN public.auto_send_shadow_decisions.would_have_sent IS
  'TRUE if the eligibility chain decided the draft was eligible to auto-send. FALSE if any gate (cost-ceiling, direction, injection, rule-disabled, threshold, thread-cap, daily-cap, require-new-contact) blocked. The reason column carries the specific gate that fired.';

COMMENT ON COLUMN public.auto_send_shadow_decisions.review_verdict IS
  'correct=coordinator agrees with the decision. wrong_send=rule said eligible but the coordinator would not have sent. wrong_block=rule said ineligible but the coordinator wishes it had sent. Drives the "ready to graduate" heuristic.';

-- ============================================================================
-- RLS — venue-scoped reads/writes for coordinators; service-role inserts.
-- ============================================================================

ALTER TABLE public.auto_send_shadow_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_isolation" ON public.auto_send_shadow_decisions;
CREATE POLICY "venue_isolation" ON public.auto_send_shadow_decisions
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "super_admin_bypass" ON public.auto_send_shadow_decisions;
CREATE POLICY "super_admin_bypass" ON public.auto_send_shadow_decisions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ▶ 228_couple_rls_exclusion_fixes.sql
-- ============================================================================
-- ============================================================================
-- 228: COUPLE-RLS EXCLUSION FIXES + assigned_to length cap
--
-- Round-7 bandaid audit caught two real issues that ship in this migration:
--
-- ## 1. Coordinator-internal tables leaked via mig 226 couple_read
--
-- Mig 226 walks `information_schema.columns WHERE column_name='wedding_id'`
-- and excludes a hardcoded list of coordinator-internal tables. The list
-- missed four tables that DO carry wedding_id but are internal:
--   - attribution_parity_log     (mig 192) — internal attribution scoring
--   - booked_data_recovery_log   (mig 201) — internal recovery audit
--   - event_feedback             (mig 043) — internal post-event feedback
--   - event_feedback_vendors     (mig 043) — internal vendor scoring
--
-- These got `couple_read` SELECT policies applied. Couples post-mig-226
-- can read all four. Drop the policies. Mig 226 source is also updated
-- so future re-runs against fresh schemas don't re-create them.
--
-- Inverting the rule to opt-in allowlist (audit recommendation #3) is
-- the right long-term shape but a bigger change; deferred. For now the
-- exclusion list grows.
--
-- ## 2. assigned_to length cap was JS-only
--
-- Mig 224 added checklist_items.assigned_to as unbounded TEXT. Round-6
-- noted this and the client capped at 80 chars in handleSetAssignedTo,
-- but anyone with service-role / Studio / a bypassed client could still
-- write 100KB. Add the CHECK at the schema level.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Drop couple_read policies on coordinator-internal tables
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "couple_read" ON public.attribution_parity_log;
DROP POLICY IF EXISTS "couple_read" ON public.booked_data_recovery_log;
DROP POLICY IF EXISTS "couple_read" ON public.event_feedback;
DROP POLICY IF EXISTS "couple_read" ON public.event_feedback_vendors;

-- Also drop any couple_write policies that landed (the write loop only
-- runs against an explicit v_tables list which doesn't include these,
-- but DROP IF EXISTS is idempotent so this catches future drift).
DROP POLICY IF EXISTS "couple_insert" ON public.attribution_parity_log;
DROP POLICY IF EXISTS "couple_update" ON public.attribution_parity_log;
DROP POLICY IF EXISTS "couple_delete" ON public.attribution_parity_log;
DROP POLICY IF EXISTS "couple_insert" ON public.booked_data_recovery_log;
DROP POLICY IF EXISTS "couple_update" ON public.booked_data_recovery_log;
DROP POLICY IF EXISTS "couple_delete" ON public.booked_data_recovery_log;
DROP POLICY IF EXISTS "couple_insert" ON public.event_feedback;
DROP POLICY IF EXISTS "couple_update" ON public.event_feedback;
DROP POLICY IF EXISTS "couple_delete" ON public.event_feedback;
DROP POLICY IF EXISTS "couple_insert" ON public.event_feedback_vendors;
DROP POLICY IF EXISTS "couple_update" ON public.event_feedback_vendors;
DROP POLICY IF EXISTS "couple_delete" ON public.event_feedback_vendors;

-- ----------------------------------------------------------------------------
-- 2. Length CHECK on checklist_items.assigned_to
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
     WHERE table_schema = 'public'
       AND table_name = 'checklist_items'
       AND constraint_name = 'checklist_items_assigned_to_length'
  ) THEN
    ALTER TABLE public.checklist_items
      ADD CONSTRAINT checklist_items_assigned_to_length
      CHECK (assigned_to IS NULL OR char_length(assigned_to) <= 80);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Verification
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_remaining int;
  v_row record;
BEGIN
  SELECT COUNT(*) INTO v_remaining
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('couple_read', 'couple_insert', 'couple_update', 'couple_delete')
     AND tablename IN (
       'attribution_parity_log',
       'booked_data_recovery_log',
       'event_feedback',
       'event_feedback_vendors'
     );

  IF v_remaining > 0 THEN
    RAISE EXCEPTION '[228] Failed to drop all couple policies on coordinator-internal tables (% remain)', v_remaining;
  END IF;

  RAISE NOTICE '[228] Coordinator-internal tables now have zero couple policies';
END $$;

NOTIFY pgrst, 'reload schema';
