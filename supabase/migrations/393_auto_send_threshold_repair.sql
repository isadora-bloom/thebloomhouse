-- ============================================================================
-- 393: AUTO-SEND THRESHOLD REPAIR (T5-W5)
--
-- The 15-min wizard (src/app/(platform)/onboarding/page.tsx) seeded
-- auto_send_rules.confidence_threshold with the pre-migration-121
-- float scale (0.85) into what has been an INTEGER 0-100 column since
-- migration 121 (default 85, CHECK 0..100). A row with
-- confidence_threshold=0.85 rounds/truncates to 0 or 1 on the integer
-- column, so an enabled rule fires at effectively 1% confidence
-- instead of 85%. The wizard write path is fixed in the same change
-- that adds this migration; this repairs any rows already seeded
-- wrong.
--
-- Also flips shadow_mode=true on the same rows. Migration 227 made
-- new rules default to shadow (observe + log, don't fire) as a
-- probationary period; the wizard bug predates that shipping and
-- never set it, so any of these broken rows that were also enabled
-- would have been firing live at ~1% confidence with no shadow
-- safety net. Re-shadowing them costs nothing (coordinator promotes
-- with one click once they've reviewed the log) and closes that gap
-- for rows created before today.
-- ============================================================================

-- Single UPDATE keyed on the ORIGINAL broken predicate (confidence_threshold
-- <= 1) so the shadow-mode repair only touches rows this migration itself
-- identifies as broken — never a legitimate rule that already sits at the
-- (also 85) platform default. Splitting this into two statements would let
-- the second one re-match every already-correct default-85 rule once the
-- first statement has run.
UPDATE auto_send_rules
SET confidence_threshold = 85,
    shadow_mode = true,
    shadow_started_at = COALESCE(shadow_started_at, now())
WHERE confidence_threshold <= 1;
