/**
 * Realtime aboneliğini smoke-test eder.
 * Kullanım: node scripts/check-realtime.mjs
 * Önce SQL Editor'da 006_realtime_publication.sql çalışmış olmalı.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY eksik (.env)');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { params: { eventsPerSecond: 10 } },
});

supabase.realtime.setAuth(key);

console.log('Realtime’a bağlanıyor…', url);

const channel = supabase
  .channel('muck-realtime-check')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
    console.log('✓ profiles event:', payload.eventType, payload.new?.id || payload.old?.id);
  })
  .subscribe((status, err) => {
    console.log('status:', status, err?.message || '');
    if (status === 'SUBSCRIBED') {
      console.log('OK — Realtime çalışıyor. 8 sn sonra çıkılıyor.');
      setTimeout(() => {
        supabase.removeChannel(channel);
        process.exit(0);
      }, 8000);
    }
    if (status === 'CHANNEL_ERROR') {
      console.error('HATA — Tablolar publication’da mı? 006_realtime_publication.sql çalıştır.');
      process.exit(1);
    }
  });
