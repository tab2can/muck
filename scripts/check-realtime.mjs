/**
 * Realtime aboneliğini smoke-test eder (profiles + dm_messages + messages).
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
  realtime: { params: { eventsPerSecond: 20 } },
});

supabase.realtime.setAuth(key);

console.log('Realtime’a bağlanıyor…', url);

const channel = supabase
  .channel('muck-realtime-check')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
    console.log('✓ profiles event');
  })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_messages' }, () => {
    console.log('✓ dm_messages event');
  })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
    console.log('✓ messages event');
  })
  .subscribe((status, err) => {
    console.log('status:', status, err?.message || '');
    if (status === 'SUBSCRIBED') {
      console.log('OK — Realtime kanalı açık (profiles, dm_messages, messages).');
      console.log('Bir mesaj gönderirsen yukarıda event görürsün. 10 sn sonra çıkılıyor.');
      setTimeout(() => {
        supabase.removeChannel(channel);
        process.exit(0);
      }, 10000);
    }
    if (status === 'CHANNEL_ERROR') {
      console.error('HATA — 006_realtime_publication.sql çalıştır.');
      process.exit(1);
    }
  });
