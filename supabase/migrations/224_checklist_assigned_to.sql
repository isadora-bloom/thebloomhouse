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
