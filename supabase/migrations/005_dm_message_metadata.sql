-- Structured DM messages (server invite cards, future system cards)
alter table public.dm_messages
  add column if not exists metadata jsonb;

