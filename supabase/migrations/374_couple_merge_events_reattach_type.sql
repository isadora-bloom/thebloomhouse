-- ---------------------------------------------------------------------------
-- 374_couple_merge_events_reattach_type.sql
-- ---------------------------------------------------------------------------
-- Orphan-touchpoint diagnosis fix #3 of 3 (2026-05-26).
--
-- Adds 'reattach' to the couple_merge_events.event_type CHECK so the
-- reattach-couple-author-orphans sweep can write an audit row for every
-- historical orphan touchpoint it binds back to its rightful couple.
--
-- Why a new event_type
-- -------------------
-- The existing event_type values describe different lifecycle events:
--
--   - fragment_promoted        — an identity-poor fragment matured into a couple
--   - channel_scoped_bridged   — two channel-scoped half-couples merged
--   - candidate_confirmed/_rejected — operator decided a queued candidate_match
--   - manual_merge/_unmerge    — operator-driven cross-couple operation
--   - resurrection/_rejected   — a Ghost re-engaged
--   - couple_minted            — RPC mint (mig 366)
--
-- A 'reattach' is none of those: the touchpoint was historically dropped
-- on the floor by a now-fixed binder gap (author-classified as 'couple'
-- but never linked to a wedding/couple). The reattach sweep walks the
-- cascade matcher and binds the orphan to the right couple after the
-- fact. No couple is created or merged; no operator decision is recorded
-- — just a deterministic post-hoc binding. That deserves its own audit
-- shape so the operator can distinguish "live cascade fired and matched"
-- from "historical orphan reclaimed by reattach sweep" when reading the
-- audit log.
--
-- The fix
-- -------
-- Drop the existing named CHECK from mig 366 and recreate with
-- 'reattach' appended. The constraint is named
-- (couple_merge_events_event_type_check) so we can reference it
-- directly — no anonymous-constraint lookup needed.
--
-- Idempotent: DROP ... IF EXISTS plus ADD CONSTRAINT.
-- ---------------------------------------------------------------------------

ALTER TABLE public.couple_merge_events
  DROP CONSTRAINT IF EXISTS couple_merge_events_event_type_check;

ALTER TABLE public.couple_merge_events
  ADD CONSTRAINT couple_merge_events_event_type_check
  CHECK (event_type IN (
    'fragment_promoted',
    'channel_scoped_bridged',
    'candidate_confirmed',
    'candidate_rejected',
    'manual_merge',
    'manual_unmerge',
    'resurrection',
    'resurrection_rejected',
    'couple_minted',
    'reattach'
  ));

COMMENT ON TABLE public.couple_merge_events IS
  'Audit log for every identity event: couple mint (chokepoint RPC), '
  'fragment promotion, candidate confirm/reject, manual merge/unmerge, '
  'ghost resurrection, post-hoc reattach of orphan touchpoints. The '
  'reason column feeds the calibration loop (§2 Don''t skip #2). See '
  'IDENTITY-FIRST-ARCHITECTURE.md §9.';
