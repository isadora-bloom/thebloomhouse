-- seed-commitments-demo.sql
--
-- W50 / the groom's cake. One Crestwood Farm wedding where the couple
-- told the venue something and nothing on the running order accounts for
-- it, so the "Things they told you" section on
-- /portal/weddings/<id> shows exactly one row instead of an empty state.
--
-- The wedding is 44444444-…-444444000209 (Crestwood Farm, booked, June
-- 2026), already in supabase/seed.sql. Nothing here creates a wedding, a
-- venue or a person.
--
-- Kept out of seed.sql on purpose. That file is 2,400 lines and several
-- workstreams edit it; this is a self-contained block that can be run,
-- re-run or dropped without touching the main seed.
--
-- Requires migration 406. Idempotent: every insert either carries an ON
-- CONFLICT against a real unique index, or is guarded by a NOT EXISTS.
--
-- Run:  psql < supabase/seed-commitments-demo.sql
--       (or paste into the Supabase SQL editor)

-- ---------------------------------------------------------------------------
-- 1. The conversation the sentence arrived in
-- ---------------------------------------------------------------------------
--
-- An inbound email about seating, with the groom's cake mentioned in
-- passing at the end. This is the shape the real gap has: the couple is
-- not writing in to talk about the cake, they mention it while asking
-- about something else, which is exactly why it gets read once and
-- forgotten.

-- W75: the column is `full_body` (migration 002), not `body`, and
-- `signal_class` has been NOT NULL with no DEFAULT since migration 192.
-- Both were invisible to check:seed-sql while it skipped SELECT-shaped
-- inserts; this statement would have failed at runtime as written.
INSERT INTO public.interactions (
  id, venue_id, wedding_id, person_id, type, direction, subject, full_body, timestamp, signal_class
)
SELECT
  '66666666-6666-6666-6666-666666000950',
  '22222222-2222-2222-2222-222222222202',
  '44444444-4444-4444-4444-444444000209',
  NULL,
  'email',
  'inbound',
  'Re: seating chart',
  'Thanks for sending the seating chart over, that all looks right to us. One other thing while I remember: we''re having a groom''s cake as well as the wedding cake. My uncle is driving it down on the Friday, so we''ll need somewhere to put it. Nothing fancy, just a small table off to the side.',
  '2026-04-18 14:20:00+00',
  'touchpoint'
WHERE NOT EXISTS (
  SELECT 1 FROM public.interactions WHERE id = '66666666-6666-6666-6666-666666000950'
);

-- ---------------------------------------------------------------------------
-- 2. The sentence, captured
-- ---------------------------------------------------------------------------
--
-- What services/commitments/capture.ts would have written on the way
-- through the pipeline. Category 'note' because a groom's cake is not a
-- vendor booking, a guest count or a cost; it is a loose detail, which is
-- the whole class this workstream exists for.

INSERT INTO public.planning_notes (
  venue_id, wedding_id, category, content, source_message,
  source_interaction_id, source_channel, status
)
SELECT
  '22222222-2222-2222-2222-222222222202',
  '44444444-4444-4444-4444-444444000209',
  'note',
  'We''re having a groom''s cake as well as the wedding cake, arriving Friday, needs a small table',
  'Thanks for sending the seating chart over, that all looks right to us. One other thing while I remember: we''re having a groom''s cake as well as the wedding cake.',
  '66666666-6666-6666-6666-666666000950',
  'email',
  'pending'
WHERE NOT EXISTS (
  SELECT 1 FROM public.planning_notes
  WHERE wedding_id = '44444444-4444-4444-4444-444444000209'
    AND source_interaction_id = '66666666-6666-6666-6666-666666000950'
);

-- ---------------------------------------------------------------------------
-- 3. A running order that does not account for it
-- ---------------------------------------------------------------------------
--
-- The config-blob shape the couple's timeline builder writes. Cake
-- cutting IS on the day, which is the point: a coordinator skimming the
-- running order sees a cake event and moves on. It is the wedding cake.
-- Nothing here puts a table anywhere for a second one.
--
-- No ON CONFLICT: migration 188 deliberately deferred the unique index on
-- timeline.wedding_id (the table is dual-mode), so a guarded insert is
-- the honest way to be idempotent here.

INSERT INTO public.timeline (venue_id, wedding_id, title, config_json)
SELECT
  '22222222-2222-2222-2222-222222222202',
  '44444444-4444-4444-4444-444444000209',
  'Day-of running order',
  jsonb_build_object(
    'config', jsonb_build_object(
      'ceremonyTime', '16:30',
      'receptionEndTime', '22:30',
      'dinnerType', 'buffet',
      'doingFirstLook', true,
      'offSiteCeremony', false,
      'autoCalculate', true,
      'formalitiesTiming', 'after',
      'weddingDate', '2026-06-06'
    ),
    'events', jsonb_build_array(
      jsonb_build_object('id', 'ceremony', 'name', 'Ceremony', 'time', '16:30', 'included', true, 'notes', '', 'phase', 'ceremony'),
      jsonb_build_object('id', 'cocktail_hour', 'name', 'Cocktail hour', 'time', '17:00', 'included', true, 'notes', '', 'phase', 'cocktail'),
      jsonb_build_object('id', 'dinner', 'name', 'Dinner', 'time', '18:30', 'included', true, 'notes', '', 'phase', 'dinner'),
      jsonb_build_object('id', 'cake_cutting', 'name', 'Cake cutting', 'time', '20:00', 'included', true, 'notes', 'Wedding cake, front of the barn', 'phase', 'reception_intro'),
      jsonb_build_object('id', 'first_dance', 'name', 'First dance', 'time', '20:15', 'included', true, 'notes', '', 'phase', 'reception_intro')
    ),
    'customEvents', jsonb_build_array()
  )
WHERE NOT EXISTS (
  SELECT 1 FROM public.timeline
  WHERE wedding_id = '44444444-4444-4444-4444-444444000209'
    AND config_json IS NOT NULL
);

-- ---------------------------------------------------------------------------
-- 4. The reconciliation row
-- ---------------------------------------------------------------------------
--
-- What the nightly sweep would write. Seeded directly so the demo shows
-- the queue populated without waiting for a cron tick and a model call.
--
-- commitment_key is the FNV-1a 32-bit hash of the normalised quote, the
-- same value services/commitments/keys.ts computes. Hard-coded here
-- because plpgsql has no reason to carry a copy of that function; if the
-- sweep runs against this row it will produce the same key and update in
-- place rather than adding a second row.

INSERT INTO public.commitment_reconciliation (
  venue_id, wedding_id, commitment_key, quote, kind,
  source_interaction_id, status, matched_event_title, judge_reason, judge_cache_key
)
VALUES (
  '22222222-2222-2222-2222-222222222202',
  '44444444-4444-4444-4444-444444000209',
  'demo0001',
  'We''re having a groom''s cake as well as the wedding cake, arriving Friday, needs a small table',
  'intention',
  '66666666-6666-6666-6666-666666000950',
  'unmatched',
  NULL,
  'The running order has a cake cutting, but its note says wedding cake and front of the barn. Nothing puts a table anywhere for a second cake.',
  NULL
)
ON CONFLICT (wedding_id, commitment_key) DO NOTHING;
