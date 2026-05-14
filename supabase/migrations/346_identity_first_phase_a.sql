-- ---------------------------------------------------------------------------
-- 346_identity_first_phase_a.sql
-- ---------------------------------------------------------------------------
-- Phase A of the Identity-First Architecture migration.
-- Anchor: IDENTITY-FIRST-ARCHITECTURE.md (canonical doctrine) +
--         memory/bloom-identity-first-doctrine.md (summary).
--
-- Naming note (one decision the doctrine left implicit)
-- ------------------------------------------------------
-- The doctrine names the entity table `persons` (Person = the couple).
-- Bloom House already has a `people` table for individual humans
-- (partner1 / partner2 / guest), so naming a second table `persons` would
-- collide for every engineer reading the codebase. The repo uses
-- `couples` for the doctrine's Person table; the doctrine prose name
-- ("Person (Resolved)") is preserved in product copy + class talk but
-- never appears as a SQL identifier.
--
-- Mapping (doctrine → repo):
--   persons                     → couples
--   agent_person_links          → agent_couple_links
--   person_merge_events         → couple_merge_events
--   person_progression_events   → couple_progression_events
--   touchpoints / fragments / candidate_matches / tracer_run_events
--                               → unchanged (no collision)
--   FK columns named person_id  → couple_id (and agent_id stays as agent_id;
--                                  agents live in couples with lifecycle_state='agent').
--
-- Phase A scope (per IDENTITY-FIRST-ARCHITECTURE.md §8)
-- ----------------------------------------------------
--   1. Tables created (this file).
--   2. Indexes + RLS (this file).
--   3. Backfill of existing weddings → couples (this file, bottom).
--   4. Dual-write hooks (mintWedding) — TypeScript change, separate file.
--   5. Divergence dashboard — a new route + service, separate from this migration.
--
-- Does NOT include any read-path migration. Legacy code keeps reading
-- from weddings / people / interactions. The couples table is a
-- write-shadow until Phase D migrates each intelligence feature one PR
-- at a time.
--
-- Migration-rerun safety
-- ----------------------
-- §1 'Don't skip' #4 + Appendix B stop condition #1 require Phase A to
-- be re-runnable. Every CREATE uses IF NOT EXISTS; every DROP POLICY
-- uses IF EXISTS; the backfill block is ON CONFLICT DO NOTHING keyed on
-- a synthesised source_wedding_id column that pins the relationship to
-- the originating wedding row.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. couples — the entity table. One row = one couple (or one agent).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS couples (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id                    uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,

  -- Identity fields. primary_* required at 'resolved' / 'booked' /
  -- 'agent' tier. partner_* may be null even at resolved tier (planner-
  -- on-behalf, parent-on-behalf, single-name CSV row, etc).
  primary_contact_name        text NOT NULL,
  primary_contact_email       text,
  primary_contact_phone       text,
  partner_contact_name        text,
  partner_contact_email       text,
  partner_contact_phone       text,

  wedding_date                date,

  -- Six entity classes from §1. 'fragment' is intentionally NOT in this
  -- enum — fragments live in their own table because they don't
  -- represent a confirmed human and should never appear in couples
  -- list queries by accident.
  lifecycle_state             text NOT NULL CHECK (lifecycle_state IN (
    'channel_scoped',
    'resolved',
    'booked',
    'ghost',
    'agent'
  )),

  -- Which channel this couple is scoped to while lifecycle_state =
  -- 'channel_scoped'. NULL at every other tier.
  channel_scope               text,

  -- Per-venue tunable decay window. Doctrine default 180 days, never
  -- below 90. Check constraint enforces the floor; venue config UI
  -- enforces the soft tunable range later.
  decay_window_days           integer NOT NULL DEFAULT 180
                                CHECK (decay_window_days >= 90),

  -- Last inbound progression event (set by the progression-event
  -- writer in Phase B; Phase A leaves this NULL).
  last_progression_at         timestamptz,

  -- Cached heat score. Recomputed by D1 in Phase D; NULL while
  -- couples is a write-shadow.
  heat_score                  numeric,

  -- Phase A back-reference. Lets the dual-write hook + the backfill
  -- locate the couples row that mirrors a given weddings row without
  -- a name/email join. Drops to advisory in Phase F when weddings
  -- becomes the audit log.
  source_wedding_id           uuid REFERENCES weddings(id) ON DELETE SET NULL,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE couples IS
  'Identity-first entity table. One row = one couple (or one agent at lifecycle_state=agent). '
  'Doctrine name: "Person (Resolved)". Table name is "couples" to avoid collision with the '
  'existing `people` table (which holds individual humans, not couples). '
  'See IDENTITY-FIRST-ARCHITECTURE.md §1.';

COMMENT ON COLUMN couples.source_wedding_id IS
  'Back-pointer to the weddings row this couples row was minted from (Phase A dual-write '
  'or backfill). NULL when minted from a non-wedding signal (a Fragment promotion). '
  'Degrades to advisory in Phase F.';

-- Unique index on (venue_id, source_wedding_id). NOT partial because
-- supabase-js / PostgREST upserts can only target a bare column list,
-- not a predicate. Postgres treats NULLs as distinct so Fragment-
-- promoted couples (source_wedding_id IS NULL) remain unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_couples_source_wedding
  ON couples (venue_id, source_wedding_id);

CREATE INDEX IF NOT EXISTS ix_couples_venue_lifecycle
  ON couples (venue_id, lifecycle_state);

-- Linker email/phone lookups. Partial indexes — exclude NULLs (most
-- couples are partial-identity at channel_scoped tier).
CREATE INDEX IF NOT EXISTS ix_couples_venue_primary_email
  ON couples (venue_id, lower(primary_contact_email))
  WHERE primary_contact_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_couples_venue_partner_email
  ON couples (venue_id, lower(partner_contact_email))
  WHERE partner_contact_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_couples_venue_primary_phone
  ON couples (venue_id, primary_contact_phone)
  WHERE primary_contact_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_couples_venue_partner_phone
  ON couples (venue_id, partner_contact_phone)
  WHERE partner_contact_phone IS NOT NULL;


-- ===========================================================================
-- 2. agent_couple_links — agents represent many couples; couples have agents.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS agent_couple_links (
  agent_id        uuid NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  couple_id       uuid NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  established_at  timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL CHECK (source IN (
    'self_identified',
    'multi_couple_inferred',
    'operator_confirmed'
  )),
  PRIMARY KEY (agent_id, couple_id),
  CHECK (agent_id <> couple_id)
);

COMMENT ON TABLE agent_couple_links IS
  'A planner / parent / coordinator (couples row with lifecycle_state=agent) linked to '
  'the couples they act on behalf of. See IDENTITY-FIRST-ARCHITECTURE.md §1.';

CREATE INDEX IF NOT EXISTS ix_agent_couple_links_couple
  ON agent_couple_links (couple_id);


-- ===========================================================================
-- 3. touchpoints — unified across all channels.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS touchpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id        uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,

  -- Either anchored to a couple, anchored to an agent, or neither
  -- (anchored to a fragment via fragments.promoted_to_couple_id when
  -- promoted, or unanchored entirely). 'on delete set null' is
  -- doctrine §1 'Don't skip' #3 — deleting a couple must NOT orphan
  -- its touchpoints.
  couple_id       uuid REFERENCES couples(id) ON DELETE SET NULL,
  agent_id        uuid REFERENCES couples(id) ON DELETE SET NULL,

  channel         text NOT NULL,                              -- 'gmail' | 'knot' | 'calendly' | 'instagram' | 'sms' | 'web' | 'honeybook' | ...
  signal_tier     text NOT NULL CHECK (signal_tier IN (
    'highest',
    'high',
    'medium_high',
    'medium',
    'low',
    'aggregate_only'
  )),
  action_type     text NOT NULL,                              -- channel-specific verb (reply / view / dm / form_submit / ...)
  external_id     text NOT NULL,                              -- channel-specific dedup key (gmail message id, calendly event_uuid, ...)
  occurred_at     timestamptz NOT NULL,
  confidence_tier text CHECK (confidence_tier IN ('high','medium','low')),
  raw_payload     jsonb,

  -- (channel, external_id) per-venue is the rerun-safety primitive
  -- for Phase B Tracer. Venue scope included so two venues sharing
  -- the same gmail thread (unlikely but allowed) don't collide.
  UNIQUE (venue_id, channel, external_id)
);

COMMENT ON TABLE touchpoints IS
  'Unified per-event log across all channels. One row = one observable signal. '
  'Anchored to a couple OR an agent OR neither (orphan; gets re-evaluated by Tracer). '
  'UNIQUE(venue_id, channel, external_id) makes Tracer re-runs no-ops on the second pass. '
  'See IDENTITY-FIRST-ARCHITECTURE.md §1 + §4.';

CREATE INDEX IF NOT EXISTS ix_touchpoints_couple_time
  ON touchpoints (couple_id, occurred_at DESC)
  WHERE couple_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_touchpoints_agent_time
  ON touchpoints (agent_id, occurred_at DESC)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_touchpoints_venue_channel
  ON touchpoints (venue_id, channel, occurred_at DESC);

-- GIN for ad-hoc raw_payload inspection during operator forensics.
CREATE INDEX IF NOT EXISTS ix_touchpoints_raw_payload_gin
  ON touchpoints USING gin (raw_payload);


-- ===========================================================================
-- 4. fragments — touchpoints without enough identity to anchor.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS fragments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id                uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  channel                 text NOT NULL,
  identity_hint           text,                                -- 'Sarah R.', '@sarahross', null
  external_id             text NOT NULL,
  occurred_at             timestamptz NOT NULL,
  raw_payload             jsonb,

  -- When the matcher promotes a Fragment to a couple, it sets
  -- promoted_to_couple_id and promoted_at. Promotion is one-way
  -- (fragments do not resurrect — §11 invariant 5).
  promoted_to_couple_id   uuid REFERENCES couples(id) ON DELETE SET NULL,
  promoted_at             timestamptz,

  UNIQUE (venue_id, channel, external_id)
);

COMMENT ON TABLE fragments IS
  'Touchpoints with insufficient identity to anchor to any couple. Surfaced only in '
  'aggregate counts ("184 anonymous saves this month"). Fragments NEVER resurrect '
  '(§11 invariant 5). See IDENTITY-FIRST-ARCHITECTURE.md §1.';

CREATE INDEX IF NOT EXISTS ix_fragments_venue_promotion_scan
  ON fragments (venue_id, channel, identity_hint, occurred_at)
  WHERE promoted_to_couple_id IS NULL;

CREATE INDEX IF NOT EXISTS ix_fragments_promoted_to_couple
  ON fragments (promoted_to_couple_id)
  WHERE promoted_to_couple_id IS NOT NULL;


-- ===========================================================================
-- 5. couple_merge_events — audit trail for every merge / unmerge.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS couple_merge_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  event_type          text NOT NULL CHECK (event_type IN (
    'fragment_promoted',
    'channel_scoped_bridged',
    'candidate_confirmed',
    'candidate_rejected',
    'manual_merge',
    'manual_unmerge',
    'resurrection',
    'resurrection_rejected'
  )),
  primary_couple_id   uuid REFERENCES couples(id) ON DELETE SET NULL,
  secondary_couple_id uuid REFERENCES couples(id) ON DELETE SET NULL,
  operator_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rule_triggered      text,
  confidence_tier     text CHECK (confidence_tier IN ('high','medium','low')),
  reason              text,
  occurred_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE couple_merge_events IS
  'Audit log for every identity event: fragment promotion, candidate confirm/reject, '
  'manual merge/unmerge, ghost resurrection. The reason column feeds the calibration '
  'loop (§2 Don''t skip #2). See IDENTITY-FIRST-ARCHITECTURE.md §9.';

CREATE INDEX IF NOT EXISTS ix_couple_merge_events_venue_time
  ON couple_merge_events (venue_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ix_couple_merge_events_primary
  ON couple_merge_events (primary_couple_id, occurred_at DESC)
  WHERE primary_couple_id IS NOT NULL;


-- ===========================================================================
-- 6. couple_progression_events — write-once inbound progression log.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS couple_progression_events (
  couple_id            uuid NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  occurred_at          timestamptz NOT NULL,
  event_type           text NOT NULL CHECK (event_type IN (
    'email_reply',
    'tour_booked',
    'tour_rescheduled',
    'tour_attended',
    'new_channel_inquiry',
    'portal_click',
    'contract_signed',
    'inbound_followup',
    'fragment_match_returned'
  )),
  source_touchpoint_id uuid REFERENCES touchpoints(id) ON DELETE SET NULL,
  PRIMARY KEY (couple_id, occurred_at, event_type)
);

COMMENT ON TABLE couple_progression_events IS
  'Inbound-only progression log. Resets the decay clock. OUTBOUND venue activity is '
  'forbidden from writing here — §3 Don''t skip #1. The progression-event writer must '
  'not be wired from outbound code paths.';

CREATE INDEX IF NOT EXISTS ix_couple_progression_recent
  ON couple_progression_events (couple_id, occurred_at DESC);


-- ===========================================================================
-- 7. candidate_matches — review queue for medium / low tier proposals.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS candidate_matches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id              uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  primary_record_id     uuid NOT NULL,
  primary_record_type   text NOT NULL CHECK (primary_record_type IN (
    'couple','fragment','channel_scoped'
  )),
  secondary_record_id   uuid NOT NULL,
  secondary_record_type text NOT NULL CHECK (secondary_record_type IN (
    'couple','fragment','channel_scoped'
  )),
  confidence_tier       text NOT NULL CHECK (confidence_tier IN ('high','medium','low')),
  matcher_reason        text,                                       -- structured + LLM judge output
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  resolution            text CHECK (resolution IN ('confirmed','rejected','not_sure')),
  resolved_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE candidate_matches IS
  'Operator review queue for medium/low tier matcher proposals. High tier auto-promotes '
  '(§5). Resolutions feed the calibration loop. "not_sure" is a first-class option '
  '(§5 Don''t skip #3). See IDENTITY-FIRST-ARCHITECTURE.md §5 + §2.';

CREATE INDEX IF NOT EXISTS ix_candidate_matches_open_queue
  ON candidate_matches (venue_id, created_at DESC)
  WHERE resolution IS NULL;


-- ===========================================================================
-- 8. tracer_run_events — checkpointing log for the Backwards Tracer.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS tracer_run_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL,                                 -- one Tracer run = many events
  stage         text NOT NULL,                                 -- 'anchor_discovery' | 'touchpoint_sweep' | 'cross_channel_coalesce' | 'agent_infer' | 'decay_sweep' | 'validate'
  status        text NOT NULL CHECK (status IN (
    'started','progress','succeeded','failed','skipped'
  )),
  batch_index   integer,
  rows_seen     integer,
  rows_written  integer,
  detail        jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tracer_run_events IS
  'Per-stage checkpointing log for the Backwards Tracer. A restart resumes from the '
  'last "succeeded" stage rather than running from scratch (§4 Don''t skip #2). Phase A '
  'creates the table; Phase B fills it.';

CREATE INDEX IF NOT EXISTS ix_tracer_run_events_run
  ON tracer_run_events (run_id, occurred_at);

CREATE INDEX IF NOT EXISTS ix_tracer_run_events_venue_recent
  ON tracer_run_events (venue_id, occurred_at DESC);


-- ===========================================================================
-- 9. RLS — mirrors crm_import_rows pattern (mig 335).
-- ===========================================================================
--
-- §10 'Don't skip' #1: every table gets RLS. §1 'Don't skip' #2: the
-- demo-anon variant exists for every table that should be visible in
-- the demo. (Phase A: only couples + touchpoints + fragments are
-- demo-visible — audit / queue tables stay locked.)
-- ---------------------------------------------------------------------------

ALTER TABLE couples                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_couple_links          ENABLE ROW LEVEL SECURITY;
ALTER TABLE touchpoints                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE fragments                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE couple_merge_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE couple_progression_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_matches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracer_run_events           ENABLE ROW LEVEL SECURITY;

-- Explicit per-table policies. The repo convention (mig 335, 304, 290)
-- is one CREATE POLICY block per table per role — clearer than a loop,
-- easier to grep for "who can read couples". Three roles per table:
-- authenticated SELECT, authenticated ALL, service_role ALL. Demo-anon
-- SELECT only on operator-facing tables (couples / touchpoints /
-- fragments).

-- couples ------------------------------------------------------------------
DROP POLICY IF EXISTS "couples_select" ON public.couples;
CREATE POLICY "couples_select" ON public.couples
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "couples_modify" ON public.couples;
CREATE POLICY "couples_modify" ON public.couples
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "couples_service" ON public.couples;
CREATE POLICY "couples_service" ON public.couples
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_couples" ON public.couples;
CREATE POLICY "demo_anon_select_couples" ON public.couples
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- agent_couple_links --------------------------------------------------------
-- Has no venue_id column; both FKs point at couples.id. RLS reaches
-- through couples.venue_id.
DROP POLICY IF EXISTS "agent_couple_links_select" ON public.agent_couple_links;
CREATE POLICY "agent_couple_links_select" ON public.agent_couple_links
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.couples c
      WHERE c.id = agent_couple_links.agent_id
        AND (
          c.venue_id IN (
            SELECT up.venue_id FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
            UNION
            SELECT v.id FROM public.venues v
              JOIN public.user_profiles up ON up.org_id = v.org_id
            WHERE up.id = auth.uid()
          )
          OR public.is_super_admin()
        )
    )
  );

DROP POLICY IF EXISTS "agent_couple_links_modify" ON public.agent_couple_links;
CREATE POLICY "agent_couple_links_modify" ON public.agent_couple_links
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.couples c
      WHERE c.id = agent_couple_links.agent_id
        AND (
          c.venue_id IN (
            SELECT up.venue_id FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
            UNION
            SELECT v.id FROM public.venues v
              JOIN public.user_profiles up ON up.org_id = v.org_id
            WHERE up.id = auth.uid()
          )
          OR public.is_super_admin()
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.couples c
      WHERE c.id = agent_couple_links.agent_id
        AND (
          c.venue_id IN (
            SELECT up.venue_id FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
            UNION
            SELECT v.id FROM public.venues v
              JOIN public.user_profiles up ON up.org_id = v.org_id
            WHERE up.id = auth.uid()
          )
          OR public.is_super_admin()
        )
    )
  );

DROP POLICY IF EXISTS "agent_couple_links_service" ON public.agent_couple_links;
CREATE POLICY "agent_couple_links_service" ON public.agent_couple_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- touchpoints ---------------------------------------------------------------
DROP POLICY IF EXISTS "touchpoints_select" ON public.touchpoints;
CREATE POLICY "touchpoints_select" ON public.touchpoints
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "touchpoints_modify" ON public.touchpoints;
CREATE POLICY "touchpoints_modify" ON public.touchpoints
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "touchpoints_service" ON public.touchpoints;
CREATE POLICY "touchpoints_service" ON public.touchpoints
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_touchpoints" ON public.touchpoints;
CREATE POLICY "demo_anon_select_touchpoints" ON public.touchpoints
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- fragments -----------------------------------------------------------------
DROP POLICY IF EXISTS "fragments_select" ON public.fragments;
CREATE POLICY "fragments_select" ON public.fragments
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "fragments_modify" ON public.fragments;
CREATE POLICY "fragments_modify" ON public.fragments
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "fragments_service" ON public.fragments;
CREATE POLICY "fragments_service" ON public.fragments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_fragments" ON public.fragments;
CREATE POLICY "demo_anon_select_fragments" ON public.fragments
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- couple_merge_events / couple_progression_events / candidate_matches /
-- tracer_run_events — operator-internal tables. NO demo-anon read.
-- Same authenticated/service shape as above.

DROP POLICY IF EXISTS "couple_merge_events_select" ON public.couple_merge_events;
CREATE POLICY "couple_merge_events_select" ON public.couple_merge_events
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "couple_merge_events_service" ON public.couple_merge_events;
CREATE POLICY "couple_merge_events_service" ON public.couple_merge_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- couple_progression_events is keyed on couple_id rather than venue_id
-- directly; reach through couples like agent_couple_links.
DROP POLICY IF EXISTS "couple_progression_events_select" ON public.couple_progression_events;
CREATE POLICY "couple_progression_events_select" ON public.couple_progression_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.couples c
      WHERE c.id = couple_progression_events.couple_id
        AND (
          c.venue_id IN (
            SELECT up.venue_id FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
            UNION
            SELECT v.id FROM public.venues v
              JOIN public.user_profiles up ON up.org_id = v.org_id
            WHERE up.id = auth.uid()
          )
          OR public.is_super_admin()
        )
    )
  );

DROP POLICY IF EXISTS "couple_progression_events_service" ON public.couple_progression_events;
CREATE POLICY "couple_progression_events_service" ON public.couple_progression_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "candidate_matches_select" ON public.candidate_matches;
CREATE POLICY "candidate_matches_select" ON public.candidate_matches
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "candidate_matches_modify" ON public.candidate_matches;
CREATE POLICY "candidate_matches_modify" ON public.candidate_matches
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "candidate_matches_service" ON public.candidate_matches;
CREATE POLICY "candidate_matches_service" ON public.candidate_matches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "tracer_run_events_select" ON public.tracer_run_events;
CREATE POLICY "tracer_run_events_select" ON public.tracer_run_events
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "tracer_run_events_service" ON public.tracer_run_events;
CREATE POLICY "tracer_run_events_service" ON public.tracer_run_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ===========================================================================
-- 10. Backfill — every existing wedding becomes a couples row.
-- ===========================================================================
--
-- One-shot, idempotent via uq_couples_source_wedding. Re-runs of the
-- migration are no-ops (ON CONFLICT DO NOTHING). The Phase A gate
-- (scripts/phase-a-acceptance.sql) verifies this by running 346 twice
-- and asserting row counts are identical.
--
-- lifecycle_state derivation from weddings.status:
--   inquiry / tour_scheduled / tour_completed / proposal_sent → resolved
--   booked / completed                                         → booked
--   lost / cancelled                                           → ghost
--
-- Why every wedding lands at 'resolved' (not 'channel_scoped'): the
-- weddings table already represents a couple the venue acknowledged.
-- It is past the Channel-Scoped tier by definition. (Channel-Scoped
-- only applies to entities Bloom discovers but the venue hasn't
-- recognised yet — Knot saves, anonymous calculator runs, etc.)
-- ---------------------------------------------------------------------------

INSERT INTO couples (
  venue_id,
  primary_contact_name,
  primary_contact_email,
  primary_contact_phone,
  partner_contact_name,
  partner_contact_email,
  partner_contact_phone,
  wedding_date,
  lifecycle_state,
  source_wedding_id,
  created_at,
  updated_at
)
SELECT
  w.venue_id,
  -- primary_contact_name fallback chain. weddings has no display name,
  -- so we derive from people: partner1 wins, partner2 second, then a
  -- placeholder. (The placeholder gets cleaned up when Phase B Tracer
  -- pulls names from interaction signatures.)
  COALESCE(
    NULLIF(TRIM(CONCAT_WS(' ', p1.first_name, p1.last_name)), ''),
    NULLIF(TRIM(CONCAT_WS(' ', p2.first_name, p2.last_name)), ''),
    '(Unknown — backfilled from weddings ' || w.id::text || ')'
  ) AS primary_contact_name,
  p1.email,
  p1.phone,
  NULLIF(TRIM(CONCAT_WS(' ', p2.first_name, p2.last_name)), '') AS partner_contact_name,
  p2.email,
  p2.phone,
  w.wedding_date,
  CASE
    WHEN w.status IN ('booked','completed')      THEN 'booked'
    WHEN w.status IN ('lost','cancelled')        THEN 'ghost'
    ELSE                                              'resolved'
  END AS lifecycle_state,
  w.id AS source_wedding_id,
  w.inquiry_date,
  w.updated_at
FROM weddings w
LEFT JOIN LATERAL (
  SELECT first_name, last_name, email, phone
  FROM people
  WHERE wedding_id = w.id AND role = 'partner1'
  ORDER BY created_at ASC
  LIMIT 1
) p1 ON true
LEFT JOIN LATERAL (
  SELECT first_name, last_name, email, phone
  FROM people
  WHERE wedding_id = w.id AND role = 'partner2'
  ORDER BY created_at ASC
  LIMIT 1
) p2 ON true
ON CONFLICT (venue_id, source_wedding_id) DO NOTHING;

COMMENT ON COLUMN couples.primary_contact_name IS
  'Display name for the primary contact. Required (NOT NULL). Backfill from weddings '
  'uses partner1 → partner2 → placeholder fallback chain. Placeholders get rewritten '
  'by Phase B Tracer when interaction signatures supply better names.';
