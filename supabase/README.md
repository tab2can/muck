# Supabase setup

1. SQL Editor’da sırayla çalıştır:
   - `migrations/001_init.sql`
   - `migrations/002_grants_and_wipe.sql` (GRANT + wipe RPC)
2. Auth → Providers → Email: Confirm email açık
3. Auth → URL Configuration:
   - Site URL: `https://muck.tr`
   - Redirect: `https://muck.tr/login`, `http://localhost:3000/login`
4. API Keys: Publishable + Secret → sunucu `.env`

## Temiz başlangıç

SQL Editor (anında):

```sql
select public.wipe_muck_data();
```

veya sunucuda (önce 002 migration şart):

```bash
cd /home/muck && node deploy/wipe-fresh.js && pm2 restart muck --update-env
```
