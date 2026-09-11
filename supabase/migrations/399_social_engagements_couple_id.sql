-- 399: social engagements point at a couple on the spine, not a person
--
-- Wave 3, W23 (NOVEMBER-PLAN.md, HANDLE-IDENTITY-SPEC.md §4 and §5).
--
-- Migration 324 gave social_engagements a matched_person_id and three
-- matchers to fill it: handle_exact against people.platform_handles,
-- trigram name similarity at 0.5, and "the email local part contains the
-- handle" at confidence 50. The last two bound strangers to real
-- couples, and none of the three ever reached couples / touchpoints /
-- fragments, so a follow three weeks before the inquiry was invisible to
-- the journey ribbon.
--
-- Social captures now route through linkSignal like every other origin.
-- The outcome the coordinator sees is a couple on the spine, so the row
-- needs somewhere to record it. matched_person_id is kept, not dropped:
-- existing rows carry history we do not want to erase, and the doctrine
-- for retiring a column is to mark it deprecated and stop writing it.
--
-- Schema-qualified because scripts/run-migration.ts drives
-- public.exec_sql with search_path = pg_catalog, public. Idempotent, no
-- BEGIN/COMMIT (the exec_sql RPC rejects transaction blocks).

ALTER TABLE public.social_engagements
  ADD COLUMN IF NOT EXISTS couple_id uuid REFERENCES public.couples(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.social_engagements.couple_id IS
  'couples.id the spine bound this engagement to, written from the linkSignal result. NULL means the signal is a fragment awaiting identity or a candidate in review, which is an honest not-yet, not a failure. ON DELETE SET NULL so couple cleanup never destroys the engagement history. Migration 399.';

COMMENT ON COLUMN public.social_engagements.matched_person_id IS
  'DEPRECATED 2026-09-09 (wave 3, W23). Legacy people.id from the retired social matcher. No longer written; read only for pre-wave-3 rows. couple_id is the live binding.';

COMMENT ON COLUMN public.social_engagements.match_method IS
  'How the spine resolved the row. Values since wave 3: spine_attached, spine_minted, spine_candidate, spine_fragment, spine_duplicate, spine_cold_start. Pre-wave-3 rows still carry handle_exact / name_fuzzy / email_inferred / name_lastname from the retired matcher; name_fuzzy and email_inferred were guesses and should not be trusted as bindings.';

COMMENT ON COLUMN public.social_engagements.match_status IS
  'pending = not yet through the linker; matched = the spine gave it a couple (couple_id is set); unmatched = fragment or candidate, no couple yet. A candidate in review is NOT matched.';

-- Hot path: the couple page and the journey ribbon ask "which social
-- engagements belong to this couple", venue-scoped.
CREATE INDEX IF NOT EXISTS idx_social_engagements_couple
  ON public.social_engagements (venue_id, couple_id)
  WHERE couple_id IS NOT NULL;

COMMENT ON INDEX public.idx_social_engagements_couple IS
  'Partial on purpose: the long tail of unbound follower rows is most of the table and none of it is ever fetched by couple.';
