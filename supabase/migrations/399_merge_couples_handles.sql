-- 399: a merge carries the handles, and a handle disagreement is recorded
--
-- Wave 3 (NOVEMBER-PLAN.md W22, HANDLE-IDENTITY-SPEC.md §1 + §3). Migration
-- 398 put `handles` and `first_seen_at` on couples. merge_couples (migration
-- 379) predates both, so a merge silently dropped the loser's handles and
-- kept whatever first_seen_at the winner happened to have. That loses exactly
-- the thing wave 3 exists to keep: a couple who followed on Instagram in
-- March and enquired by email in June can end up as two rows that later
-- merge, and the March handle is the only link back to the follow.
--
-- Three changes:
--
--   1. The survivor's handles become the UNION of both maps. The winner wins
--      a per-platform disagreement, and the disagreement is written into the
--      audit row's reason rather than dropped. A handle collision is a typo,
--      a re-used username, or two people being treated as one, and all three
--      want a human to see them.
--   2. first_seen_at becomes the earlier of the two. It is the first time
--      the venue saw this couple at all, and a merge cannot make that later.
--   3. A new couple_merge_events type, 'handle_contradiction', for the
--      linker's own stamp path: when a signal carries a handle the couple
--      already holds differently, the stored value stays and a row lands
--      here. The full CHECK list is carried forward (see the drift warning
--      in 379, a partial list rejects existing rows).
--
-- Schema-qualified on purpose: scripts/run-migration.ts drives public.exec_sql
-- with search_path = pg_catalog, public. Idempotent.

ALTER TABLE public.couple_merge_events
  DROP CONSTRAINT IF EXISTS couple_merge_events_event_type_check;
ALTER TABLE public.couple_merge_events
  ADD CONSTRAINT couple_merge_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'fragment_promoted','channel_scoped_bridged','candidate_confirmed',
    'candidate_rejected','manual_merge','manual_unmerge','resurrection',
    'resurrection_rejected','couple_minted','reattach',
    'partner_reconciliation','handle_contradiction'
  ]));

CREATE OR REPLACE FUNCTION public.merge_couples(
  p_winner uuid,
  p_loser uuid,
  p_reason text,
  p_rule text DEFAULT 'partner_reconciliation'
) RETURNS boolean LANGUAGE plpgsql AS $$
declare
  r record;
  v_venue uuid;
  v_winner_handles jsonb;
  v_loser_handles jsonb;
  v_merged_handles jsonb;
  v_conflicts text := '';
  v_key text;
  v_reason text;
begin
  if p_winner is null or p_loser is null or p_winner = p_loser then
    return false;
  end if;

  -- Winner must exist; capture venue for the audit + isolation guard.
  select venue_id into v_venue from public.couples
    where id = p_winner and merged_into_id is null;
  if v_venue is null then
    return false;
  end if;

  -- Loser must exist, same venue, and not already merged (idempotent).
  perform 1 from public.couples
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
  update public.candidate_matches set primary_record_id = p_winner
    where primary_record_id = p_loser and primary_record_type = 'couple';
  update public.candidate_matches set secondary_record_id = p_winner
    where secondary_record_id = p_loser and secondary_record_type = 'couple';

  -- Handle union. Loser-only platforms are added; a platform both hold with
  -- DIFFERENT values keeps the winner's and is named in the audit reason.
  select coalesce(handles, '{}'::jsonb) into v_winner_handles
    from public.couples where id = p_winner;
  select coalesce(handles, '{}'::jsonb) into v_loser_handles
    from public.couples where id = p_loser;

  for v_key in select jsonb_object_keys(v_loser_handles) loop
    -- jsonb_exists() rather than the `?` operator: this body travels to the
    -- server as a bound string through public.exec_sql, and a bare `?` is a
    -- placeholder to more than one client library. Same semantics, no ambiguity.
    if jsonb_exists(v_winner_handles, v_key)
       and v_winner_handles ->> v_key is distinct from v_loser_handles ->> v_key then
      v_conflicts := v_conflicts
        || case when v_conflicts = '' then '' else '; ' end
        || v_key || ': kept ''' || (v_winner_handles ->> v_key)
        || ''' over ''' || (v_loser_handles ->> v_key) || '''';
    end if;
  end loop;

  -- Winner on the right so the winner's value wins every shared key.
  v_merged_handles := v_loser_handles || v_winner_handles;

  -- Partner backfill: the loser's primary contact becomes the winner's
  -- partner when the winner has no partner yet (the GC-5 shape). Handles
  -- union and first_seen_at goes to the earlier of the two.
  update public.couples w set
    partner_contact_name  = coalesce(w.partner_contact_name,  l.primary_contact_name),
    partner_contact_email = coalesce(w.partner_contact_email, l.primary_contact_email),
    partner_contact_phone = coalesce(w.partner_contact_phone, l.primary_contact_phone),
    handles = v_merged_handles,
    first_seen_at = least(w.first_seen_at, l.first_seen_at),
    updated_at = now()
  from public.couples l
  where w.id = p_winner and l.id = p_loser;

  -- Tombstone the loser (demotion, not deletion).
  update public.couples set merged_into_id = p_winner, updated_at = now()
    where id = p_loser;

  v_reason := coalesce(p_reason, '');
  if v_conflicts <> '' then
    v_reason := v_reason || ' | handle contradiction on merge, ' || v_conflicts;
  end if;

  -- Audit.
  insert into public.couple_merge_events(
    venue_id, event_type, primary_couple_id, secondary_couple_id,
    rule_triggered, confidence_tier, reason, occurred_at
  ) values (
    v_venue, 'partner_reconciliation', p_winner, p_loser, p_rule, 'high', v_reason, now()
  );

  return true;
end $$;

COMMENT ON FUNCTION public.merge_couples(uuid, uuid, text, text) IS
  'Merge loser couple INTO winner: dynamic couple_id reassignment + candidate_matches repoint + partner backfill + handles union (winner wins a per-platform conflict, conflict named in the audit reason) + earliest first_seen_at + merged_into_id tombstone + couple_merge_events audit. Atomic, idempotent. Anchors: GC-5 partner reconciliation (mig 379), HANDLE-IDENTITY-SPEC.md (mig 398/399).';
