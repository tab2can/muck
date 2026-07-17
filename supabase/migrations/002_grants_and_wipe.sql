-- Tablolara API rolleri için yetki (yoksa PostgREST: permission denied)
-- + temiz başlangıç wipe fonksiyonu
-- Dashboard → SQL Editor'da bir kez çalıştırın.

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

-- Temiz wipe (sunucu secret key ile rpc('wipe_muck_data') çağırır)
create or replace function public.wipe_muck_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  auth_deleted int := 0;
begin
  truncate table
    public.dm_pins,
    public.dm_messages,
    public.dm_members,
    public.dm_channels,
    public.messages,
    public.member_roles,
    public.role_permissions,
    public.roles,
    public.channels,
    public.server_members,
    public.servers,
    public.friendships,
    public.friend_requests,
    public.user_social,
    public.profiles
  restart identity cascade;

  delete from auth.users;
  get diagnostics auth_deleted = row_count;

  return jsonb_build_object('ok', true, 'auth_users_deleted', auth_deleted);
end;
$$;

revoke all on function public.wipe_muck_data() from public;
grant execute on function public.wipe_muck_data() to service_role;
