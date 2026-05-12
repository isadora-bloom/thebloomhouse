-- ---------------------------------------------------------------------------
-- 306_sticky_per_couple_state.sql
-- ---------------------------------------------------------------------------
-- Pattern 1 from BLOOM-PATTERNS-ZOOM-OUT.md: sticky per-couple state.
--
-- Why this exists
-- ---------------
-- Today many decisions about a couple are derived per-event:
--   - "Have they toured?" → derived from tours.outcome on every read
--   - "Is the wedding date locked?" → no such concept; latest signal wins
--   - "Is the lead permanently lost?" → status='lost' but a fresh inbound
--     can flip the status ladder back to active in some paths
--   - "Does the LLM keep proposing partner names?" → name_evidence is
--     append-only but no lock prevents the picker / candidate-resolver
--     from re-electing a different display name from a fresher signal
--   - "Do they prefer text not email?" → no column. Auto-send fires email.
--   - "Is the ceremony / reception time confirmed?" → no operator stamp.
--     Each Sage draft can re-propose.
--
-- The AI-opt-out fix (mig 303) demonstrated the pattern: once an operator
-- declares a per-couple decision, the system must respect it across every
-- future signal. This migration generalises that pattern to six more
-- per-couple decisions.
--
-- Shape
-- -----
-- Every sticky decision gets the same shape:
--   <field>_locked / _confirmed boolean (or _at timestamptz for finer detail)
--   <field>_locked_at timestamptz
--   <field>_locked_by uuid REFERENCES user_profiles(id)
--
-- The reader pattern: when locked, downstream auto-derive code MUST skip
-- the overwrite path and (optionally) log a conflict. The override pattern:
-- coordinator clicks a button → POST stamps lock + sets actor.
--
-- Forensic-evidence parity: wedding_date_evidence mirrors people.name_evidence
-- so date conflicts are inspectable in the same way (mig 255).
--
-- Idempotent: every column / index uses IF NOT EXISTS. Safe to re-run.
-- No transaction wrapper — exec_sql RPC rejects BEGIN/COMMIT (Wave 23).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — weddings.has_toured_in_person
-- ============================================================================
-- Sticky bool: once true, never reverts. Today derived from tours.outcome
-- IN ('completed') on every read. Becoming sticky lets Sage prompts +
-- auto-send + sequences gate on "have we shown them the venue?" without
-- a join, and lets coordinator manually stamp "they walked through at the
-- open house" when no tour row exists.

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

-- ============================================================================
-- STEP 2 — weddings.wedding_date_locked_by_operator + evidence log
-- ============================================================================
-- Append-only evidence log + lock flag. Today the pipeline only writes
-- wedding_date when the existing is NULL (pipeline.ts:2243), so we already
-- avoid overwriting an operator-set date. But there's no record of the
-- conflicting signals, no way to surface "the form said May 15, the email
-- said May 10" to the coordinator, and no lock that prevents an
-- LLM-extracted date from auto-populating into an empty field.
--
-- Shape of wedding_date_evidence (per row):
--   {
--     "source": "calendly_form" | "calculator" | "email_body" |
--               "operator_override" | "calendar_event_subject" | "sms_body",
--     "value": "2027-08-14",
--     "precision": "day" | "month" | "season" | "year",
--     "confidence": 0-100,
--     "captured_at": iso8601,
--     "interaction_id": uuid | null,
--     "actor_id": uuid | null     -- operator overrides only
--   }
--
-- The lock flag: when true, the auto-derive layer reads-only. Writes only
-- via explicit operator action (clearing the lock first).

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
  'every signal; the wedding_date column is a *picked projection*. '
  'Coordinator can click any evidence row and "promote to picked" — that '
  'is the operator_override path. Sticky-state Pattern 1.';

-- ============================================================================
-- STEP 3 — weddings.lost_locked_by_operator
-- ============================================================================
-- Today weddings.lost_at + status='lost' exist (mig 073 backfills lost_at
-- from status). The pipeline status-ladder already refuses to flip lost
-- back via scheduling events (rank 99 in pipeline.ts:2944). But the
-- lost-reactivation cron + any auto-status-update from other paths CAN
-- bring it back. The lock makes "permanently lost" a first-class concept:
-- a coordinator who declares this couple gone is gone overrides every
-- automated re-engagement path.

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

-- ============================================================================
-- STEP 4 — weddings ceremony_start / reception_end confirmation timestamps
-- ============================================================================
-- ceremony_start + reception_end already exist (mig 076). What's missing
-- is the operator-confirmed timestamp + lock so day-of writers, Sage
-- prompts, and timeline auto-derive know "this is the canonical schedule;
-- do not propose new times".

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

-- ============================================================================
-- STEP 5 — people.preferred_contact_channel + lock
-- ============================================================================
-- New concept. No column today. Drives auto-send: if a couple has said
-- "text me, don't email" the auto-send rules should respect it.
--
-- Source field documents whether this was inferred from behaviour (couple
-- replies via SMS but ignores email for 4 weeks) vs explicitly stated
-- (couple typed "please text me"). Inferred values can be overwritten by
-- a later signal; operator-set ones cannot.

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
  '''couple_stated'' = LLM detected explicit statement ("please text me") '
  'in an inbound; ''inferred'' = behavioural pattern (only replies on one '
  'channel). Operator + couple_stated are sticky; inferred can be '
  'overwritten by a stronger signal. Sticky-state Pattern 1.';

-- ============================================================================
-- STEP 6 — people.name_locked_by_operator
-- ============================================================================
-- name_evidence (mig 255) is append-only — the picker / candidate-resolver
-- chooses the displayed name on every signal. There is no "the operator
-- typed this name; do not overwrite" flag. This adds it.
--
-- name-upgrade.ts already refuses to downgrade (Jen → Jennifer fine,
-- Jennifer → Jen blocked). But there are paths where the resolver / picker
-- could elect a different last-name from a fresher higher-confidence
-- signal. Operator lock makes that impossible.

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

-- ============================================================================
-- STEP 7 — partial indexes on the lock columns
-- ============================================================================
-- The locks are rare-true. Partial indexes make "find all locked weddings"
-- and "find all locked people" instant without bloating the main lookup
-- indexes.

CREATE INDEX IF NOT EXISTS idx_weddings_wedding_date_locked
  ON public.weddings (venue_id)
  WHERE wedding_date_locked_by_operator = true;

CREATE INDEX IF NOT EXISTS idx_weddings_lost_locked
  ON public.weddings (venue_id)
  WHERE lost_locked_by_operator = true;

CREATE INDEX IF NOT EXISTS idx_weddings_timeline_locked
  ON public.weddings (venue_id)
  WHERE day_of_timeline_locked = true;

CREATE INDEX IF NOT EXISTS idx_weddings_has_toured
  ON public.weddings (venue_id)
  WHERE has_toured_in_person = true;

CREATE INDEX IF NOT EXISTS idx_people_name_locked
  ON public.people (venue_id)
  WHERE name_locked_by_operator = true;

CREATE INDEX IF NOT EXISTS idx_people_preferred_channel
  ON public.people (venue_id, preferred_contact_channel)
  WHERE preferred_contact_channel IS NOT NULL;

-- ============================================================================
-- STEP 8 — Backfill has_toured_in_person from tours
-- ============================================================================
-- Every wedding that has at least one tours.outcome='completed' row gets
-- has_toured_in_person=true. We do NOT backfill no_show / cancelled —
-- the semantic is "they physically saw the venue".
-- has_toured_in_person_at is set to the earliest completed tour's
-- scheduled_at (best proxy; tours.completed_at doesn't exist).
-- Idempotent: re-running just no-ops the WHERE clause.

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

-- ============================================================================
-- STEP 8b — Trigger: tours.outcome → weddings.has_toured_in_person
-- ============================================================================
-- Catch-all: any path that stamps tours.outcome='completed' (Zoom signal,
-- coordinator UI, classifier, brain-dump import, CSV import) flips the
-- sticky bool. Trigger approach beats instrumenting every writer.
-- Only fires on transition INTO 'completed' and only if the wedding's
-- flag is still false (idempotent).

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

-- ============================================================================
-- STEP 9 — Backfill wedding_date_evidence from current wedding_date
-- ============================================================================
-- Each wedding that has a wedding_date today gets one evidence row
-- recording the historical value. Source='backfill_pre_evidence' so the
-- coordinator can see "this date predates the evidence system". Picks
-- the value, precision, and inquiry_date as captured_at (we don't know
-- when the date landed historically).

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

NOTIFY pgrst, 'reload schema';
