-- Mesaj düzenleme desteği (kanal + DM)
-- Dashboard → SQL Editor'da bir kez çalıştırın.

alter table public.messages
  add column if not exists edited_at timestamptz;

alter table public.dm_messages
  add column if not exists edited_at timestamptz;
