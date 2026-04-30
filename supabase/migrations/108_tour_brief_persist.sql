-- ---------------------------------------------------------------------------
-- 108_tour_brief_persist.sql
-- ---------------------------------------------------------------------------
-- Connective tissue II / fix #1 (2026-04-30). Persist post-tour AI
-- brief output to tours so it can be surfaced on /intel/clients/[id]
-- without re-paying AI cost per view, and so coordinators have an
-- audit trail.
--
-- Before this, post_tour_brief.ts called Claude on every POST and
-- only stamped tour_brief_generated_at — the actual brief text +
-- suggested follow-up draft + confidence band lived in component
-- state in /intel/tours and vanished when the page reloaded. The
-- lead detail couldn't surface the brief at all without regenerating.
--
-- Same caching shape as wedding_journey_narratives (107): persist
-- everything generated, regenerate only on coordinator demand.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS tour_brief_text text;

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS tour_brief_followup_draft text;

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS tour_brief_confidence text
    CHECK (tour_brief_confidence IS NULL OR tour_brief_confidence IN ('high', 'medium', 'low'));

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS tour_brief_model text;

COMMENT ON COLUMN public.tours.tour_brief_text IS
  'Connective II / fix #1. AI-generated post-tour brief paragraph: what happened / what they cared about / open questions / next-step recommendation. Cached so /intel/tours and /intel/clients/[id] can render it without re-paying AI cost. Regenerated on coordinator demand via POST /api/agent/post-tour-brief.';

NOTIFY pgrst, 'reload schema';
