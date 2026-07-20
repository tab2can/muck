-- Supabase Realtime: profil / arkadaşlık / sosyal / sunucu üyelik değişiklikleri
-- Dashboard → Database → Publications → supabase_realtime içinde bu tablolar açık olmalı.
-- Bu migration publication'a ekler (zaten varsa hata yutulur).

do $$
begin
  begin
    alter publication supabase_realtime add table public.profiles;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.friendships;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.user_social;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.server_members;
  exception when duplicate_object then null;
  end;
end $$;
