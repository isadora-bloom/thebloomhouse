-- D-1 / Gate G3 — "Is anyone actually live on bloom-house?"
-- The entire safety of the Phase-2 wipe rests on the answer being NO.
-- READ-ONLY. Paste into the Supabase SQL editor for the bloom-house project,
-- run, and record the result in BLOOM-MASTER-PLAN.md §0.2 before any wipe.
--
-- INTERPRETATION:
--   active_30d = 0 AND sessions_30d = 0 AND only system/cron tables show writes
--     -> nobody live; safe to wipe (full freedom).
--   any human/portal-facing table with recent writes, or recent logins
--     -> STOP, tell the Eng Lead; the plan changes.

-- 1) Human auth logins (Supabase-managed; always present) --------- DEFINITIVE
select
  count(*)                                                            as total_users,
  count(*) filter (where last_sign_in_at > now() - interval '30 days') as active_30d,
  count(*) filter (where last_sign_in_at > now() - interval '7 days')  as active_7d,
  max(last_sign_in_at)                                                as most_recent_login
from auth.users;

-- 2) Active auth sessions in the last 30 days -------------------------------
select count(*) as sessions_30d, max(updated_at) as most_recent_session
from auth.sessions
where updated_at > now() - interval '30 days';

-- 3) App-write corroboration — dynamic, skips missing tables by construction.
--    Iterates ONLY existing public base tables that have a timestamp column,
--    so it can never error on a table that doesn't exist. Output appears in
--    the editor's Messages/Notices pane (not the results grid).
do $$
declare r record; cnt bigint; ts timestamptz; q text;
begin
  for r in
    select distinct on (c.table_name) c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.column_name in ('updated_at','created_at','timestamp')
    order by c.table_name,
      case c.column_name when 'updated_at' then 1 when 'created_at' then 2 else 3 end
  loop
    q := format('select count(*), max(%I) from public.%I where %I > now() - interval ''30 days''',
                r.column_name, r.table_name, r.column_name);
    execute q into cnt, ts;
    if cnt > 0 then
      raise notice 'WRITE 30d: % (%) — % rows, latest %', r.table_name, r.column_name, cnt, ts;
    end if;
  end loop;
  raise notice 'scan done — any table not listed had ZERO writes in the last 30 days.';
end $$;
