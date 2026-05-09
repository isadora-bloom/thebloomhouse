-- ---------------------------------------------------------------------------
-- 255_identity_evidence_phase1.sql
-- ---------------------------------------------------------------------------
-- Identity-capture redesign — Phase 1: schema only, additive, no behavior
-- change. Companion to IDENTITY-CAPTURE-DESIGN.md (committed 2026-05-09).
--
-- Why this exists
-- ---------------
-- Today the pipeline writes `people.first_name` / `people.last_name`
-- whichever way the first signal happened to land — Knot relay From-name,
-- email handle parse, calculator form, contract signer. There is no
-- concept of "evidence." The same column carries Knot proxy IDs (`User
-- 89436314x...`), platform usernames (`Erinhorrigan`, `Mconn`), partial
-- names (`Jen B`), and full legal names (`Jennifer Biaksangi`) with no
-- way to know which is best. Once junk lands, every subsequent fix has
-- to fight the existing column instead of the underlying evidence.
--
-- The redesign treats identity as **forensic evidence** per the Bloom
-- Constitution thesis. Every name claim ever observed is stored; the
-- displayed `first_name`/`last_name` are a *picked* projection. Username-
-- shaped values land in `display_handle` instead of `first_name`. Family
-- and planner mentions go to `wedding_relationships` so they stop
-- becoming `partner2` by accident. Emotional truths and preferences
-- ("my mum is sick", "we don't like flowers") are first-class signals
-- on the same evidence model — see wedding_auto_context.sensitive +
-- expires_at additions below.
--
-- Phase 1 scope: SCHEMA ONLY.
--   - Add columns + tables
--   - No data migration
--   - No code changes
--   - Existing first_name / last_name columns stay populated by current
--     code; the new evidence columns sit alongside, untouched, until
--     Phase 2 wires the capture chokepoint
--
-- Idempotent: every ADD COLUMN / CREATE TABLE / CREATE POLICY uses
-- IF NOT EXISTS or DROP-then-CREATE. Safe to re-run.
--
-- Pre-allocates migration slot 255. Latest is 254.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — people.name_evidence + display_handle + name_confidence
-- ============================================================================
-- name_evidence: append-only log of every name claim observed for this
--   person. Shape:
--   [
--     { "source": "gmail_from_name",   "value": { "first": "Jen", "last": "B" }, "confidence": 30, "captured_at": "2026-04-21T11:44:00Z", "interaction_id": "..." },
--     { "source": "calculator_form",   "value": { "first": "Jennifer", "last": "Biaksangi" }, "confidence": 95, "captured_at": "2026-04-21T14:09:00Z", "interaction_id": "..." },
--     { "source": "contract_signer",   "value": { "first": "Jennifer", "last": "Biaksangi" }, "confidence": 98, "captured_at": "2026-05-02T10:00:00Z", "interaction_id": null }
--   ]
-- The legacy first_name / last_name columns become the *picker output*
-- once Phase 2 ships. Phase 1 just stores the column; nothing reads it
-- yet.
--
-- display_handle: platform-username-shaped values that should NEVER be
-- stored as first_name. Knot proxy IDs, Pinterest usernames, concatenated
-- handles ("Erinhorrigan", "Mconn"). Coordinator UI surfaces this under
-- the name as small print ("Knot: rosaliehoyle") so search-by-handle
-- works.
--
-- name_confidence: 0-100 score of the picker's chosen display.
--   100 = coordinator-typed
--   95+ = contract / calculator form
--   70 = email signature / brain-dump confirmed
--   30-50 = Gmail From-name with real-name shape
--   <20 = email handle parse / weak inference. Below threshold the
--   coordinator UI surfaces "(unverified)".

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS name_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.people.name_evidence IS
  'Append-only log of every name claim observed for this person. '
  'Shape per entry: {source, value:{first,last}, confidence:0-100, '
  'captured_at, interaction_id?}. The picker (lib/services/identity/'
  'name-picker.ts, Phase 2) projects this into the display first_name '
  '/ last_name columns. Coordinator overrides land here as confidence-100 '
  'evidence rows. Migration 255.';

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS display_handle text;

COMMENT ON COLUMN public.people.display_handle IS
  'Platform username / handle shape that should never be stored as '
  'first_name. Knot proxy IDs ("User <hex>"), Pinterest handles '
  '("rosaliehoyle"), concatenated lowercase smushes ("erinhorrigan", '
  '"mconn"). Coordinator UI surfaces this as small print under the '
  'picked display name so search-by-handle finds the lead. Migration 255.';

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS name_confidence smallint;

COMMENT ON COLUMN public.people.name_confidence IS
  'Picker confidence (0-100) for the current first_name + last_name. '
  'NULL when no evidence has been captured. <40 = "(unverified)" badge '
  'in the coordinator UI. Computed by Phase 2 picker; Phase 1 leaves '
  'NULL. Migration 255.';

-- ============================================================================
-- STEP 2 — people.platform_handles
-- ============================================================================
-- Per-platform handle map. Lets the resolver match the same person across
-- platforms when a Pinterest handle and a Knot handle and an Instagram
-- handle all converge. Shape:
--   {
--     "pinterest":   "rosaliehoyle",
--     "knot":        "rosalie_hoyle_92",
--     "weddingwire": "rosaliehoyle1",
--     "instagram":   "rosie.hoyle",
--     "tiktok":      null,
--     "facebook":    null
--   }
-- Coordinator UI shows the full collection on lead profile. Pattern-
-- matched across new arrivals so duplicate IDs trigger merge candidates
-- automatically (Phase 4).

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS platform_handles jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.people.platform_handles IS
  'Per-platform handle map (pinterest, knot, weddingwire, instagram, '
  'tiktok, facebook, twitter, etc). Coordinator UI surfaces all known '
  'handles on lead profile. Resolver uses cross-platform handle match '
  'as a same-person signal in Phase 4. Migration 255.';

-- ============================================================================
-- STEP 3 — people.partner_role_kind
-- ============================================================================
-- Distinguishes real partner2 ("Sarah Olkowski-Smith with own email") from
-- phantom partner2 (LLM extracted "Brett" from a sign-off when partner1
-- is "Brett Smith") so Sage prompts know how to address the couple.
-- Q3 decision (Isadora 2026-05-09): drop partner2 + flag partner_count=1
-- on weddings rather than keep an is_phantom row.
-- This column documents the per-person role with more granularity than
-- the existing people.role enum (which has 'partner1', 'partner2',
-- 'guest', 'wedding_party', 'vendor', 'family', 'parent').

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS partner_role_kind text;

COMMENT ON COLUMN public.people.partner_role_kind IS
  'Sub-classification when role IN (partner1, partner2). Values: '
  'real | phantom (LLM-extracted from sender sign-off, no own email/'
  'phone, never replies to drafts). Phantom rows are deprecated by '
  'Phase 4 — replaced with weddings.partner_count=1 — but the column '
  'lets us tag historical rows during the transition. Migration 255.';

-- ============================================================================
-- STEP 4 — weddings.partner_count
-- ============================================================================
-- Q3 decision: when phantom partner2 detected ("Brett & Brett",
-- "Hannah Lord & Hannah Lord"), drop partner2 and stamp
-- partner_count=1 so Sage prompts know to address one person.
-- NULL by default = unknown (legacy row, predates this migration).

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS partner_count smallint;

COMMENT ON COLUMN public.weddings.partner_count IS
  'Number of decision-making partners (1 or 2). NULL = unknown / legacy. '
  'Stamped 1 when the phantom-partner detector finds a partner2 that '
  'duplicates partner1''s first name with no last name and no own contact '
  'info. Stamped 2 when both partners have independent identity signal. '
  'Drives Sage prompt: "writing to Brett" vs "writing to Brett and '
  'Sarah". Migration 255 (Q3 decision 2026-05-09).';

-- ============================================================================
-- STEP 5 — wedding_relationships table
-- ============================================================================
-- Family / planner / mother-in-law / sibling / "the bride's mom" mentions
-- that today get captured as people.role='partner2' by accident. This
-- table is their proper home: structured non-partner humans associated
-- with a wedding.
--
-- Distinction from people:
--   - people = humans we have direct identity for (own email/phone, can
--     auth into couple portal, replies become interactions)
--   - wedding_relationships = humans MENTIONED in correspondence but
--     not directly contactable. Names, roles, and notes only.
--
-- Q4 decision (Isadora 2026-05-09): Phase 1 ships storage. Coordinator-
-- visible read panel ships in Phase 5 UI polish. Sage prompt feed (the
-- "C" option from Q4) is a Phase 5 polish itself — the agent draft can
-- accidentally address a family member if Sage knows their name without
-- a confirmed-by-coordinator gate.

CREATE TABLE IF NOT EXISTS public.wedding_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  relationship_role text NOT NULL,  -- 'mother' | 'father' | 'mother_in_law' | 'father_in_law' | 'sibling' | 'planner' | 'maid_of_honor' | 'best_man' | 'family_friend' | 'vendor_contact' | 'other'
  detail text,                       -- "of the bride", "groom's stepfather", etc.
  email text,                        -- when known; usually NULL
  phone text,                        -- when known
  source text NOT NULL,              -- 'ai_email_extraction' | 'coordinator_added' | 'csv_import' | 'tour_transcript'
  source_interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL,
  confidence smallint,               -- 0-100; NULL for coordinator_added
  is_active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  archived_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  added_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wedding_relationships IS
  'owner:agent+portal. Non-partner humans associated with a wedding — '
  'family, planner, MOH, vendor contacts, "the bride''s mom". Today these '
  'land as people.role=partner2 by mistake (LLM extracts from email body, '
  '"Hi from Carrie (mother of the bride)" becomes partner2). This table '
  'is their proper home: structured roles, AI confidence, coordinator '
  'override. Q4 decision (Isadora 2026-05-09): Phase 1 storage; Phase 5 '
  'coordinator read panel; Phase 5 polish for Sage prompt feed. '
  'Migration 255.';

COMMENT ON COLUMN public.wedding_relationships.relationship_role IS
  'Structured role label. Values: mother | father | mother_in_law | '
  'father_in_law | sibling | planner | maid_of_honor | best_man | '
  'family_friend | vendor_contact | other. Free-text detail in the '
  '"detail" column for nuance ("groom''s stepmother", "bride''s aunt '
  'who is paying").';

CREATE INDEX IF NOT EXISTS idx_wedding_relationships_wedding_active
  ON public.wedding_relationships (wedding_id, created_at DESC)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_wedding_relationships_venue_active
  ON public.wedding_relationships (venue_id, created_at DESC)
  WHERE is_active = true;

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_wedding_relationships_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wedding_relationships_touch ON public.wedding_relationships;
CREATE TRIGGER trg_wedding_relationships_touch
  BEFORE UPDATE ON public.wedding_relationships
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_wedding_relationships_updated_at();

-- RLS — same shape as wedding_auto_context (mig 253).
ALTER TABLE public.wedding_relationships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wedding_relationships_auth_select" ON public.wedding_relationships;
CREATE POLICY "wedding_relationships_auth_select"
  ON public.wedding_relationships
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "wedding_relationships_auth_insert" ON public.wedding_relationships;
CREATE POLICY "wedding_relationships_auth_insert"
  ON public.wedding_relationships
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "wedding_relationships_auth_update" ON public.wedding_relationships;
CREATE POLICY "wedding_relationships_auth_update"
  ON public.wedding_relationships
  FOR UPDATE
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  )
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

-- ============================================================================
-- STEP 6 — wedding_auto_context.sensitive + expires_at
-- ============================================================================
-- Emotional truths ("my mum is sick", "stressful job interview", "we lost
-- my grandmother last week") need handling rules different from facts:
--   - sensitive=true: never quoted verbatim by Sage in couple-facing
--     drafts. The brain prompt sees them but the prompt rules forbid
--     direct quotation. Coordinator UI shows a "do not echo" badge.
--   - expires_at: TTL for time-bound truths. "Mom is sick" is true for
--     12 months unless reinforced or pinned. After expiry the row stays
--     in the database (Constitution invariant — never delete) but drops
--     out of the active-context feed.
--
-- 2026-05-09 Isadora directive: capture emotional truths alongside facts.
-- The category was already free-text in mig 253; this adds the two
-- handling-rule columns the brain prompt needs.

ALTER TABLE public.wedding_auto_context
  ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.wedding_auto_context.sensitive IS
  'When true, the brain prompt sees this note in context but is '
  'forbidden from quoting it verbatim. Coordinator UI shows a "do not '
  'echo" badge. Categories that auto-flag sensitive=true: health, grief, '
  'financial_stress, family_conflict, mental_health. Coordinator may '
  'override either way. Migration 255.';

ALTER TABLE public.wedding_auto_context
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMENT ON COLUMN public.wedding_auto_context.expires_at IS
  'TTL for time-bound emotional truths. "Mom is sick" defaults to 12 '
  'months from captured_at unless reinforced or pinned. NULL = no TTL '
  '(default for facts, preferences, family roles). After expiry the row '
  'stays in the DB (Constitution: never delete) but drops out of the '
  'active-context feed surfaced to Sage and the coordinator. Re-detection '
  'of the same body within the dedup window resets expires_at to a new '
  '12-month window. Migration 255.';

-- ============================================================================
-- STEP 7 — partial index on active non-expired auto-context
-- ============================================================================
-- Hot-path index for the brain context loaders + lead-profile feed: only
-- active (is_active=true) non-expired (expires_at IS NULL OR > now())
-- notes participate. Postgres can't use now() in a partial-index predicate
-- (it's not immutable), so the partial filter is just is_active; the
-- expires_at filter happens in the WHERE clause at read time.

CREATE INDEX IF NOT EXISTS idx_wedding_auto_context_sensitive
  ON public.wedding_auto_context (wedding_id)
  WHERE is_active = true AND sensitive = true;

COMMENT ON INDEX public.idx_wedding_auto_context_sensitive IS
  'Sensitive-only fast lookup for the "do not echo" badge feed. Brain '
  'context loaders may want to see sensitive notes in their own pass for '
  'tone-only handling. Migration 255.';

COMMIT;

NOTIFY pgrst, 'reload schema';
