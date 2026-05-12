-- ============================================================================
-- APPLY-PATTERNS-1-TO-10.sql
-- ============================================================================
-- Bundled application of every migration from the BLOOM-PATTERNS-ZOOM-OUT.md
-- sweep (2026-05-12). Six migrations consolidated into one apply step:
--
--   306  Sticky per-couple state                   (Pattern 1)
--   311  Watermark sync state                       (Pattern 4)
--   312  Operator override columns                  (Pattern 10)
--   313  SMS lifecycle fix                          (Justin & Sandy bundle)
--   314  Cascade staleness flags + lost-mark trigger (Pattern 2)
--   315  Interaction Haiku dimensions               (Pattern 5)
--
-- Patterns 3 (body-extract parity), 6 (SMS routability), 7 (backfill audit),
-- and 8 (schema-vs-select sweep) are code-only and need no schema changes.
-- Pattern 9 (voice-channel parity full build) is deferred.
--
-- Order matters in two places:
--   - 314's trigger references the existing weddings.status column (no
--     ordering risk; ships first regardless because of statement-level
--     dependency only on base schema).
--   - 313's index on engagement_events depends on a column added long
--     before this sweep; safe in any order with the others.
--
-- All statements are idempotent (IF NOT EXISTS / DROP-then-CREATE).
-- No BEGIN/COMMIT wrappers (Wave 23 doctrine — exec_sql RPC rejects them).
-- Safe to re-run if a previous partial apply happened. Safe to apply
-- against a Supabase project that has already taken some of these
-- migrations via their individual files.
--
-- After applying, the NOTIFY pgrst statements at the end of each section
-- ensure PostgREST picks up the schema additions without a manual reload.
-- ============================================================================


-- ============================================================================
-- ============================================================================
-- 306 — STICKY PER-COUPLE STATE (Pattern 1)
-- ============================================================================
-- Pattern: every per-couple decision the system can derive must be
-- overridable by the operator and respected by all downstream writers.
-- Six sticky decisions added:
--   1. has_toured_in_person (sticky bool + trigger from tours.outcome)
--   2. wedding_date_locked + append-only wedding_date_evidence log
--   3. lost_locked (prevents re-engagement cron from reactivating)
--   4. ceremony_start_confirmed / reception_end_confirmed / timeline_locked
--   5. people.preferred_contact_channel (email|sms|phone)
--   6. people.name_locked (freezes name-upgrade picker)
-- ============================================================================

-- STEP 1 — weddings.has_toured_in_person
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS has_toured_in_person boolean NOT NULL DEFAULT false;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS has_toured_in_person_at timestamptz;

COMMENT ON COLUMN public.weddings.has_toured_in_person IS
  'Sticky: this couple has physically visited the venue. Set true the '
  'first time tours.outcome=''completed'' lands or a coordinator stamps '
  'it manually. Never reverts. Readers: Sage prompt (do not push "come '
  'tour" if true), post-tour sequence (only fires when true), couple '
  'portal (locks the "schedule a tour" CTA). Sticky-state Pattern 1.';

-- STEP 2 — weddings.wedding_date_locked + evidence log
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS wedding_date_locked_by_operator boolean NOT NULL DEFAULT false;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS wedding_date_locked_at timestamptz;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS wedding_date_locked_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS wedding_date_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.weddings.wedding_date_locked_by_operator IS
  'When true, auto-derive (pipeline date-extract, LLM date inference, '
  'form import) must not overwrite weddings.wedding_date even if the '
  'current value is NULL. Conflicting signals append to '
  'wedding_date_evidence with source!=operator_override but never mutate '
  'the column. Cleared by explicit operator action. Sticky-state Pattern 1.';

COMMENT ON COLUMN public.weddings.wedding_date_evidence IS
  'Append-only log of every wedding-date claim ever observed. Mirrors '
  'people.name_evidence shape (mig 255). Auto-derive writes here on '
  'every signal; the wedding_date column is a picked projection. '
  'Coordinator can click any evidence row and "promote to picked" — that '
  'is the operator_override path. Sticky-state Pattern 1.';

-- STEP 3 — weddings.lost_locked_by_operator
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS lost_locked_by_operator boolean NOT NULL DEFAULT false;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS lost_locked_at timestamptz;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS lost_locked_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.weddings.lost_locked_by_operator IS
  'When true, lost-reactivation cron + auto-status-update paths must skip '
  'this wedding. Status stays ''lost''. Used when the coordinator has '
  'confirmed the couple is permanently gone (married someone else, '
  'cancelled wedding, explicit "stop contacting us"). Cleared only by '
  'explicit re-open from coordinator. Sticky-state Pattern 1.';

-- STEP 4 — weddings.ceremony_start_confirmed / reception_end_confirmed / day_of_timeline_locked
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS ceremony_start_confirmed_at timestamptz;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS ceremony_start_confirmed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS reception_end_confirmed_at timestamptz;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS reception_end_confirmed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS day_of_timeline_locked boolean NOT NULL DEFAULT false;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS day_of_timeline_locked_at timestamptz;
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS day_of_timeline_locked_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.weddings.ceremony_start_confirmed_at IS
  'Operator-confirmed timestamp for ceremony_start. When set, Sage + '
  'post-tour + day-of-timeline writers must not propose new ceremony '
  'times. NULL = unconfirmed. Sticky-state Pattern 1.';
COMMENT ON COLUMN public.weddings.day_of_timeline_locked IS
  'When true, the timeline table rows for this wedding are operator-'
  'confirmed and no Sage / auto-derive writer may insert / update / delete '
  'rows. Coordinator unlocks for edits via the day-of view. '
  'Sticky-state Pattern 1.';

-- STEP 5 — people.preferred_contact_channel
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS preferred_contact_channel text
    CHECK (preferred_contact_channel IS NULL OR preferred_contact_channel IN ('email', 'sms', 'phone'));
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS preferred_contact_channel_set_at timestamptz;
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS preferred_contact_channel_source text
    CHECK (preferred_contact_channel_source IS NULL OR preferred_contact_channel_source IN ('operator', 'couple_stated', 'inferred'));

COMMENT ON COLUMN public.people.preferred_contact_channel IS
  'Couple''s preferred outbound channel. NULL = unknown / no preference '
  'declared. Auto-send rules + Sage prompt builder must respect non-null '
  'values: SMS-preferring couples get drafts via SMS not email. Sticky-'
  'state Pattern 1.';
COMMENT ON COLUMN public.people.preferred_contact_channel_source IS
  'How this preference was captured. ''operator'' = coordinator typed it; '
  '''couple_stated'' = LLM detected explicit statement; ''inferred'' = '
  'behavioural pattern. Operator + couple_stated are sticky; inferred can '
  'be overwritten by a stronger signal. Sticky-state Pattern 1.';

-- STEP 6 — people.name_locked_by_operator
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS name_locked_by_operator boolean NOT NULL DEFAULT false;
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS name_locked_at timestamptz;
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS name_locked_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.people.name_locked_by_operator IS
  'When true, the name-upgrade pipeline + candidate-identity resolver must '
  'not overwrite first_name / last_name. Signals still append to '
  'name_evidence (forensic record) but the displayed projection is '
  'frozen. Sticky-state Pattern 1.';

-- STEP 7 — partial indexes
CREATE INDEX IF NOT EXISTS idx_weddings_wedding_date_locked
  ON public.weddings (venue_id) WHERE wedding_date_locked_by_operator = true;
CREATE INDEX IF NOT EXISTS idx_weddings_lost_locked
  ON public.weddings (venue_id) WHERE lost_locked_by_operator = true;
CREATE INDEX IF NOT EXISTS idx_weddings_timeline_locked
  ON public.weddings (venue_id) WHERE day_of_timeline_locked = true;
CREATE INDEX IF NOT EXISTS idx_weddings_has_toured
  ON public.weddings (venue_id) WHERE has_toured_in_person = true;
CREATE INDEX IF NOT EXISTS idx_people_name_locked
  ON public.people (venue_id) WHERE name_locked_by_operator = true;
CREATE INDEX IF NOT EXISTS idx_people_preferred_channel
  ON public.people (venue_id, preferred_contact_channel)
  WHERE preferred_contact_channel IS NOT NULL;

-- STEP 8 — Backfill has_toured_in_person from tours
UPDATE public.weddings w
SET
  has_toured_in_person = true,
  has_toured_in_person_at = COALESCE(
    (SELECT MIN(t.scheduled_at) FROM public.tours t
     WHERE t.wedding_id = w.id AND t.outcome = 'completed'),
    now()
  )
WHERE
  w.has_toured_in_person = false
  AND EXISTS (
    SELECT 1 FROM public.tours t
    WHERE t.wedding_id = w.id AND t.outcome = 'completed'
  );

-- STEP 8b — Trigger: tours.outcome -> weddings.has_toured_in_person
CREATE OR REPLACE FUNCTION public.touch_has_toured_in_person()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.outcome = 'completed'
     AND (OLD.outcome IS DISTINCT FROM 'completed')
     AND NEW.wedding_id IS NOT NULL
  THEN
    UPDATE public.weddings
       SET has_toured_in_person = true,
           has_toured_in_person_at = COALESCE(has_toured_in_person_at, NEW.scheduled_at, now())
     WHERE id = NEW.wedding_id
       AND has_toured_in_person = false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tours_touch_has_toured ON public.tours;
CREATE TRIGGER trg_tours_touch_has_toured
  AFTER INSERT OR UPDATE OF outcome ON public.tours
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_has_toured_in_person();

-- STEP 9 — Backfill wedding_date_evidence from existing wedding_date
UPDATE public.weddings w
SET
  wedding_date_evidence = jsonb_build_array(
    jsonb_build_object(
      'source', 'backfill_pre_evidence',
      'value', wedding_date::text,
      'precision', COALESCE(wedding_date_precision, 'day'),
      'confidence', 50,
      'captured_at', COALESCE(inquiry_date, created_at),
      'interaction_id', null,
      'actor_id', null
    )
  )
WHERE
  w.wedding_date IS NOT NULL
  AND (w.wedding_date_evidence IS NULL OR w.wedding_date_evidence = '[]'::jsonb);


-- ============================================================================
-- ============================================================================
-- 311 — WATERMARK SYNC STATE (Pattern 4)
-- ============================================================================
-- FRED + Zoom were re-pulling their entire historical window every cron
-- tick. This adds per-series / per-connection watermarks so subsequent
-- syncs pull only the new window (with a small overlap buffer for
-- in-flight rows).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fred_series_sync_state (
  series_id text PRIMARY KEY,
  last_fetched_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fred_series_sync_state IS
  'owner:agent. Per-FRED-series watermark for incremental fetch. fred-fetch.ts reads last_fetched_at and pulls from (last_fetched_at - 1 day) to today, instead of re-pulling 400 days every cron tick. last_error_at + last_error capture transient failures without poisoning the success watermark. First sync (row absent) falls back to the 400-day backfill.';

ALTER TABLE public.zoom_connections
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

COMMENT ON COLUMN public.zoom_connections.last_synced_at IS
  'Watermark for incremental Zoom recording sync. NULL means first-sync (use 30d default). zoom.ts subtracts a 30-minute overlap to catch meetings that finalized after the previous tick.';


-- ============================================================================
-- ============================================================================
-- 312 — OPERATOR OVERRIDE COLUMNS (Pattern 10)
-- ============================================================================
-- Generalises the override-anywhere pattern to four high-leverage auto-
-- derived fields: heat_score, persona_label, first-touch attribution,
-- author_class on interactions. Each gets WHO + WHEN audit columns; heat
-- additionally stores the override value (0-100). Auto-derive layers
-- check the *_overridden_at column and short-circuit when non-null.
-- ============================================================================

-- weddings: heat_score override
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS heat_score_overridden_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS heat_score_overridden_at timestamptz;
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS heat_score_override_value integer;
ALTER TABLE weddings DROP CONSTRAINT IF EXISTS weddings_heat_score_override_value_range;
ALTER TABLE weddings
  ADD CONSTRAINT weddings_heat_score_override_value_range
  CHECK (heat_score_override_value IS NULL
         OR (heat_score_override_value >= 0 AND heat_score_override_value <= 100));

COMMENT ON COLUMN weddings.heat_score_overridden_by IS
  'user_profiles.id of the coordinator who set the heat_score override. Auto-derive layer (recalculateHeatScore in heat-mapping.ts) MUST early-return when heat_score_overridden_at IS NOT NULL and write nothing to heat_score / temperature_tier.';
COMMENT ON COLUMN weddings.heat_score_overridden_at IS
  'Timestamp the heat_score override was set. Presence of a non-null value is the sentinel recalculateHeatScore checks before writing.';
COMMENT ON COLUMN weddings.heat_score_override_value IS
  'The operator-supplied heat score (0-100). When non-null, this value is the canonical heat score and recalculateHeatScore returns it without writing weddings.heat_score. Range check enforced via weddings_heat_score_override_value_range.';

-- weddings: persona_label override
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS persona_label text;
ALTER TABLE weddings DROP CONSTRAINT IF EXISTS weddings_persona_label_length;
ALTER TABLE weddings
  ADD CONSTRAINT weddings_persona_label_length
  CHECK (persona_label IS NULL OR char_length(persona_label) <= 60);
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS persona_label_overridden_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS persona_label_overridden_at timestamptz;

COMMENT ON COLUMN weddings.persona_label IS
  'Operator override for the couple''s persona label. NULL means use the derived cohort label (intel layer). When non-null, treat this as the canonical label across all surfaces. Max 60 chars.';
COMMENT ON COLUMN weddings.persona_label_overridden_by IS
  'user_profiles.id of the coordinator who set persona_label. Cleared when the override is reverted.';
COMMENT ON COLUMN weddings.persona_label_overridden_at IS
  'Timestamp persona_label was set by an operator. Sentinel for any cohort-label writer: if non-null, do not overwrite persona_label.';

-- weddings: first-touch override (wedding-scoped audit pair)
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS first_touch_overridden_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS first_touch_overridden_at timestamptz;

COMMENT ON COLUMN weddings.first_touch_overridden_by IS
  'user_profiles.id of the coordinator who locked first-touch attribution. attribution_events.is_first_touch was promoted/demoted by the override route; this column captures audit.';
COMMENT ON COLUMN weddings.first_touch_overridden_at IS
  'Timestamp first-touch was locked. The recompute_attribution_buckets trigger (migration 119) should treat this as a do-not-recompute sentinel for is_first_touch on this wedding.';

-- interactions: author_class override
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS author_class_overridden_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL;
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS author_class_overridden_at timestamptz;

COMMENT ON COLUMN interactions.author_class_overridden_by IS
  'user_profiles.id of the coordinator who set the author_class override. The author-class classifier (migration 293 / Wave 27) MUST skip re-classification when author_class_overridden_at IS NOT NULL.';
COMMENT ON COLUMN interactions.author_class_overridden_at IS
  'Timestamp the author_class override was set. Sentinel for the AI classifier and any heuristic write path: presence means leave author_class untouched.';

-- partial indexes — "find rows with active overrides"
CREATE INDEX IF NOT EXISTS idx_weddings_heat_score_overridden
  ON weddings (heat_score_overridden_at DESC)
  WHERE heat_score_overridden_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_weddings_persona_label_overridden
  ON weddings (persona_label_overridden_at DESC)
  WHERE persona_label_overridden_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_weddings_first_touch_overridden
  ON weddings (first_touch_overridden_at DESC)
  WHERE first_touch_overridden_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interactions_author_class_overridden
  ON interactions (author_class_overridden_at DESC)
  WHERE author_class_overridden_at IS NOT NULL;


-- ============================================================================
-- ============================================================================
-- 313 — SMS LIFECYCLE FIX (Justin & Sandy)
-- ============================================================================
-- Schema affordances for the SMS-only lead class. Real-world case: Justin
-- & Sandy (RM-1139) showed heat=0 despite 14 inbound SMS at +8 each
-- because engagement events were orphaned, no tour row was ever created
-- from SMS-only scheduling signal, and Sage drafts didn't know the lead
-- was SMS-only.
--
-- This migration ships the indexes + audit column that the JS services
-- (orphan-rebind, scheduling-extractor) need.
-- ============================================================================

-- Helper index for the orphan rebinder
CREATE INDEX IF NOT EXISTS engagement_events_orphan_wedding_idx
  ON public.engagement_events (created_at)
  WHERE wedding_id IS NULL;

COMMENT ON INDEX public.engagement_events_orphan_wedding_idx IS
  'Partial index over rows the SMS orphan-rebinder reclaims. Daily cron job orphan_engagement_rebind walks this. 2026-05-12 / mig 313.';

-- Composite index for the SMS scheduling-extractor idempotency window
CREATE INDEX IF NOT EXISTS tours_venue_wedding_scheduled_idx
  ON public.tours (venue_id, wedding_id, scheduled_at)
  WHERE wedding_id IS NOT NULL AND scheduled_at IS NOT NULL;

COMMENT ON INDEX public.tours_venue_wedding_scheduled_idx IS
  'Speeds the SMS scheduling-extractor idempotency window check (±24h around proposed scheduled_at). 2026-05-12 / mig 313.';

-- Throttle / audit column for the extractor
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS sms_scheduling_extracted_at timestamptz;

COMMENT ON COLUMN public.weddings.sms_scheduling_extracted_at IS
  'Last time the SMS scheduling-extractor (Haiku) processed this wedding. Stamped by extractTourSignalsFromSmsThread regardless of whether any tour row was created — used to throttle drift refreshes. 2026-05-12 / mig 313.';


-- ============================================================================
-- ============================================================================
-- 314 — CASCADE STALENESS FLAGS + LOST-MARK TRIGGER (Pattern 2)
-- ============================================================================
-- Pending drafts carry assumptions about venue state at the moment they
-- were generated. When pricing or AI personality changes, those drafts
-- get flagged stale. When a wedding flips to status='lost', a Postgres
-- trigger cancels every pending draft Postgres-side so JS-side
-- instrumentation doesn't have to chase every writer.
-- ============================================================================

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS pricing_stale_at timestamptz;
ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS personality_stale_at timestamptz;
ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS cancelled_reason text;

COMMENT ON COLUMN public.drafts.pricing_stale_at IS
  'When set, the draft was generated before the most recent pricing change. '
  'Coordinator UI surfaces a "regenerate to refresh pricing" prompt. '
  'Cleared on regenerate. Cascade Pattern 2 (migration 314).';
COMMENT ON COLUMN public.drafts.personality_stale_at IS
  'When set, the draft was generated against a personality config older '
  'than the current venue_ai_config. Coordinator UI surfaces a '
  '"regenerate to refresh voice" prompt. Cleared on regenerate. Cascade '
  'Pattern 2 (migration 314).';
COMMENT ON COLUMN public.drafts.cancelled_reason IS
  'Why a draft transitioned to status=rejected via a cascade (rather '
  'than coordinator reject with feedback). Example values: '
  '''wedding_lost'' | ''pricing_invalidated'' | ''personality_changed''. '
  'Distinct from feedback_notes (coordinator-written learning input). '
  'Cascade Pattern 2 (migration 314).';

CREATE INDEX IF NOT EXISTS idx_drafts_stale
  ON public.drafts (venue_id, created_at DESC)
  WHERE pricing_stale_at IS NOT NULL OR personality_stale_at IS NOT NULL;

-- Trigger: weddings.status='lost' cancels pending drafts
CREATE OR REPLACE FUNCTION public.cascade_wedding_lost()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'lost'
     AND (OLD.status IS DISTINCT FROM 'lost')
  THEN
    UPDATE public.drafts
       SET status = 'rejected',
           cancelled_reason = 'wedding_lost'
     WHERE wedding_id = NEW.id
       AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_weddings_cascade_lost ON public.weddings;
CREATE TRIGGER trg_weddings_cascade_lost
  AFTER UPDATE OF status ON public.weddings
  FOR EACH ROW
  EXECUTE FUNCTION public.cascade_wedding_lost();


-- ============================================================================
-- ============================================================================
-- 315 — INTERACTION HAIKU DIMENSIONS (Pattern 5)
-- ============================================================================
-- Single Haiku call on every inbound interaction produces sentiment,
-- urgency, family-mentioned dimensions cached on the row. Every brain
-- prompt that wants to "respond appropriately when the couple sounds
-- frustrated" reads the cached dimension instead of re-inferring from
-- raw body. Fire-and-forget at insert time; cron drain
-- (inbound_haiku_drain) catches misses and backfills history.
-- ============================================================================

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS sentiment text
  CHECK (sentiment IN ('positive', 'neutral', 'concerned', 'frustrated'));
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS urgency text
  CHECK (urgency IN ('low', 'medium', 'high'));
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS family_mentioned boolean DEFAULT false;
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS haiku_classified_at timestamptz;

COMMENT ON COLUMN interactions.sentiment IS
  'Haiku-classified emotional tenor of this inbound body. One of positive | neutral | concerned | frustrated. NULL until the classifier in src/lib/services/intel/inbound-haiku-classifier.ts has run. Brain prompts (inquiry / client / sage) surface the latest inbound value so drafts respond appropriately. Mig 315.';
COMMENT ON COLUMN interactions.urgency IS
  'Haiku-classified urgency tier of this inbound body. One of low | medium | high. NULL until the classifier has run. Brain prompts surface the latest inbound value so drafts match cadence. Mig 315.';
COMMENT ON COLUMN interactions.family_mentioned IS
  'Was a non-partner human role (mom, dad, mother-in-law, sibling, MOH, planner, family friend, vendor contact) referenced in this body. Excludes the two partners themselves. Defaults to false so unclassified rows behave as no-signal; pair with haiku_classified_at IS NULL to distinguish "no" from "not yet known". Mig 315.';
COMMENT ON COLUMN interactions.haiku_classified_at IS
  'Timestamp the inbound-haiku-classifier successfully wrote sentiment / urgency / family_mentioned for this row. NULL = pending (cron drain will pick it up). Pair with direction = inbound in the partial idx_interactions_haiku_pending index. Mig 315.';

CREATE INDEX IF NOT EXISTS idx_interactions_haiku_pending
  ON interactions (venue_id, created_at)
  WHERE haiku_classified_at IS NULL AND direction = 'inbound';


-- ============================================================================
-- Final: PostgREST schema reload
-- ============================================================================
NOTIFY pgrst, 'reload schema';
