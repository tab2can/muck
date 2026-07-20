-- =============================================================================
-- Muck · Supabase Realtime — TÜM uygulama tabloları
-- SQL Editor → Run (bir kez). Sonuç listesinde tablolar görünmeli.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles',
    'user_social',
    'friend_requests',
    'friendships',
    'servers',
    'server_members',
    'channels',
    'roles',
    'role_permissions',
    'member_roles',
    'messages',
    'channel_pins',
    'dm_channels',
    'dm_members',
    'dm_messages',
    'dm_pins'
  ]
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'realtime + %', t;
    exception
      when duplicate_object then raise notice 'realtime = % (zaten var)', t;
      when undefined_table then raise notice 'realtime skip % (yok)', t;
    end;
  end loop;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles',
    'user_social',
    'friend_requests',
    'friendships',
    'servers',
    'server_members',
    'channels',
    'messages',
    'channel_pins',
    'dm_channels',
    'dm_members',
    'dm_messages',
    'dm_pins'
  ]
  loop
    begin
      execute format('alter table public.%I replica identity full', t);
    exception
      when undefined_table then null;
    end;
  end loop;
end $$;

select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
