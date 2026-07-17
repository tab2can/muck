-- Muck — Supabase initial schema
-- Dashboard → SQL Editor'da çalıştırın.
-- Auth: Email provider + Confirm email açık olmalı.
-- Site URL: https://muck.tr
-- Redirect URLs: https://muck.tr/login , http://localhost:3000/login

create extension if not exists "pgcrypto";

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  username_lower text generated always as (lower(username)) stored,
  display_name text,
  email text,
  birth_date date not null,
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  constraint profiles_username_len check (char_length(username) between 3 and 20),
  constraint profiles_username_format check (username ~ '^[a-zA-Z0-9_]+$')
);

create unique index if not exists profiles_username_lower_idx on public.profiles (username_lower);
create index if not exists profiles_email_idx on public.profiles (email);

-- ---------- social prefs ----------
create table if not exists public.user_social (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  pinned_dms jsonb not null default '[]'::jsonb,
  closed_dms jsonb not null default '[]'::jsonb,
  muted_dms jsonb not null default '{}'::jsonb,
  unread_dms jsonb not null default '{}'::jsonb,
  ignored jsonb not null default '[]'::jsonb,
  blocked jsonb not null default '[]'::jsonb,
  friend_since jsonb not null default '{}'::jsonb,
  notes jsonb not null default '{}'::jsonb,
  pinned_groups jsonb not null default '[]'::jsonb,
  closed_groups jsonb not null default '[]'::jsonb,
  muted_groups jsonb not null default '{}'::jsonb,
  unread_groups jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- friends ----------
create table if not exists public.friend_requests (
  id text primary key,
  from_id uuid not null references public.profiles(id) on delete cascade,
  to_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint friend_requests_not_self check (from_id <> to_id)
);

create index if not exists friend_requests_to_idx on public.friend_requests (to_id);
create index if not exists friend_requests_from_idx on public.friend_requests (from_id);

create table if not exists public.friendships (
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint friendships_ordered check (user_a < user_b)
);

-- ---------- servers / channels ----------
create table if not exists public.servers (
  id text primary key,
  name text not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  invite_code text not null unique,
  created_at timestamptz not null default now(),
  constraint servers_name_len check (char_length(name) between 2 and 32)
);

create table if not exists public.server_members (
  server_id text not null references public.servers(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (server_id, user_id)
);

create index if not exists server_members_user_idx on public.server_members (user_id);

create table if not exists public.channels (
  id text primary key,
  server_id text not null references public.servers(id) on delete cascade,
  name text not null,
  type text not null check (type in ('text', 'voice')),
  created_at timestamptz not null default now(),
  constraint channels_name_len check (char_length(name) between 1 and 32)
);

create index if not exists channels_server_idx on public.channels (server_id);

-- ---------- roles skeleton (future) ----------
create table if not exists public.roles (
  id text primary key,
  server_id text not null references public.servers(id) on delete cascade,
  name text not null,
  position int not null default 0,
  color text,
  created_at timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_id text not null references public.roles(id) on delete cascade,
  permission text not null,
  allowed boolean not null default true,
  primary key (role_id, permission)
);

create table if not exists public.member_roles (
  server_id text not null references public.servers(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id text not null references public.roles(id) on delete cascade,
  primary key (server_id, user_id, role_id)
);

-- ---------- channel messages ----------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null references public.channels(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  media_urls text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint messages_content_len check (char_length(content) between 1 and 2000)
);

create index if not exists messages_channel_created_idx on public.messages (channel_id, created_at desc);

-- ---------- DMs ----------
create table if not exists public.dm_channels (
  id text primary key,
  type text not null check (type in ('dm', 'group')),
  name text,
  owner_id uuid references public.profiles(id) on delete set null,
  last_message_at timestamptz,
  last_from_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.dm_members (
  channel_id text not null references public.dm_channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (channel_id, user_id)
);

create index if not exists dm_members_user_idx on public.dm_members (user_id);

create table if not exists public.dm_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null references public.dm_channels(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  reactions jsonb not null default '{}'::jsonb,
  reply_to jsonb,
  media_urls text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint dm_messages_content_len check (char_length(content) between 1 and 2000)
);

create index if not exists dm_messages_channel_created_idx on public.dm_messages (channel_id, created_at desc);

create table if not exists public.dm_pins (
  channel_id text not null references public.dm_channels(id) on delete cascade,
  message_id uuid not null references public.dm_messages(id) on delete cascade,
  from_id uuid,
  text text,
  ts timestamptz,
  pinned_by uuid not null references public.profiles(id) on delete cascade,
  pinned_at timestamptz not null default now(),
  primary key (channel_id, message_id)
);

-- ---------- signup → profile trigger ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uname text;
  dname text;
  bdate date;
  mopt boolean;
begin
  uname := nullif(trim(coalesce(new.raw_user_meta_data->>'username', '')), '');
  dname := nullif(trim(coalesce(new.raw_user_meta_data->>'display_name', '')), '');
  bdate := nullif(new.raw_user_meta_data->>'birth_date', '')::date;
  mopt := coalesce((new.raw_user_meta_data->>'marketing_opt_in')::boolean, false);

  if uname is null or bdate is null then
    raise exception 'username and birth_date required in user metadata';
  end if;

  insert into public.profiles (id, username, display_name, email, birth_date, marketing_opt_in)
  values (new.id, uname, dname, new.email, bdate, mopt);

  insert into public.user_social (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- RLS (secret key bypasses; policies for future client access) ----------
alter table public.profiles enable row level security;
alter table public.user_social enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.servers enable row level security;
alter table public.server_members enable row level security;
alter table public.channels enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.member_roles enable row level security;
alter table public.messages enable row level security;
alter table public.dm_channels enable row level security;
alter table public.dm_members enable row level security;
alter table public.dm_messages enable row level security;
alter table public.dm_pins enable row level security;

create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (auth.uid() = id);

create policy "social_own" on public.user_social
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
