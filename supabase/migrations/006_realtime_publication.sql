-- =============================================================================
-- Muck · Supabase Realtime aktivasyonu
-- SQL Editor'da bir kez çalıştır (Dashboard → SQL → New query → Run)
-- =============================================================================
-- Ne yapar:
--   1) supabase_realtime publication'ına gerekli tabloları ekler
--   2) UPDATE/DELETE için REPLICA IDENTITY FULL (eski satır da gelir)
-- =============================================================================

-- Publication yoksa oluştur (nadiren gerekir)
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- Tabloları Realtime'a ekle
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles',
    'friendships',
    'friend_requests',
    'user_social',
    'server_members',
    'servers',
    'dm_channels',
    'dm_members',
    'dm_messages',
    'messages'
  ]
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'realtime: % eklendi', t;
    exception
      when duplicate_object then
        raise notice 'realtime: % zaten ekli', t;
      when undefined_table then
        raise notice 'realtime: % tablosu yok — atlandı', t;
    end;
  end loop;
end $$;

-- UPDATE/DELETE payload'larında old kaydı için
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles',
    'friendships',
    'friend_requests',
    'user_social',
    'server_members',
    'servers',
    'dm_channels',
    'dm_members',
    'dm_messages',
    'messages'
  ]
  loop
    begin
      execute format('alter table public.%I replica identity full', t);
    exception
      when undefined_table then null;
    end;
  end loop;
end $$;

-- Doğrulama: bu sorgu Realtime'a açık tabloları listeler
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
