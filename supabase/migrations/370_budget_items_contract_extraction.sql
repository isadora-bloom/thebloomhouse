-- ============================================================================
-- 370: BUDGET_ITEMS (source_contract_id + auto_extracted + extraction_confirmed_at)
--
-- R1#5 feedback (2026-03-29). When a couple uploads a vendor contract,
-- the analyze pipeline now extracts payment dates + amounts and writes
-- draft budget lines so the couple isn't manually re-typing what the
-- contract already says.
--
-- Three columns are added:
--   - source_contract_id  — FK back to the contract this row was lifted
--                           from. NULL means the row was hand-entered.
--   - auto_extracted      — quick boolean filter so the Budget page can
--                           badge / group auto-extracted items.
--   - extraction_confirmed_at — set when the couple reviews the
--                           auto-extracted row and approves it. Until
--                           then the row renders as a "review pending"
--                           draft. Hand-entered rows have this null too
--                           but render as confirmed since they never
--                           went through the draft state.
--
-- A pending row is still a real budget_items row (so it shows up in
-- totals if the couple wants), but it carries a visual draft state in
-- the UI. Couples can approve (sets extraction_confirmed_at), edit, or
-- delete.
--
-- ON DELETE SET NULL on the FK so deleting a contract doesn't nuke the
-- budget history. The auto_extracted flag remains so the UI can still
-- distinguish "this used to be from a contract" from "I typed this".
-- ============================================================================

ALTER TABLE public.budget_items
  ADD COLUMN IF NOT EXISTS source_contract_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auto_extracted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS extraction_confirmed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_budget_items_source_contract
  ON public.budget_items(source_contract_id)
  WHERE source_contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_budget_items_unconfirmed_extraction
  ON public.budget_items(wedding_id)
  WHERE auto_extracted = true AND extraction_confirmed_at IS NULL;

COMMENT ON COLUMN public.budget_items.source_contract_id IS
  'When non-null, this budget item was auto-extracted by the contract analysis pipeline from the referenced contract. ON DELETE SET NULL preserves history if the contract is later removed.';
COMMENT ON COLUMN public.budget_items.auto_extracted IS
  'True when the row was created by the contract extraction pipeline rather than typed by a couple. The UI uses this to badge the row and gate the approve action.';
COMMENT ON COLUMN public.budget_items.extraction_confirmed_at IS
  'Timestamp when the couple approved an auto_extracted row. Null = still in draft. Hand-entered rows leave this null too — the UI treats null + auto_extracted=false as "always confirmed".';

NOTIFY pgrst, 'reload schema';
