-- ---------------------------------------------------------------------------
-- 101_drop_deprecated_tables.sql
-- ---------------------------------------------------------------------------
-- Drop three tables that are deprecated and confirmed to have zero
-- readers in src/ or supabase/functions:
--
--   * budget         — replaced by budget_items in migration 052.
--                      Migration 052 marked the table deprecated via
--                      COMMENT but kept it around for safety; nothing
--                      reads from it now, so it's pure dead schema.
--   * couple_budget  — replaced by budget_items + wedding_config.
--                      Was a chat-context summary table; the chat
--                      service now reads budget_items directly.
--   * notifications  — replaced by admin_notifications (migration 011
--                      created the canonical table). The
--                      coordinator notifications page was reading
--                      from this stale table until the
--                      2026-04-28 audit fix; once that flipped, it
--                      had no remaining readers.
--
-- Seed files still INSERTed into these tables; those inserts are
-- removed in the same commit. CASCADE so any leftover RLS policies,
-- indexes, or triggers go with the table.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS public.budget CASCADE;
DROP TABLE IF EXISTS public.couple_budget CASCADE;
DROP TABLE IF EXISTS public.notifications CASCADE;

NOTIFY pgrst, 'reload schema';
