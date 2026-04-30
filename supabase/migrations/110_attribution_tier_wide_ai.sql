-- ---------------------------------------------------------------------------
-- 110_attribution_tier_wide_ai.sql
-- ---------------------------------------------------------------------------
-- Phase B / PB.4 follow-up (2026-04-30). Splits the single 'tier_2_ai'
-- label into two so analytics can distinguish:
--   tier_2_ai       — AI adjudicated within the Tier 1 ±72h window (the
--                     "multiple matches in the tight window" case)
--   tier_2_wide_ai  — AI adjudicated within the Tier 2 ±30d window (the
--                     wide-window fallback added 2026-04-30 after the
--                     first Knot import revealed only 4/785 matched at
--                     ±72h while hundreds had matches sitting 5-30 days
--                     out from inquiry)
--
-- Same decision rules, same confidence threshold, same writer code path
-- (runAIAdjudication). Only the resolver-decided window differs. Existing
-- rows keep tier_2_ai — the rename is forward-only.
-- ---------------------------------------------------------------------------

ALTER TABLE public.attribution_events
  DROP CONSTRAINT IF EXISTS attribution_events_tier_check;

ALTER TABLE public.attribution_events
  ADD CONSTRAINT attribution_events_tier_check
  CHECK (tier IN (
    'tier_1_exact',
    'tier_1_name_window',
    'tier_1_full_name',
    'tier_2_ai',
    'tier_2_wide_ai',
    'tier_2_coordinator',
    'tier_3_manual'
  ));
