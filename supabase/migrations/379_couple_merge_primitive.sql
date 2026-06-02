-- 379 — Spine couple-merge primitive + partner-reconciliation support.
--
-- Closes the GC-5 partner-reconciliation gap: when one couple's partner
-- identity matches another couple's primary (e.g. a HoneyBook contract names
-- "Will Carter" who already exists as a couple from his own Calendly tour),
-- the two must merge into one couple.
--
-- Design (deliberately NOT the mergeWeddings hand-list anti-pattern):
--   * merged_into_id tombstone column → a merged couple is DEMOTED, not
--     deleted (reversible; doctrine "death is demotion not deletion").
--   * merge_couples() reassigns every couple_id-bearing table DYNAMICALLY
--     (information_schema loop) so a new couple_id table can never silently
--     drift out of the merge. Atomic: any conflict rolls the whole merge
--     back — never a half-merge.
--   * Idempotent: re-merging an already-merged loser is a no-op.
--   * Audited via couple_merge_events (new 'partner_reconciliation' type).
--
-- Anchor: BLOOM-CONSOLIDATION-GAP-REGISTER.md (GC-5), tests/golden/cases.json GC-5.

alter table couples
  add column if not exists merged_into_id uuid references couples(id) on delete set null;

create index if not exists idx_couples_merged_into
  on couples(merged_into_id) where merged_into_id is not null;

comment on column couples.merged_into_id is
  'When set, this couple was merged INTO the referenced couple (demotion, not deletion). Readers should follow the pointer / exclude merged couples. Reversible via unmerge.';

-- Allow the partner-reconciliation merge event_type.
--
-- DRIFT WARNING (2026-06-02 fix): this CHECK must carry forward EVERY
-- value the prior migration (374) allowed, not just the merge-family ones
-- — dropping + recreating with a partial list rejects existing rows.
-- The v1 of this block omitted 'couple_minted' (written on EVERY mint by
-- the lock_and_mint chokepoint, mig 366) and 'reattach' (orphan-reattach,
-- mig 374), so applying it against any populated table failed with
-- "check constraint ... violated by some row". The full set below is
-- 374's ten values + 'partner_reconciliation'. If a future migration adds
-- an event_type, this list (the latest definition) is the source of truth.
alter table couple_merge_events drop constraint if exists couple_merge_events_event_type_check;
alter table couple_merge_events add constraint couple_merge_events_event_type_check
  check (event_type = any (array[
    'fragment_promoted','channel_scoped_bridged','candidate_confirmed',
    'candidate_rejected','manual_merge','manual_unmerge','resurrection',
    'resurrection_rejected','couple_minted','reattach',
    'partner_reconciliation'
  ]));

-- merge_couples(winner, loser, reason, rule) → boolean (true when a merge happened).
create or replace function merge_couples(
  p_winner uuid,
  p_loser uuid,
  p_reason text,
  p_rule text default 'partner_reconciliation'
) returns boolean language plpgsql as $$
declare
  r record;
  v_venue uuid;
begin
  if p_winner is null or p_loser is null or p_winner = p_loser then
    return false;
  end if;

  -- Winner must exist; capture venue for the audit + isolation guard.
  select venue_id into v_venue from couples where id = p_winner and merged_into_id is null;
  if v_venue is null then
    return false;
  end if;

  -- Loser must exist, same venue, and not already merged (idempotent).
  perform 1 from couples
    where id = p_loser and venue_id = v_venue and merged_into_id is null;
  if not found then
    return false;
  end if;

  -- Reassign every couple_id-bearing table dynamically. No hand-list to drift.
  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'couple_id'
      and t.table_type = 'BASE TABLE'
  loop
    execute format('update public.%I set couple_id = $1 where couple_id = $2', r.table_name)
      using p_winner, p_loser;
  end loop;

  -- candidate_matches reference couples by (record_id, record_type='couple').
  update candidate_matches set primary_record_id = p_winner
    where primary_record_id = p_loser and primary_record_type = 'couple';
  update candidate_matches set secondary_record_id = p_winner
    where secondary_record_id = p_loser and secondary_record_type = 'couple';

  -- Partner backfill: the loser's primary contact becomes the winner's
  -- partner when the winner has no partner yet (the GC-5 shape).
  update couples w set
    partner_contact_name  = coalesce(w.partner_contact_name,  l.primary_contact_name),
    partner_contact_email = coalesce(w.partner_contact_email, l.primary_contact_email),
    partner_contact_phone = coalesce(w.partner_contact_phone, l.primary_contact_phone),
    updated_at = now()
  from couples l
  where w.id = p_winner and l.id = p_loser;

  -- Tombstone the loser (demotion, not deletion).
  update couples set merged_into_id = p_winner, updated_at = now() where id = p_loser;

  -- Audit.
  insert into couple_merge_events(
    venue_id, event_type, primary_couple_id, secondary_couple_id,
    rule_triggered, confidence_tier, reason, occurred_at
  ) values (
    v_venue, 'partner_reconciliation', p_winner, p_loser, p_rule, 'high', p_reason, now()
  );

  return true;
end $$;

comment on function merge_couples(uuid, uuid, text, text) is
  'Merge loser couple INTO winner: dynamic couple_id reassignment + candidate_matches repoint + partner backfill + merged_into_id tombstone + couple_merge_events audit. Atomic, idempotent. Anchor: GC-5 partner reconciliation.';
