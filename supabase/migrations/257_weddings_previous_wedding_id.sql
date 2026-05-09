-- ---------------------------------------------------------------------------
-- 257_weddings_previous_wedding_id.sql
-- ---------------------------------------------------------------------------
-- Identity-capture redesign — Wave 2C: same-person multi-wedding rule.
--
-- Why this exists
-- ---------------
-- The IDENTITY-TRUTH-AUDIT (2026-05-09, Q-C) flagged the Naina-case bug:
-- one human, same email, two RM-codes — RM-0200 (Inquiry) and RM-0204
-- (lost). The resolver missed the link because the WeddingPro close-out
-- on the first wedding arrived on a different from_email shape than the
-- original Knot inquiry, and step 1-3 of the match chain therefore
-- missed. The system minted a fresh wedding for what is, legitimately,
-- a re-engagement after loss.
--
-- The Wave 2C resolver patch closes that gap by attaching to the
-- existing wedding when the matched person has a non-terminal wedding
-- on file. When the person's only wedding is terminal (lost / cancelled
-- / completed), a new arrival CAN mint a fresh wedding (legitimate
-- re-engagement), but the new wedding is linked back to the previous
-- via this column so the coordinator surface can show the history
-- ("RM-0204 is a re-engagement of RM-0200 lost 6 months ago").
--
-- Constitution alignment
-- ----------------------
-- bloom-constitution.md / Point-Zero doctrine: every feature is a view
-- over a single forensic record. Re-engagement after loss is one of the
-- most operationally meaningful states in a venue's funnel — it answers
-- "did our nurture campaign work" — and today that linkage is invisible.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- DROP-then-CREATE on no triggers (none here). Safe to re-run.
--
-- Pre-allocates migration slot 257. Latest is 256.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — weddings.previous_wedding_id
-- ============================================================================
-- Self-FK on weddings.id with ON DELETE SET NULL so a hard-delete on the
-- previous wedding (rare; Constitution prefers tombstones) does not
-- cascade into the re-engagement record. NULL = no previous wedding (the
-- common case). Set by the resolver in Wave 2C when a fresh inquiry
-- mints a new wedding for a person whose only existing wedding is
-- terminal (lost / cancelled / completed).

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS previous_wedding_id uuid
    REFERENCES public.weddings(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.weddings.previous_wedding_id IS
  'Self-FK linking a re-engagement-after-loss wedding back to the previous '
  'wedding for the same person. NULL when no prior wedding exists. Set by '
  'the identity resolver (lib/services/identity/resolver.ts) when a fresh '
  'inquiry from a person whose existing wedding is terminal '
  '(lost / cancelled / completed) mints a new wedding instead of attaching '
  'to the dead one. Lets the coordinator surface render history '
  '("RM-0204 is a re-engagement of RM-0200, lost 2025-11-04"). '
  'Migration 257 (Wave 2C 2026-05-09).';

-- Index — used by the coordinator-side history view ("show me every
-- re-engagement of this lost wedding") and by intel rollups ("how many
-- re-engagements did our Q3 nurture campaign produce"). Partial index
-- because the vast majority of weddings have NULL here.
CREATE INDEX IF NOT EXISTS idx_weddings_previous_wedding
  ON public.weddings (previous_wedding_id)
  WHERE previous_wedding_id IS NOT NULL;

COMMENT ON INDEX public.idx_weddings_previous_wedding IS
  'Partial index supporting "show me re-engagements of this lost wedding" '
  'queries on the coordinator surface. Migration 257.';

COMMIT;

NOTIFY pgrst, 'reload schema';
