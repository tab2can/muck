-- Channel message parity with DMs: reactions, reply_to, pins, search indexes
-- Dashboard → SQL Editor'da bir kez çalıştırın.

alter table public.messages
  add column if not exists reactions jsonb not null default '{}'::jsonb;

alter table public.messages
  add column if not exists reply_to jsonb;

create table if not exists public.channel_pins (
  channel_id text not null references public.channels(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  from_id uuid references public.profiles(id) on delete set null,
  text text,
  ts timestamptz,
  pinned_by uuid not null references public.profiles(id) on delete cascade,
  pinned_at timestamptz not null default now(),
  primary key (channel_id, message_id)
);

alter table public.channel_pins enable row level security;

grant all on table public.channel_pins to anon, authenticated, service_role;

create extension if not exists pg_trgm;

create index if not exists messages_content_trgm_idx
  on public.messages using gin (content gin_trgm_ops);

create index if not exists dm_messages_content_trgm_idx
  on public.dm_messages using gin (content gin_trgm_ops);

-- wipe fonksiyonunu channel_pins ile güncelle (varsa)
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
    public.channel_pins,
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
